from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import Any
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field


def utc_now() -> datetime:
    return datetime.now(UTC)


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex[:16]}"


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class DeviceKind(StrEnum):
    SERIAL = "serial"
    CAMERA = "camera"
    GPU = "gpu"
    SIMULATOR = "simulator"


class TargetMode(StrEnum):
    READ_ONLY = "read_only"
    SIM = "sim"
    REAL = "real"


class JobKind(StrEnum):
    HARDWARE_DISCOVERY = "hardware_discovery"
    MOTOR_SETUP = "motor_setup"
    CALIBRATION = "calibration"
    CAMERA_PREVIEW = "camera_preview"
    TELEOPERATION = "teleoperation"
    RECORDING = "recording"
    REPLAY = "replay"
    DATASET_VALIDATE = "dataset_validate"
    DATASET_TRANSFORM = "dataset_transform"
    TRAINING = "training"
    EVALUATION = "evaluation"
    POLICY_ROLLOUT = "policy_rollout"
    SIMULATION = "simulation"
    REMOTE_INFERENCE_PROBE = "remote_inference_probe"
    HUB_SYNC = "hub_sync"
    DIAGNOSTICS = "diagnostics"


class JobState(StrEnum):
    CREATED = "created"
    VALIDATING = "validating"
    BLOCKED = "blocked"
    AWAITING_CONFIRMATION = "awaiting_confirmation"
    QUEUED = "queued"
    STARTING = "starting"
    RUNNING = "running"
    STOPPING = "stopping"
    COMPLETED = "completed"
    FAILED = "failed"
    ABORTED = "aborted"
    INTERRUPTED = "interrupted"


class ApprovalStatus(StrEnum):
    PENDING = "pending"
    CONFIRMED = "confirmed"
    EXPIRED = "expired"
    REJECTED = "rejected"
    CONSUMED = "consumed"


class CheckStatus(StrEnum):
    PASS = "pass"
    WARNING = "warning"
    BLOCKED = "blocked"
    NOT_APPLICABLE = "not_applicable"


class Severity(StrEnum):
    INFO = "info"
    WARNING = "warning"
    CRITICAL = "critical"


class DeviceRecord(StrictModel):
    id: str = Field(default_factory=lambda: new_id("dev"))
    kind: DeviceKind
    name: str
    stable_fingerprint: str
    transient_path: str | None = None
    vendor: str | None = None
    product: str | None = None
    serial_number: str | None = None
    capabilities: list[str] = Field(default_factory=list)
    health: str = "unknown"
    is_simulated: bool = False
    last_seen_at: datetime = Field(default_factory=utc_now)


class RobotProfile(StrictModel):
    id: str = Field(default_factory=lambda: new_id("robot"))
    name: str
    product_sku: str = "SO-101"
    robot_type: str = "so_follower"
    serial_number: str | None = None
    hardware_revision: str | None = None
    device_fingerprint: str | None = None
    motor_layout: dict[str, int] = Field(default_factory=dict)
    calibration_revision: str | None = None
    camera_mapping: dict[str, str] = Field(default_factory=dict)
    joint_limits_verified: bool = False
    calibration_verified: bool = False
    emergency_stop_ready: bool = False
    target_mode: TargetMode = TargetMode.REAL
    compatibility_channel: str = "stable"
    created_at: datetime = Field(default_factory=utc_now)


class CameraProfile(StrictModel):
    id: str = Field(default_factory=lambda: new_id("camera"))
    name: str
    device_fingerprint: str
    backend: str = "opencv"
    semantic_name: str
    width: int = 640
    height: int = 480
    fps: int = 30
    supports_depth: bool = False
    orientation_degrees: int = 0
    latency_baseline_ms: float | None = None
    created_at: datetime = Field(default_factory=utc_now)


class DatasetManifest(StrictModel):
    id: str = Field(default_factory=lambda: new_id("dataset"))
    name: str
    repo_id: str | None = None
    local_path: str | None = None
    task: str
    robot_profile_id: str | None = None
    calibration_revision: str | None = None
    features: list[str] = Field(default_factory=list)
    camera_mapping: dict[str, str] = Field(default_factory=dict)
    fps: int = 30
    episodes: int = 0
    integrity_status: str = "unverified"
    provenance: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=utc_now)


class PolicyManifest(StrictModel):
    id: str = Field(default_factory=lambda: new_id("policy"))
    name: str
    policy_type: str
    checkpoint: str | None = None
    source_dataset_id: str | None = None
    expected_features: list[str] = Field(default_factory=list)
    processor_chain: list[str] = Field(default_factory=list)
    action_shape: list[int] = Field(default_factory=lambda: [6])
    camera_mapping: dict[str, str] = Field(default_factory=dict)
    runtime: str = "local"
    compatibility_status: str = "unverified"
    evaluation_summary: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=utc_now)


