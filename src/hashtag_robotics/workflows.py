from __future__ import annotations

import asyncio
import hashlib
from collections.abc import Awaitable, Callable
from typing import Any

from hashtag_robotics.config import Settings
from hashtag_robotics.discovery import DiscoveryService
from hashtag_robotics.doctor import diagnostics_payload
from hashtag_robotics.hardware import LeRobotCliAdapter
from hashtag_robotics.models import (
    DatasetManifest,
    JobKind,
    JobRecord,
    PolicyManifest,
    SimulationScenario,
)
from hashtag_robotics.repository import Repository
from hashtag_robotics.simulation import MujocoContractAdapter

ProgressCallback = Callable[[float, str], Awaitable[None]]
CancelCheck = Callable[[], bool]


WORKFLOW_STEPS: dict[JobKind, list[str]] = {
    JobKind.HARDWARE_DISCOVERY: [
        "Inspecting serial devices",
        "Resolving stable fingerprints",
        "Publishing capability inventory",
    ],
    JobKind.MOTOR_SETUP: [
        "Validating target profile",
        "Preparing motor setup plan",
        "Verifying resulting motor map",
    ],
    JobKind.CALIBRATION: [
        "Backing up the active calibration",
        "Preparing calibration ranges",
        "Validating the calibration artifact",
    ],
    JobKind.CAMERA_PREVIEW: [
        "Resolving the camera profile",
        "Checking frame timing",
        "Publishing preview metadata",
    ],
    JobKind.TELEOPERATION: [
        "Acquiring robot and teleoperator leases",
        "Starting the safe control loop",
        "Checking latency and watchdog",
        "Stopping the control loop safely",
    ],
    JobKind.RECORDING: [
        "Validating recording schema",
        "Preparing episode storage",
        "Capturing simulated episode data",
        "Writing the dataset manifest",
        "Running integrity checks",
    ],
    JobKind.REPLAY: [
        "Validating episode action shape",
        "Preparing replay limits",
        "Replaying in the selected target mode",
        "Stopping safely",
    ],
    JobKind.DATASET_VALIDATE: [
        "Reading dataset metadata",
        "Checking feature and camera schema",
        "Checking episode integrity",
        "Updating the dataset manifest",
    ],
    JobKind.DATASET_TRANSFORM: [
        "Creating an immutable source revision",
        "Applying the requested transform",
        "Validating the transformed dataset",
    ],
    JobKind.TRAINING: [
        "Resolving dataset and policy preset",
        "Checking compute capabilities",
        "Preparing a reproducible training configuration",
        "Running the safe mock trainer",
        "Registering the resulting policy",
    ],
    JobKind.EVALUATION: [
        "Checking policy compatibility",
        "Preparing evaluation episodes",
        "Running the safe evaluation",
        "Computing result distribution",
    ],
    JobKind.POLICY_ROLLOUT: [
        "Resolving policy and target robot",
        "Validating processors and feature mapping",
        "Starting the guarded rollout",
        "Collecting telemetry",
        "Stopping the rollout safely",
    ],
    JobKind.SIMULATION: [
        "Loading the simulation contract",
        "Resolving robot and camera mappings",
        "Running the deterministic mock scenario",
        "Collecting simulation telemetry",
    ],
    JobKind.REMOTE_INFERENCE_PROBE: [
        "Validating endpoint security",
        "Checking protocol compatibility",
        "Measuring the mocked latency budget",
    ],
    JobKind.HUB_SYNC: [
        "Validating local artifact",
        "Preparing the sync plan",
        "Recording the safe dry-run result",
    ],
    JobKind.DIAGNOSTICS: [
        "Running system checks",
        "Redacting sensitive values",
        "Preparing the diagnostics payload",
    ],
}


class WorkflowCancelled(RuntimeError):
    pass


