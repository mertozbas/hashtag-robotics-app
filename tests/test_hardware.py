from __future__ import annotations

import pytest

from hashtag_robotics.hardware import LeRobotCommandBuilder, PhysicalExecutionError
from hashtag_robotics.models import JobCreateRequest, JobKind, TargetMode


def real_request(kind: JobKind, **parameters: object) -> JobCreateRequest:
    return JobCreateRequest(
        kind=kind,
        target_mode=TargetMode.REAL,
        parameters=parameters,
        requested_by="test",
    )


def test_teleoperation_command_is_an_argument_array_without_shell() -> None:
    plan = LeRobotCommandBuilder().build(
        real_request(
            JobKind.TELEOPERATION,
            robot_port="/dev/follower",
            robot_id="mert_follower",
            teleop_port="/dev/leader",
            teleop_id="mert_leader",
            max_relative_target=5.0,
            cameras={
                "front": {
                    "type": "opencv",
                    "index_or_path": 0,
                    "width": 640,
                    "height": 480,
                    "fps": 30,
                }
            },
        )
    )
    assert plan.executable == "lerobot-teleoperate"
    assert "--robot.type=so_follower" in plan.arguments
    assert "--teleop.type=so_leader" in plan.arguments
    assert "--robot.max_relative_target=5.0" in plan.arguments
    assert plan.as_dict()["uses_shell"] is False


def test_recording_command_requires_repo_and_task() -> None:
    with pytest.raises(PhysicalExecutionError, match="repo_id"):
        LeRobotCommandBuilder().build(
            real_request(
                JobKind.RECORDING,
                robot_port="/dev/follower",
                robot_id="follower",
                teleop_port="/dev/leader",
                teleop_id="leader",
            )
        )


def test_teleoperator_calibration_does_not_require_robot_port() -> None:
    plan = LeRobotCommandBuilder().build(
        real_request(
            JobKind.CALIBRATION,
            role="teleoperator",
            teleop_port="/dev/leader",
            teleop_id="leader",
        )
    )
    assert plan.executable == "lerobot-calibrate"
    assert all(not argument.startswith("--robot.") for argument in plan.arguments)
    assert "--teleop.port=/dev/leader" in plan.arguments


def test_training_command_is_non_actuating_and_typed() -> None:
    plan = LeRobotCommandBuilder().build(
        JobCreateRequest(
            kind=JobKind.TRAINING,
            target_mode=TargetMode.READ_ONLY,
            parameters={
                "repo_id": "hashtag/test-dataset",
                "policy_type": "act",
                "output_dir": "outputs/train/act-test",
                "steps": 2000,
            },
            requested_by="test",
        )
    )
    assert plan.executable == "lerobot-train"
    assert plan.requires_actuation is False
    assert "--dataset.repo_id=hashtag/test-dataset" in plan.arguments
    assert "--policy.type=act" in plan.arguments
    assert "--steps=2000" in plan.arguments