class AgentSession(StrictModel):
    id: str = Field(default_factory=lambda: new_id("agent"))
    role: str
    name: str
    model_provider: str = "deterministic"
    permissions: list[str] = Field(default_factory=list)
    status: str = "ready"
    created_at: datetime = Field(default_factory=utc_now)


class RemoteEndpoint(StrictModel):
    id: str = Field(default_factory=lambda: new_id("remote"))
    name: str
    url: str
    transport: str = "grpc"
    tls_required: bool = True
    expected_policy_id: str | None = None
    status: str = "unverified"
    created_at: datetime = Field(default_factory=utc_now)


class SimulationScenario(StrictModel):
    id: str = Field(default_factory=lambda: new_id("scenario"))
    name: str
    robot_type: str = "so101"
    backend: str = "mock"
    scene: str = "tabletop"
    task: str = "Reach a safe target"
    camera_mapping: dict[str, str] = Field(
        default_factory=lambda: {"front": "observation.images.front"}
    )
    created_at: datetime = Field(default_factory=utc_now)


class ResourceRequest(StrictModel):
    resource_id: str
    resource_type: str
    mode: str = "exclusive"


class JobCreateRequest(StrictModel):
    kind: JobKind
    target_mode: TargetMode = TargetMode.SIM
    parameters: dict[str, Any] = Field(default_factory=dict)
    resources: list[ResourceRequest] = Field(default_factory=list)
    requested_by: str = "local-user"


class JobRecord(StrictModel):
    id: str = Field(default_factory=lambda: new_id("job"))
    kind: JobKind
    state: JobState = JobState.CREATED
    target_mode: TargetMode
    parameters: dict[str, Any] = Field(default_factory=dict)
    resources: list[ResourceRequest] = Field(default_factory=list)
    requested_by: str
    progress: float = 0.0
    message: str = "Created"
    result: dict[str, Any] = Field(default_factory=dict)
    error_code: str | None = None
    error_message: str | None = None
    correlation_id: str = Field(default_factory=lambda: new_id("corr"))
    approval_id: str | None = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class ResourceLease(StrictModel):
    resource_id: str
    resource_type: str
    owner_job_id: str
    mode: str = "exclusive"
    acquired_at: datetime = Field(default_factory=utc_now)
    heartbeat_at: datetime = Field(default_factory=utc_now)
    expires_at: datetime


class ApprovalRecord(StrictModel):
    id: str = Field(default_factory=lambda: new_id("approval"))
    job_id: str
    parameters_hash: str
    status: ApprovalStatus = ApprovalStatus.PENDING
    expires_at: datetime
    created_at: datetime = Field(default_factory=utc_now)
    confirmed_at: datetime | None = None


class SafetyCheck(StrictModel):
    code: str
    label: str
    status: CheckStatus
    message: str


class PreflightResult(StrictModel):
    allowed: bool
    requires_approval: bool = False
    checks: list[SafetyCheck] = Field(default_factory=list)


class DoctorCheck(StrictModel):
    code: str
    label: str
    status: CheckStatus
    detail: str
    remediation: str | None = None


class CapabilityManifest(StrictModel):
    platform_version: str
    python_version: str
    os: str
    architecture: str
    packages: dict[str, str | None]
    accelerator: str
    camera_backends: list[str]
    robot_adapters: list[str]
    policy_adapters: list[str]
    simulation_backends: list[str]
    physical_enabled: bool
    generated_at: datetime = Field(default_factory=utc_now)


class DoctorReport(StrictModel):
    overall: CheckStatus
    checks: list[DoctorCheck]
    capabilities: CapabilityManifest
    generated_at: datetime = Field(default_factory=utc_now)


class AuditEvent(StrictModel):
    id: str = Field(default_factory=lambda: new_id("audit"))
    timestamp: datetime = Field(default_factory=utc_now)
    actor: str
    action: str
    target: str
    correlation_id: str
    outcome: str
    details: dict[str, Any] = Field(default_factory=dict)


class AgentCommandRequest(StrictModel):
    session_id: str
    action: str
    parameters: dict[str, Any] = Field(default_factory=dict)


class AgentCommandResult(StrictModel):
    accepted: bool
    action: str
    message: str
    job: JobRecord | None = None
    data: dict[str, Any] = Field(default_factory=dict)


class AgentPlanRequest(StrictModel):
    session_id: str
    prompt: str = Field(min_length=3, max_length=8_000)
    execute: bool = False


class AgentPlan(StrictModel):
    action: str
    rationale: str
    parameters: dict[str, Any] = Field(default_factory=dict)
    risks: list[str] = Field(default_factory=list)
    requires_confirmation: bool = False


class AgentPlanResult(StrictModel):
    plan: AgentPlan
    executed: bool = False
    command_result: AgentCommandResult | None = None


class DashboardSummary(StrictModel):
    system_status: CheckStatus
    physical_enabled: bool
    devices: int
    robots: int
    datasets: int
    policies: int
    active_jobs: int
    blocked_jobs: int
    recent_jobs: list[JobRecord]