class WorkflowEngine:
    def __init__(
        self,
        repository: Repository,
        discovery: DiscoveryService,
        settings: Settings,
        hardware: LeRobotCliAdapter,
    ) -> None:
        self.repository = repository
        self.discovery = discovery
        self.settings = settings
        self.hardware = hardware
        self.simulation = MujocoContractAdapter()

    async def execute(
        self,
        job: JobRecord,
        progress: ProgressCallback,
        cancelled: CancelCheck,
    ) -> dict[str, Any]:
        if job.target_mode.value == "real":
            return await self.hardware.execute(job, progress, cancelled)
        if job.kind == JobKind.TRAINING and str(job.parameters.get("runtime")) == "lerobot-local":
            return await self.hardware.execute(job, progress, cancelled)

        steps = WORKFLOW_STEPS[job.kind]
        for index, message in enumerate(steps, start=1):
            if cancelled():
                raise WorkflowCancelled("The job was stopped by the operator.")
            await progress((index - 1) / len(steps), message)
            await asyncio.sleep(self.settings.simulation_step_seconds)
        result = self._finalize(job)
        await progress(1.0, "Completed")
        return result

    def _finalize(self, job: JobRecord) -> dict[str, Any]:
        if job.kind == JobKind.HARDWARE_DISCOVERY:
            devices = self.discovery.discover(include_simulated=True)
            return {
                "device_ids": [device.id for device in devices],
                "physical_devices": len([device for device in devices if not device.is_simulated]),
                "simulated_devices": len([device for device in devices if device.is_simulated]),
            }

        if job.kind == JobKind.RECORDING:
            dataset = DatasetManifest(
                name=str(job.parameters.get("name", "SO-101 simulation dataset")),
                task=str(job.parameters.get("task", "Safe simulated manipulation")),
                robot_profile_id=job.parameters.get("robot_profile_id"),
                calibration_revision=job.parameters.get("calibration_revision"),
                features=list(
                    job.parameters.get(
                        "features",
                        [
                            "observation.state",
                            "action",
                            "observation.images.front",
                        ],
                    )
                ),
                camera_mapping=dict(
                    job.parameters.get(
                        "camera_mapping",
                        {"front": "observation.images.front"},
                    )
                ),
                fps=int(job.parameters.get("fps", 30)),
                episodes=int(job.parameters.get("episodes", 1)),
                integrity_status="verified",
                provenance={
                    "job_id": job.id,
                    "target_mode": job.target_mode.value,
                    "adapter": "safe-mock",
                },
            )
            self.repository.upsert_entity("dataset", dataset)
            return {"dataset_id": dataset.id, "integrity_status": dataset.integrity_status}

        if job.kind == JobKind.DATASET_VALIDATE:
            dataset_id = str(job.parameters.get("dataset_id", ""))
            dataset = self.repository.get_entity("dataset", dataset_id, DatasetManifest)
            if dataset is None:
                raise RuntimeError(f"Dataset '{dataset_id}' was not found.")
            dataset.integrity_status = "verified"
            self.repository.upsert_entity("dataset", dataset)
            return {
                "dataset_id": dataset.id,
                "integrity_status": dataset.integrity_status,
                "feature_count": len(dataset.features),
            }

        if job.kind == JobKind.TRAINING:
            dataset_id = job.parameters.get("dataset_id")
            policy_type = str(job.parameters.get("policy_type", "act"))
            policy = PolicyManifest(
                name=str(job.parameters.get("name", f"{policy_type.upper()} safe mock policy")),
                policy_type=policy_type,
                checkpoint=f"mock://checkpoints/{job.id}",
                source_dataset_id=dataset_id,
                expected_features=list(
                    job.parameters.get("features", ["observation.state", "action"])
                ),
                processor_chain=["mock-normalizer", "feature-validator"],
                action_shape=list(job.parameters.get("action_shape", [6])),
                camera_mapping=dict(job.parameters.get("camera_mapping", {})),
                runtime=str(job.parameters.get("runtime", "safe-mock")),
                compatibility_status="sim-compatible",
            )
            self.repository.upsert_entity("policy", policy)
            return {
                "policy_id": policy.id,
                "checkpoint": policy.checkpoint,
                "compatibility_status": policy.compatibility_status,
            }

        if job.kind in {JobKind.EVALUATION, JobKind.POLICY_ROLLOUT}:
            episodes = max(1, int(job.parameters.get("episodes", 3)))
            successes = max(0, episodes - 1)
            return {
                "episodes": episodes,
                "successes": successes,
                "failures": episodes - successes,
                "success_rate": successes / episodes,
                "p50_latency_ms": 18.4,
                "p95_latency_ms": 27.9,
                "target_mode": job.target_mode.value,
                "adapter": "safe-mock",
            }

        if job.kind == JobKind.SIMULATION:
            scenario_id = job.parameters.get("scenario_id")
            scenario = (
                self.repository.get_entity("scenario", str(scenario_id), SimulationScenario)
                if scenario_id
                else None
            )
            if scenario and scenario.backend == "mujoco":
                return self.simulation.run(
                    scenario,
                    control_ticks=int(job.parameters.get("control_ticks", 180)),
                    control_hz=int(job.parameters.get("control_hz", 30)),
                )
            return {
                "scenario_id": scenario.id if scenario else None,
                "backend": scenario.backend if scenario else "safe-mock",
                "steps": 180,
                "control_hz": 30,
                "max_joint_delta": 0.024,
                "constraint_violations": 0,
                "camera_frames": 180,
            }

        if job.kind == JobKind.REMOTE_INFERENCE_PROBE:
            url = str(job.parameters.get("url", ""))
            tls_required = bool(job.parameters.get("tls_required", True))
            if tls_required and not url.startswith(("https://", "grpcs://", "wss://")):
                raise RuntimeError("Remote inference endpoint must use TLS.")
            return {
                "endpoint": url,
                "transport": job.parameters.get("transport", "grpc"),
                "status": "safe-mock-verified",
                "p50_latency_ms": 21.0,
                "p95_latency_ms": 34.0,
                "network_access_performed": False,
            }

        if job.kind == JobKind.DIAGNOSTICS:
            return diagnostics_payload(self.settings)

        payload = repr(sorted(job.parameters.items())).encode()
        return {
            "adapter": "safe-mock",
            "workflow": job.kind.value,
            "plan_hash": hashlib.sha256(payload).hexdigest()[:16],
        }
