from __future__ import annotations

import asyncio
import json
import shutil
import signal
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from hashtag_robotics.config import Settings
from hashtag_robotics.models import JobCreateRequest, JobKind, JobRecord

ProgressCallback = Callable[[float, str], Awaitable[None]]
CancelCheck = Callable[[], bool]


class PhysicalExecutionError(RuntimeError):
    pass


@dataclass(frozen=True)
class CommandPlan:
    executable: str
    arguments: tuple[str, ...]
    required_parameters: tuple[str, ...]
    description: str
    requires_actuation: bool

    def as_dict(self) -> dict[str, Any]:
        return {
            "executable": self.executable,
            "arguments": list(self.arguments),
            "required_parameters": list(self.required_parameters),
            "description": self.description,
            "requires_actuation": self.requires_actuation,
            "uses_shell": False,
        }


class LeRobotCommandBuilder:
    """Build strict argument arrays for supported LeRobot 0.6 console scripts."""

    def build(self, request: JobCreateRequest) -> CommandPlan:
        parameters = request.parameters

        if request.kind == JobKind.TRAINING:
            repo_id = self._required(parameters, "repo_id")
            policy_type = str(parameters.get("policy_type", "act"))
            output_dir = str(parameters.get("output_dir", f"outputs/train/{policy_type}"))
            job_name = str(parameters.get("job_name", f"hashtag-{policy_type}"))
            args = [
                f"--dataset.repo_id={repo_id}",
                f"--policy.type={policy_type}",
                f"--output_dir={output_dir}",
                f"--job_name={job_name}",
                f"--wandb.enable={str(bool(parameters.get('wandb', False))).lower()}",
            ]
            device = parameters.get("device")
            if device:
                args.append(f"--policy.device={device}")
            steps = parameters.get("steps")
            if steps:
                args.append(f"--steps={int(steps)}")
            return CommandPlan(
                executable="lerobot-train",
                arguments=tuple(args),
                required_parameters=("repo_id",),
                description="Train a LeRobot policy from a resolved dataset.",
                requires_actuation=False,
            )

        if request.kind == JobKind.MOTOR_SETUP:
            role = str(parameters.get("role", "robot"))
            if role == "teleoperator":
                args = self._teleoperator_arguments(parameters)
                required = ("teleop_port", "teleop_id")
            else:
                args = self._robot_arguments(parameters)
                required = ("robot_port", "robot_id")
            return CommandPlan(
                executable="lerobot-setup-motors",
                arguments=tuple(args),
                required_parameters=required,
                description=f"Set up Feetech motor IDs for the resolved {role}.",
                requires_actuation=True,
            )

        if request.kind == JobKind.CALIBRATION:
            role = str(parameters.get("role", "robot"))
            if role == "teleoperator":
                args = self._teleoperator_arguments(parameters)
                required = ("teleop_port", "teleop_id")
            else:
                args = self._robot_arguments(parameters)
                required = ("robot_port", "robot_id")
            return CommandPlan(
                executable="lerobot-calibrate",
                arguments=tuple(args),
                required_parameters=required,
                description=f"Run guided calibration for the resolved {role}.",
                requires_actuation=True,
            )

        if request.kind == JobKind.TELEOPERATION:
            args = [
                *self._robot_arguments(parameters),
                *self._teleoperator_arguments(parameters),
                "--display_data=true",
            ]
            return CommandPlan(
                executable="lerobot-teleoperate",
                arguments=tuple(args),
                required_parameters=("robot_port", "robot_id", "teleop_port", "teleop_id"),
                description="Run leader-to-follower teleoperation.",
                requires_actuation=True,
            )

        if request.kind == JobKind.RECORDING:
            args = [
                *self._robot_arguments(parameters),
                *self._teleoperator_arguments(parameters),
                f"--repo_id={self._required(parameters, 'repo_id')}",
                f"--single_task={self._required(parameters, 'task')}",
                f"--num_episodes={int(parameters.get('episodes', 1))}",
                f"--episode_time_s={int(parameters.get('episode_time_s', 30))}",
                f"--reset_time_s={int(parameters.get('reset_time_s', 15))}",
                f"--push_to_hub={str(bool(parameters.get('push_to_hub', False))).lower()}",
            ]
            return CommandPlan(
                executable="lerobot-record",
                arguments=tuple(args),
                required_parameters=(
                    "robot_port",
                    "robot_id",
                    "teleop_port",
                    "teleop_id",
                    "repo_id",
                    "task",
                ),
                description="Record a real SO-101 LeRobotDataset.",
                requires_actuation=True,
            )

        if request.kind == JobKind.REPLAY:
            args = [
                *self._robot_arguments(parameters),
                f"--repo_id={self._required(parameters, 'repo_id')}",
                f"--episode={int(parameters.get('episode', 0))}",
            ]
            return CommandPlan(
                executable="lerobot-replay",
                arguments=tuple(args),
                required_parameters=("robot_port", "robot_id", "repo_id"),
                description="Replay one recorded episode on the resolved follower.",
                requires_actuation=True,
            )

        if request.kind in {JobKind.EVALUATION, JobKind.POLICY_ROLLOUT}:
            args = [
                *self._robot_arguments(parameters),
                f"--policy.path={self._required(parameters, 'policy_path')}",
                f"--task={str(parameters.get('task', 'Evaluate the selected policy'))}",
                f"--num_episodes={int(parameters.get('episodes', 1))}",
            ]
            return CommandPlan(
                executable="lerobot-rollout",
                arguments=tuple(args),
                required_parameters=("robot_port", "robot_id", "policy_path"),
                description="Run a guarded real policy rollout.",
                requires_actuation=True,
            )

        raise PhysicalExecutionError(
            f"Job kind '{request.kind.value}' has no physical LeRobot command contract."
        )

    def _robot_arguments(self, parameters: dict[str, Any]) -> list[str]:
        args = [
            "--robot.type=so_follower",
            f"--robot.port={self._required(parameters, 'robot_port')}",
            f"--robot.id={self._required(parameters, 'robot_id')}",
        ]
        cameras = parameters.get("cameras")
        if cameras:
            args.append(f"--robot.cameras={json.dumps(cameras, separators=(',', ':'))}")
        max_relative_target = parameters.get("max_relative_target")
        if max_relative_target is not None:
            args.append(f"--robot.max_relative_target={float(max_relative_target)}")
        return args

    def _teleoperator_arguments(self, parameters: dict[str, Any]) -> list[str]:
        return [
            "--teleop.type=so_leader",
            f"--teleop.port={self._required(parameters, 'teleop_port')}",
            f"--teleop.id={self._required(parameters, 'teleop_id')}",
        ]

    def _required(self, parameters: dict[str, Any], key: str) -> str:
        value = parameters.get(key)
        if value is None or str(value).strip() == "":
            raise PhysicalExecutionError(f"Required physical parameter '{key}' is missing.")
        return str(value)


