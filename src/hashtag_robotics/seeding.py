from __future__ import annotations

import importlib.util

from hashtag_robotics.agents import ROLE_PERMISSIONS
from hashtag_robotics.models import (
    AgentSession,
    CameraProfile,
    PolicyManifest,
    RobotProfile,
    SimulationScenario,
    TargetMode,
)
from hashtag_robotics.repository import Repository


def seed_repository(repository: Repository) -> None:
    if repository.get_entity("robot", "robot_sim_so101", RobotProfile) is None:
        repository.upsert_entity(
            "robot",
            RobotProfile(
                id="robot_sim_so101",
                name="SO-101 Safe Simulator",
                serial_number="SIM-SO101-001",
                hardware_revision="simulation-v1",
                device_fingerprint="sim-so101-v1",
                calibration_revision="sim-calibration-v1",
                camera_mapping={"front": "camera_sim_front"},
                joint_limits_verified=True,
                calibration_verified=True,
                emergency_stop_ready=True,
                target_mode=TargetMode.SIM,
            ),
        )

    if repository.get_entity("camera", "camera_sim_front", CameraProfile) is None:
        repository.upsert_entity(
            "camera",
            CameraProfile(
                id="camera_sim_front",
                name="Virtual Front Camera",
                device_fingerprint="sim-camera-front-v1",
                backend="safe-mock",
                semantic_name="front",
                latency_baseline_ms=4.0,
            ),
        )

    if repository.get_entity("scenario", "scenario_tabletop", SimulationScenario) is None:
        repository.upsert_entity(
            "scenario",
            SimulationScenario(
                id="scenario_tabletop",
                name="SO-101 Tabletop Safety Baseline",
                backend="safe-mock",
                task="Move through a bounded joint trajectory without constraint violations",
            ),
        )

    if (
        importlib.util.find_spec("mujoco") is not None
        and repository.get_entity(
            "scenario",
            "scenario_mujoco_contract",
            SimulationScenario,
        )
        is None
    ):
        repository.upsert_entity(
            "scenario",
            SimulationScenario(
                id="scenario_mujoco_contract",
                name="SO-101 MuJoCo Contract Model",
                backend="mujoco",
                task="Validate six-joint action timing and limits in MuJoCo",
            ),
        )

    if repository.get_entity("policy", "policy_safe_baseline", PolicyManifest) is None:
        repository.upsert_entity(
            "policy",
            PolicyManifest(
                id="policy_safe_baseline",
                name="Safe Mock Baseline",
                policy_type="mock",
                checkpoint="mock://safe-baseline",
                expected_features=[
                    "observation.state",
                    "action",
                    "observation.images.front",
                ],
                processor_chain=["feature-validator", "relative-action-limiter"],
                action_shape=[6],
                camera_mapping={"front": "observation.images.front"},
                compatibility_status="sim-compatible",
            ),
        )

    existing_sessions = repository.list_entities("agent_session", AgentSession)
    if not existing_sessions:
        labels = {
            "lab_assistant": "Lab Assistant",
            "dataset_curator": "Dataset Curator",
            "training_advisor": "Training Advisor",
            "evaluation_analyst": "Evaluation Analyst",
            "robot_operator": "Robot Operator",
        }
        for role, permissions in ROLE_PERMISSIONS.items():
            repository.upsert_entity(
                "agent_session",
                AgentSession(
                    id=f"agent_{role}",
                    role=role,
                    name=labels[role],
                    permissions=sorted(permissions),
                ),
            )
