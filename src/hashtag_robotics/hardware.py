from __future__ import annotations

import asyncio
import json
import shutil
import sys
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from hashtag_robotics.config import Settings
from hashtag_robotics.models import (
    JobCreateRequest,
    JobInputKey,
    JobKind,
    JobProcess,
    JobRecord,
    TelemetryKind,
    TelemetrySample,
)
from hashtag_robotics.process import ManagedProcess
from hashtag_robotics.repository import Repository
from hashtag_robotics.telemetry import TelemetryBuffer, TelemetryParser, strip_ansi

ProgressCallback = Callable[[float, str], Awaitable[None]]
CancelCheck = Callable[[], bool]

DEFAULT_ROBOT_TYPE = "so101_follower"
DEFAULT_TELEOPERATOR_TYPE = "so101_leader"
DEFAULT_TELEOPERATOR_ID = "leader01"

RECORDING_STRATEGIES = {"episodic", "sentry", "highlight", "dagger"}

# Jobs where the calibration prompt is the operator's decision, not noise.
AUTO_CONFIRM_EXCLUDED = {JobKind.CALIBRATION, JobKind.MOTOR_SETUP}

# One arm, one prompt; a follower plus a leader is two. The cap keeps a
# misparsed line from turning into a stream of keystrokes.
MAX_AUTO_CONFIRMATIONS = 2


def resolve_command(name: str) -> str | None:
    """Resolve a console script on PATH or next to the running interpreter."""
    found = shutil.which(name)
    if found:
        return found
    candidate = Path(sys.executable).parent / name
    return str(candidate) if candidate.is_file() else None


class PhysicalExecutionError(RuntimeError):
    pass


@dataclass(frozen=True)
class CommandPlan:
    executable: str
    arguments: tuple[str, ...]
    required_parameters: tuple[str, ...]
    description: str
    requires_actuation: bool
    interactive: bool = False

    def as_dict(self) -> dict[str, Any]:
        return {
            "executable": self.executable,
            "arguments": list(self.arguments),
            "required_parameters": list(self.required_parameters),
            "description": self.description,
            "requires_actuation": self.requires_actuation,
            "interactive": self.interactive,
            "uses_shell": False,
        }