class LeRobotCliAdapter:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.builder = LeRobotCommandBuilder()

    def runtime_available(self) -> bool:
        required = {
            "lerobot-setup-motors",
            "lerobot-calibrate",
            "lerobot-teleoperate",
            "lerobot-record",
            "lerobot-replay",
            "lerobot-rollout",
        }
        return all(shutil.which(command) for command in required)

    def preview(self, request: JobCreateRequest) -> dict[str, Any]:
        plan = self.builder.build(request)
        return {
            **plan.as_dict(),
            "runtime_available": bool(shutil.which(plan.executable)),
            "physical_enabled": self.settings.enable_physical,
            "execution_allowed": bool(
                self.settings.enable_physical and shutil.which(plan.executable)
            ),
        }

    async def execute(
        self,
        job: JobRecord,
        progress: ProgressCallback,
        cancelled: CancelCheck,
    ) -> dict[str, Any]:
        request = JobCreateRequest(
            kind=job.kind,
            target_mode=job.target_mode,
            parameters=job.parameters,
            resources=job.resources,
            requested_by=job.requested_by,
        )
        plan = self.builder.build(request)
        if plan.requires_actuation and not self.settings.enable_physical:
            raise PhysicalExecutionError("Physical execution is disabled by configuration.")
        executable = shutil.which(plan.executable)
        if executable is None:
            raise PhysicalExecutionError(
                f"Required LeRobot command '{plan.executable}' is not installed."
            )

        await progress(0.02, f"Launching verified command: {plan.executable}")
        process = await asyncio.create_subprocess_exec(
            executable,
            *plan.arguments,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            start_new_session=True,
        )
        recent_output: list[str] = []
        timeout_seconds = int(job.parameters.get("timeout_seconds", 900))
        started = asyncio.get_running_loop().time()

        try:
            while process.returncode is None:
                if cancelled():
                    await self._stop_process(process)
                    raise PhysicalExecutionError("Physical command was stopped by the operator.")
                if asyncio.get_running_loop().time() - started > timeout_seconds:
                    await self._stop_process(process)
                    raise PhysicalExecutionError("Physical command exceeded its safe timeout.")

                if process.stdout is not None:
                    try:
                        line = await asyncio.wait_for(process.stdout.readline(), timeout=0.4)
                    except TimeoutError:
                        line = b""
                    if line:
                        text = line.decode(errors="replace").strip()
                        if text:
                            recent_output.append(text)
                            recent_output = recent_output[-40:]
                            await progress(0.5, self._redact(text)[:160])
                await asyncio.sleep(0.05)

            return_code = await process.wait()
            if return_code != 0:
                raise PhysicalExecutionError(f"{plan.executable} exited with code {return_code}.")
            await progress(1.0, "Physical command completed")
            return {
                "adapter": "lerobot-cli",
                "command": plan.executable,
                "return_code": return_code,
                "recent_output": [self._redact(line) for line in recent_output],
            }
        finally:
            if process.returncode is None:
                await self._stop_process(process)

    async def _stop_process(self, process: asyncio.subprocess.Process) -> None:
        if process.returncode is not None:
            return
        process.send_signal(signal.SIGINT)
        try:
            await asyncio.wait_for(process.wait(), timeout=5)
        except TimeoutError:
            process.kill()
            await process.wait()

    def _redact(self, value: str) -> str:
        lowered = value.lower()
        if any(marker in lowered for marker in ("token=", "access_code=", "password=")):
            return "[redacted sensitive output]"
        return value
