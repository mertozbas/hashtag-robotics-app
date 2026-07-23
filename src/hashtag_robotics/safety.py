from __future__ import annotations

import hashlib
import json
import shutil
from datetime import timedelta

from hashtag_robotics.config import Settings
from hashtag_robotics.models import (
    ApprovalRecord,
    CheckStatus,
    JobCreateRequest,
    JobKind,
    PreflightResult,
    SafetyCheck,
    TargetMode,
    utc_now,
)

PHYSICAL_JOB_KINDS = {
    JobKind.MOTOR_SETUP,
    JobKind.CALIBRATION,
    JobKind.TELEOPERATION,
    JobKind.RECORDING,
    JobKind.REPLAY,
    JobKind.EVALUATION,
    JobKind.POLICY_ROLLOUT,
}


def parameter_hash(request: JobCreateRequest) -> str:
    encoded = json.dumps(
        request.model_dump(mode="json"),
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    return hashlib.sha256(encoded).hexdigest()


class SafetyService:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def preflight(self, request: JobCreateRequest) -> PreflightResult:
        checks: list[SafetyCheck] = []
        is_real_actuation = (
            request.target_mode == TargetMode.REAL and request.kind in PHYSICAL_JOB_KINDS
        )

        checks.append(
            SafetyCheck(
                code="target.explicit",
                label="Resolved target mode",
                status=CheckStatus.PASS,
                message=f"Target mode is explicitly '{request.target_mode.value}'.",
            )
        )

        if is_real_actuation:
            checks.append(
                SafetyCheck(
                    code="physical.enabled",
                    label="Physical adapter gate",
                    status=(
                        CheckStatus.PASS if self.settings.enable_physical else CheckStatus.BLOCKED
                    ),
                    message=(
                        "Physical adapters are enabled."
                        if self.settings.enable_physical
                        else "Physical adapters remain locked until HIL testing."
                    ),
                )
            )
            checks.append(
                SafetyCheck(
                    code="resources.resolved",
                    label="Exclusive resources",
                    status=CheckStatus.PASS if request.resources else CheckStatus.BLOCKED,
                    message=(
                        f"{len(request.resources)} resource lease(s) requested."
                        if request.resources
                        else "Real actuation requires resolved robot resources."
                    ),
                )
            )
            command_name = {
                JobKind.MOTOR_SETUP: "lerobot-setup-motors",
                JobKind.CALIBRATION: "lerobot-calibrate",
                JobKind.TELEOPERATION: "lerobot-teleoperate",
                JobKind.RECORDING: "lerobot-record",
                JobKind.REPLAY: "lerobot-replay",
                JobKind.EVALUATION: "lerobot-rollout",
                JobKind.POLICY_ROLLOUT: "lerobot-rollout",
            }[request.kind]
            runtime_available = shutil.which(command_name) is not None
            checks.append(
                SafetyCheck(
                    code="physical.runtime",
                    label="LeRobot physical runtime",
                    status=CheckStatus.PASS if runtime_available else CheckStatus.BLOCKED,
                    message=(
                        f"Resolved '{command_name}'."
                        if runtime_available
                        else f"Required command '{command_name}' is not installed."
                    ),
                )
            )

            required_flags: list[tuple[str, str]] = [
                ("emergency_stop_ready", "Emergency stop"),
            ]
            if request.kind == JobKind.CALIBRATION:
                required_flags.append(("safe_pose_confirmed", "Safe calibration pose"))
            elif request.kind == JobKind.MOTOR_SETUP:
                required_flags.append(("motor_setup_workspace_ready", "Motor setup workspace"))
            else:
                required_flags.extend(
                    [
                        ("calibration_verified", "Calibration"),
                        ("joint_limits_verified", "Joint limits"),
                    ]
                )

            for key, label in required_flags:
                verified = bool(request.parameters.get(key))
                checks.append(
                    SafetyCheck(
                        code=f"safety.{key}",
                        label=label,
                        status=CheckStatus.PASS if verified else CheckStatus.BLOCKED,
                        message=f"{label} is {'verified' if verified else 'not verified'}.",
                    )
                )

        if request.kind in {JobKind.POLICY_ROLLOUT, JobKind.EVALUATION}:
            mapping_verified = bool(request.parameters.get("feature_mapping_verified"))
            checks.append(
                SafetyCheck(
                    code="policy.feature_mapping",
                    label="Policy feature mapping",
                    status=CheckStatus.PASS if mapping_verified else CheckStatus.BLOCKED,
                    message=(
                        "Dataset, policy and robot feature mapping is verified."
                        if mapping_verified
                        else "Feature mapping must be verified before evaluation."
                    ),
                )
            )

        blocked = any(check.status == CheckStatus.BLOCKED for check in checks)
        return PreflightResult(
            allowed=not blocked,
            requires_approval=is_real_actuation,
            checks=checks,
        )

    def create_approval(self, job_id: str, request: JobCreateRequest) -> ApprovalRecord:
        return ApprovalRecord(
            job_id=job_id,
            parameters_hash=parameter_hash(request),
            expires_at=utc_now() + timedelta(minutes=5),
        )