class LeRobotCommandBuilder:
    """Build strict argument arrays for supported LeRobot 0.6 console scripts."""

    def __init__(self, settings: Settings | None = None) -> None:
        # Optional so a test can build a command without a whole installation;
        # only the simulated session needs to know where to publish its frames.
        self.settings = settings

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
                f"--wandb.enable={self._flag(parameters.get('wandb', False))}",
            ]
            root = parameters.get("dataset_root")
            if root:
                args.append(f"--dataset.root={root}")
            device = parameters.get("device")
            if device:
                args.append(f"--policy.device={device}")
            steps = parameters.get("steps")
            if steps:
                args.append(f"--steps={int(steps)}")
            batch_size = parameters.get("batch_size")
            if batch_size:
                args.append(f"--batch_size={int(batch_size)}")
            return CommandPlan(
                executable="lerobot-train",
                arguments=tuple(args),
                required_parameters=("repo_id",),
                description="Train a LeRobot policy from a resolved dataset.",
                requires_actuation=False,
            )

        if request.kind == JobKind.MOTOR_SETUP:
            args, required = self._device_arguments(parameters)
            return CommandPlan(
                executable="lerobot-setup-motors",
                arguments=tuple(args),
                required_parameters=required,
                description=f"Set up Feetech motor IDs for the resolved {self._role(parameters)}.",
                requires_actuation=True,
                interactive=True,
            )

        if request.kind == JobKind.CALIBRATION:
            args, required = self._device_arguments(parameters)
            return CommandPlan(
                executable="lerobot-calibrate",
                arguments=tuple(args),
                required_parameters=required,
                description=f"Run guided calibration for the resolved {self._role(parameters)}.",
                requires_actuation=True,
                interactive=True,
            )

        if request.kind in {JobKind.SIM_TELEOPERATION, JobKind.SIM_RECORDING}:
            # Runs as its own process for the same reasons `lerobot-record` does,
            # and one more: MuJoCo's renderer has already taken this board's
            # control plane down once, and this command also opens a serial port.
            recording = request.kind == JobKind.SIM_RECORDING
            args = [
                f"--leader-port={self._required(parameters, 'teleop_port')}",
                f"--leader-id={parameters.get('teleop_id', DEFAULT_TELEOPERATOR_ID)}",
                f"--repo-id={parameters.get('repo_id', 'local/sim_session')}",
                f"--task={parameters.get('task', 'simulated demonstration')}",
                f"--episodes={int(parameters.get('episodes', 1))}",
                f"--episode-time-s={float(parameters.get('episode_time_s', 30))}",
                f"--reset-time-s={float(parameters.get('reset_time_s', 3))}",
                f"--fps={int(parameters.get('fps', 30))}",
                f"--width={int(parameters.get('width', 640))}",
                f"--height={int(parameters.get('height', 480))}",
                f"--{'no-' if recording else ''}teleop-only",
            ]
            # Which cameras the simulation renders decides whether its takes can
            # ever be trained beside real ones: a merge needs identical features,
            # so a simulated recording carrying a camera the bench does not have
            # is unusable for co-training however good the demonstrations are.
            cameras = parameters.get("cameras")
            if cameras:
                selected = cameras if isinstance(cameras, str) else ",".join(cameras)
                args.append(f"--cameras={selected}")
            # So the panel can show the simulation the leader is actually
            # driving, instead of one of its own invention.
            if self.settings is not None:
                args.append(f"--live-frame-path={self.settings.sim_live_frame_path}")
            if parameters.get("open_viewer"):
                args.append("--viewer")
            calibration = parameters.get("teleop_calibration_dir")
            if calibration:
                args.append(f"--leader-calibration-dir={calibration}")
            root = parameters.get("dataset_root")
            if root:
                args.append(f"--root={root}")
            if parameters.get("keep_only_successes"):
                args.append("--keep-only-successes")
            return CommandPlan(
                executable="hashtag-robotics",
                arguments=("sim-record", *args),
                required_parameters=("teleop_port",),
                description=(
                    "Record demonstrations in simulation, driven by the leader arm."
                    if recording
                    else "Drive the simulated arm from the leader arm."
                ),
                # A terminal, so the operator can end, re-record or stop an
                # episode the way they can on the real arm. Without it a
                # simulated session ran to the end whatever happened: a take
                # that went wrong at second three still cost its full thirty.
                interactive=recording,
                # The follower is never opened and the leader is only read, so
                # nothing here can move a physical joint.
                requires_actuation=False,
            )

        if request.kind == JobKind.TELEOPERATION:
            args = [
                # Teleoperation records nothing, and the dashboard runs it with
                # `display_data=false`, so every frame LeRobot reads here is read
                # and thrown away. What it costs is real: USB bandwidth on the
                # bus whose contention already killed a recording, seconds of
                # camera probing before the first joint moves, and an exclusive
                # hold that locks the operator out of the live preview at exactly
                # the moment they are framing the shot for the next take.
                *self._robot_arguments(parameters, include_cameras=False),
                *self._teleoperator_arguments(parameters),
                f"--fps={int(parameters.get('fps', 30))}",
                f"--display_data={self._flag(parameters.get('display_data', False))}",
            ]
            teleop_time_s = parameters.get("teleop_time_s")
            if teleop_time_s is not None:
                args.append(f"--teleop_time_s={float(teleop_time_s)}")
            return CommandPlan(
                executable="lerobot-teleoperate",
                arguments=tuple(args),
                required_parameters=("robot_port", "robot_id", "teleop_port", "teleop_id"),
                description="Run leader-to-follower teleoperation.",
                requires_actuation=True,
                # Connecting to a calibrated arm always asks whether to use the
                # calibration file, so every command that touches an arm needs a
                # terminal even when the operator drives nothing else.
                interactive=True,
            )

        if request.kind == JobKind.RECORDING:
            args = [
                *self._robot_arguments(parameters),
                *self._teleoperator_arguments(parameters),
                *self._dataset_arguments(parameters),
                f"--resume={self._flag(parameters.get('resume', False))}",
                f"--play_sounds={self._flag(parameters.get('play_sounds', False))}",
                f"--display_data={self._flag(parameters.get('display_data', False))}",
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
                interactive=True,
            )

        if request.kind == JobKind.REPLAY:
            args = [
                # Replay drives recorded actions and records no observation, so
                # it needs no camera -- and lerobot-replay is the one script that
                # does not import the camera configs, so draccus cannot even
                # decode `--robot.cameras`.
                *self._robot_arguments(parameters, include_cameras=False),
                f"--dataset.repo_id={self._required(parameters, 'repo_id')}",
                f"--dataset.episode={int(parameters.get('episode', 0))}",
                f"--dataset.fps={int(parameters.get('fps', 30))}",
                f"--play_sounds={self._flag(parameters.get('play_sounds', False))}",
            ]
            root = parameters.get("dataset_root")
            if root:
                args.append(f"--dataset.root={root}")
            return CommandPlan(
                executable="lerobot-replay",
                arguments=tuple(args),
                required_parameters=("robot_port", "robot_id", "repo_id"),
                description="Replay one recorded episode on the resolved follower.",
                requires_actuation=True,
                interactive=True,
            )

        if request.kind in {JobKind.EVALUATION, JobKind.POLICY_ROLLOUT}:
            strategy = str(parameters.get("strategy", "episodic"))
            args = [
                *self._robot_arguments(parameters),
                f"--policy.path={self._required(parameters, 'policy_path')}",
                f"--strategy.type={strategy}",
                f"--task={parameters.get('task', 'Evaluate the selected policy')}",
                f"--fps={int(parameters.get('fps', 30))}",
                f"--play_sounds={self._flag(parameters.get('play_sounds', False))}",
                f"--display_data={self._flag(parameters.get('display_data', False))}",
            ]
            required = ["robot_port", "robot_id", "policy_path"]
            if strategy in RECORDING_STRATEGIES:
                args.extend(self._dataset_arguments(parameters))
                required.append("repo_id")
            else:
                args.append(f"--duration={float(parameters.get('duration', 30))}")
            device = parameters.get("device")
            if device:
                args.append(f"--device={device}")
            return CommandPlan(
                executable="lerobot-rollout",
                arguments=tuple(args),
                required_parameters=tuple(required),
                description="Run a guarded real policy rollout.",
                requires_actuation=True,
                interactive=True,
            )

        raise PhysicalExecutionError(
            f"Job kind '{request.kind.value}' has no physical LeRobot command contract."
        )

    def _role(self, parameters: dict[str, Any]) -> str:
        return str(parameters.get("role", "robot"))

    def _device_arguments(self, parameters: dict[str, Any]) -> tuple[list[str], tuple[str, ...]]:
        if self._role(parameters) == "teleoperator":
            return self._teleoperator_arguments(parameters), ("teleop_port", "teleop_id")
        return (
            self._robot_arguments(parameters, include_cameras=False, include_limits=False),
            ("robot_port", "robot_id"),
        )

    def _robot_arguments(
        self,
        parameters: dict[str, Any],
        include_cameras: bool = True,
        include_limits: bool = True,
    ) -> list[str]:
        robot_type = str(parameters.get("robot_type", DEFAULT_ROBOT_TYPE))
        args = [
            f"--robot.type={robot_type}",
            f"--robot.port={self._required(parameters, 'robot_port')}",
            f"--robot.id={self._required(parameters, 'robot_id')}",
        ]
        calibration_dir = parameters.get("robot_calibration_dir")
        if calibration_dir:
            args.append(f"--robot.calibration_dir={calibration_dir}")
        cameras = parameters.get("cameras")
        if include_cameras and cameras:
            args.append(f"--robot.cameras={json.dumps(cameras, separators=(',', ':'))}")
        max_relative_target = parameters.get("max_relative_target")
        if include_limits and max_relative_target is not None:
            args.append(f"--robot.max_relative_target={float(max_relative_target)}")
        return args

    def _teleoperator_arguments(self, parameters: dict[str, Any]) -> list[str]:
        teleop_type = str(parameters.get("teleop_type", DEFAULT_TELEOPERATOR_TYPE))
        args = [
            f"--teleop.type={teleop_type}",
            f"--teleop.port={self._required(parameters, 'teleop_port')}",
            f"--teleop.id={self._required(parameters, 'teleop_id')}",
        ]
        calibration_dir = parameters.get("teleop_calibration_dir")
        if calibration_dir:
            args.append(f"--teleop.calibration_dir={calibration_dir}")
        return args

    def _dataset_arguments(self, parameters: dict[str, Any]) -> list[str]:
        args = [
            f"--dataset.repo_id={self._required(parameters, 'repo_id')}",
            f"--dataset.single_task={self._required(parameters, 'task')}",
            f"--dataset.fps={int(parameters.get('fps', 30))}",
            f"--dataset.num_episodes={int(parameters.get('episodes', 1))}",
            f"--dataset.episode_time_s={int(parameters.get('episode_time_s', 30))}",
            f"--dataset.reset_time_s={int(parameters.get('reset_time_s', 15))}",
            f"--dataset.push_to_hub={self._flag(parameters.get('push_to_hub', False))}",
        ]
        root = parameters.get("dataset_root")
        if root:
            args.append(f"--dataset.root={root}")
        return args

    def _flag(self, value: Any) -> str:
        return str(bool(value)).lower()

    def _required(self, parameters: dict[str, Any], key: str) -> str:
        value = parameters.get(key)
        if value is None or str(value).strip() == "":
            raise PhysicalExecutionError(f"Required physical parameter '{key}' is missing.")
        return str(value)


