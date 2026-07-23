from __future__ import annotations

from pathlib import Path

from hashtag_robotics.config import Settings
from hashtag_robotics.models import (
    JobCreateRequest,
    JobKind,
    ResourceRequest,
    TargetMode,
)
from hashtag_robotics.safety import SafetyService


def physical_request(kind: JobKind, parameters: dict[str, object]) -> JobCreateRequest:
    return JobCreateRequest(
        kind=kind,
        target_mode=TargetMode.REAL,
        parameters=parameters,
        resources=[
            ResourceRequest(
                resource_id="resolved-device",
                resource_type="robot",
                mode="exclusive",
            )
        ],
        requested_by="test",
    )


def test_calibration_does_not_require_an_existing_calibration(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr("hashtag_robotics.safety.shutil.which", lambda _: "/test/command")
    service = SafetyService(
        Settings(
            data_dir=tmp_path,
            enable_physical=True,
            open_browser=False,
        )
    )
    result = service.preflight(
        physical_request(
            JobKind.CALIBRATION,
            {
                "emergency_stop_ready": True,
                "safe_pose_confirmed": True,
            },
        )
    )
    assert result.allowed is True
    assert result.requires_approval is True
    assert all(check.code != "safety.calibration_verified" for check in result.checks)


def test_real_teleoperation_requires_calibration_and_joint_limits(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr("hashtag_robotics.safety.shutil.which", lambda _: "/test/command")
    service = SafetyService(
        Settings(
            data_dir=tmp_path,
            enable_physical=True,
            open_browser=False,
        )
    )
    result = service.preflight(
        physical_request(
            JobKind.TELEOPERATION,
            {
                "emergency_stop_ready": True,
                "calibration_verified": False,
                "joint_limits_verified": False,
            },
        )
    )
    assert result.allowed is False
    blocked_codes = {check.code for check in result.checks if check.status.value == "blocked"}
    assert {
        "safety.calibration_verified",
        "safety.joint_limits_verified",
    } <= blocked_codes