class LeRobotCliAdapter:
    def __init__(self, settings: Settings, repository: Repository) -> None:
        self.settings = settings
        self.repository = repository
        self.builder = LeRobotCommandBuilder(settings)
        self.processes: dict[str, ManagedProcess] = {}
        self.telemetry: dict[str, TelemetryBuffer] = {}

    def runtime_available(self) -> bool:
        required = {
            "lerobot-setup-motors",
            "lerobot-calibrate",
            "lerobot-teleoperate",
            "lerobot-record",
            "lerobot-replay",
            "lerobot-rollout",
        }
        return all(resolve_command(command) for command in required)

    def environment(self) -> dict[str, str]:
        return {"HF_LEROBOT_HOME": str(self.settings.lerobot_home)}

    def preview(self, request: JobCreateRequest) -> dict[str, Any]:
        plan = self.builder.build(request)
        return {
            **plan.as_dict(),
            "environment": self.environment(),
            "runtime_available": bool(resolve_command(plan.executable)),
            "physical_enabled": self.settings.enable_physical,
            "execution_allowed": bool(
                self.settings.enable_physical and resolve_command(plan.executable)
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
        executable = resolve_command(plan.executable)
        if executable is None:
            raise PhysicalExecutionError(
                f"Required LeRobot command '{plan.executable}' is not installed."
            )

        managed = ManagedProcess(
            executable,
            plan.arguments,
            self.environment(),
            interactive=plan.interactive,
        )
        parser = TelemetryParser()
        buffer = TelemetryBuffer()
        self.telemetry[job.id] = buffer

        await progress(0.02, f"Launching verified command: {plan.executable}")
        record = await managed.start()
        self.processes[job.id] = managed
        self._persist_process(job.id, record)

        recent_output: list[str] = []
        loop = asyncio.get_running_loop()
        timeout_seconds = int(job.parameters.get("timeout_seconds", self.settings.max_job_seconds))
        episodes = max(1, int(job.parameters.get("episodes", 1)))
        started = loop.time()
        published = 0.0
        confirmations = 0

        try:
            while managed.returncode is None:
                if cancelled():
                    await managed.stop()
                    raise PhysicalExecutionError("Physical command was stopped by the operator.")
                if loop.time() - started > timeout_seconds:
                    await managed.stop()
                    raise PhysicalExecutionError("Physical command exceeded its safe timeout.")

                lines = await managed.read_available(timeout=0.2)
                for line in lines:
                    text = self._redact(strip_ansi(line).strip())
                    if text:
                        recent_output.append(text)
                        recent_output = recent_output[-40:]
                    for sample in parser.feed(line):
                        buffer.append(sample)
                        if self._should_auto_confirm(job, plan, sample, confirmations):
                            confirmations += 1
                            managed.write_key(JobInputKey.ENTER)
                            await progress(
                                self._progress(buffer, episodes),
                                "Confirmed the bound calibration revision",
                            )

                now = loop.time()
                if recent_output and now - published >= 0.5:
                    published = now
                    await progress(self._progress(buffer, episodes), recent_output[-1][:160])

            return_code = await managed.wait()
            # A command that fails on startup writes its whole reason and exits
            # before the poll loop reads anything, and a traceback is flushed at
            # exit either way. Draining here is what turns 'exited with code 1'
            # into something the operator can act on.
            recent_output = await self._drain(managed, parser, buffer, recent_output)

            if return_code != 0:
                tail = " | ".join(recent_output[-4:])
                raise PhysicalExecutionError(
                    f"{plan.executable} exited with code {return_code}."
                    + (f" Last output: {tail}" if tail else " It produced no output.")
                )
            await progress(1.0, "Physical command completed")
            return {
                "adapter": "lerobot-cli",
                "command": plan.executable,
                "return_code": return_code,
                "interactive": plan.interactive,
                "telemetry": buffer.summary(),
                "recent_output": recent_output,
            }
        finally:
            await managed.stop()
            managed.close()
            self.processes.pop(job.id, None)
            self._persist_process(job.id, None)

    def _should_auto_confirm(
        self,
        job: JobRecord,
        plan: CommandPlan,
        sample: TelemetrySample,
        confirmations: int,
    ) -> bool:
        """Answer 'use the calibration file?' on the operator's behalf.

        LeRobot asks this once per arm whenever the motors do not already hold
        the file's calibration, so it fires on every connect. The operator has
        no new decision to make: preflight already resolved which revision this
        job runs with and verified its checksum against disk. A calibration job
        is the exception, because there the answer is the point of the job.
        """
        if not plan.interactive or job.kind in AUTO_CONFIRM_EXCLUDED:
            return False
        if confirmations >= MAX_AUTO_CONFIRMATIONS:
            return False
        return sample.kind == TelemetryKind.PROMPT and sample.expects == JobInputKey.RECALIBRATE

    async def _drain(
        self,
        managed: ManagedProcess,
        parser: TelemetryParser,
        buffer: TelemetryBuffer,
        recent_output: list[str],
    ) -> list[str]:
        """Read whatever the exited command left in the pipe."""
        for _ in range(20):
            lines = await managed.read_available(timeout=0.1)
            if not lines:
                break
            for line in lines:
                text = self._redact(strip_ansi(line).strip())
                if text:
                    recent_output.append(text)
                    recent_output = recent_output[-40:]
                for sample in parser.feed(line):
                    buffer.append(sample)
        return recent_output

    def send_input(self, job_id: str, key: JobInputKey) -> None:
        managed = self.processes.get(job_id)
        if managed is None:
            raise PhysicalExecutionError(f"Job '{job_id}' has no running physical command.")
        managed.write_key(key)

    async def stop_all(self, grace_seconds: float = 1.0) -> list[str]:
        outcomes: list[str] = []
        for job_id, managed in list(self.processes.items()):
            outcomes.append(f"{job_id}:{await managed.stop(grace_seconds=grace_seconds)}")
        return outcomes

    def telemetry_summary(self, job_id: str) -> dict[str, Any]:
        buffer = self.telemetry.get(job_id)
        return buffer.summary() if buffer else {}

    def _persist_process(self, job_id: str, record: JobProcess | None) -> None:
        job = self.repository.get_job(job_id)
        if job is None:
            return
        job.process = record
        self.repository.update_job(job)

    def _progress(self, buffer: TelemetryBuffer, episodes: int) -> float:
        episode = buffer.latest(TelemetryKind.EPISODE)
        if episode is None or episode.episode is None:
            return 0.5
        return min(0.95, (episode.episode + 1) / episodes)

    def _redact(self, value: str) -> str:
        lowered = value.lower()
        if any(marker in lowered for marker in ("token=", "access_code=", "password=")):
            return "[redacted sensitive output]"
        return value
