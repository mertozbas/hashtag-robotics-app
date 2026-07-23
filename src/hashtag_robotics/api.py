from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any

from fastapi import Body, FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from hashtag_robotics import __version__
from hashtag_robotics.agents import AgentGateway
from hashtag_robotics.config import Settings, get_settings
from hashtag_robotics.discovery import DiscoveryService
from hashtag_robotics.doctor import DoctorService, diagnostics_payload
from hashtag_robotics.hardware import LeRobotCliAdapter, PhysicalExecutionError
from hashtag_robotics.jobs import JobCoordinator
from hashtag_robotics.models import (
    AgentCommandRequest,
    AgentCommandResult,
    AgentPlanRequest,
    AgentPlanResult,
    AgentSession,
    AuditEvent,
    CameraProfile,
    DashboardSummary,
    DatasetManifest,
    DeviceRecord,
    JobCreateRequest,
    JobRecord,
    JobState,
    PolicyManifest,
    RemoteEndpoint,
    RobotProfile,
    SimulationScenario,
)
from hashtag_robotics.repository import Repository
from hashtag_robotics.safety import SafetyService
from hashtag_robotics.seeding import seed_repository
from hashtag_robotics.strands_runtime import StrandsPlanner, StrandsRuntimeError
from hashtag_robotics.workflows import WORKFLOW_STEPS, WorkflowEngine


class Runtime:
    def __init__(self, settings: Settings) -> None:
        settings.ensure_directories()
        self.settings = settings
        self.repository = Repository(settings.database_path)
        self.doctor = DoctorService(settings)
        self.discovery = DiscoveryService(self.repository)
        self.hardware = LeRobotCliAdapter(settings)
        self.safety = SafetyService(settings)
        self.workflows = WorkflowEngine(
            self.repository,
            self.discovery,
            settings,
            self.hardware,
        )
        self.jobs = JobCoordinator(self.repository, self.safety, self.workflows)
        self.agents = AgentGateway(self.repository, self.jobs, self.doctor)
        self.strands = StrandsPlanner(settings, self.repository, self.agents)


def create_app(settings: Settings | None = None) -> FastAPI:
    runtime = Runtime(settings or get_settings())

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        seed_repository(runtime.repository)
        await runtime.jobs.start()
        yield
        await runtime.jobs.stop()

    app = FastAPI(
        title="Hashtag Robotics Control Plane",
        version=__version__,
        description="Local-first, agent-safe SO-101 control plane",
        lifespan=lifespan,
    )
    app.state.runtime = runtime

    if runtime.settings.frontend_dev_url:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=[runtime.settings.frontend_dev_url],
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    @app.get("/api/health")
    async def health() -> dict[str, Any]:
        return {
            "status": "ok",
            "version": __version__,
            "physical_enabled": runtime.settings.enable_physical,
            "mode": "software-only" if not runtime.settings.enable_physical else "hil",
        }

    @app.get("/api/summary", response_model=DashboardSummary)
    async def summary() -> DashboardSummary:
        jobs = runtime.repository.list_jobs(limit=30)
        active_states = {
            JobState.CREATED,
            JobState.VALIDATING,
            JobState.AWAITING_CONFIRMATION,
            JobState.QUEUED,
            JobState.STARTING,
            JobState.RUNNING,
            JobState.STOPPING,
        }
        report = runtime.doctor.run()
        return DashboardSummary(
            system_status=report.overall,
            physical_enabled=runtime.settings.enable_physical,
            devices=len(runtime.repository.list_entities("device", DeviceRecord)),
            robots=len(runtime.repository.list_entities("robot", RobotProfile)),
            datasets=len(runtime.repository.list_entities("dataset", DatasetManifest)),
            policies=len(runtime.repository.list_entities("policy", PolicyManifest)),
            active_jobs=len([job for job in jobs if job.state in active_states]),
            blocked_jobs=len([job for job in jobs if job.state == JobState.BLOCKED]),
            recent_jobs=jobs[:8],
        )

    @app.get("/api/system/doctor")
    async def doctor() -> dict[str, Any]:
        return runtime.doctor.run().model_dump(mode="json")

    @app.get("/api/system/capabilities")
    async def capabilities() -> dict[str, Any]:
        return runtime.doctor.capabilities().model_dump(mode="json")

    @app.get("/api/system/diagnostics")
    async def diagnostics() -> dict[str, Any]:
        return {
            **diagnostics_payload(runtime.settings),
            "jobs": [job.model_dump(mode="json") for job in runtime.repository.list_jobs(limit=20)],
            "audit": [
                event.model_dump(mode="json") for event in runtime.repository.list_audit(limit=30)
            ],
        }

    @app.get("/api/system/hil-checklist")
    async def hil_checklist() -> dict[str, Any]:
        checks = [
            {
                "id": "workspace",
                "label": "Robot workspace is clear and collision-free",
                "status": "manual",
            },
            {
                "id": "identity",
                "label": "Leader and follower identities are verified",
                "status": "pending",
            },
            {
                "id": "calibration",
                "label": "Calibration backup and revision are verified",
                "status": "pending",
            },
            {
                "id": "limits",
                "label": "Joint and relative target limits are verified",
                "status": "pending",
            },
            {
                "id": "estop",
                "label": "Emergency stop path is tested",
                "status": "pending",
            },
            {
                "id": "power",
                "label": "Power, torque and safe pose are verified",
                "status": "manual",
            },
        ]
        return {
            "physical_enabled": runtime.settings.enable_physical,
            "software_gate": (
                "ready-for-hil" if not runtime.settings.enable_physical else "hil-active"
            ),
            "checks": checks,
        }

    @app.get("/api/workflows")
    async def workflows() -> list[dict[str, Any]]:
        return [
            {
                "kind": kind.value,
                "steps": steps,
                "physical_capable": kind.value
                in {"motor_setup", "calibration", "teleoperation", "replay", "policy_rollout"},
            }
            for kind, steps in WORKFLOW_STEPS.items()
        ]

    @app.post("/api/hardware/command-preview")
    async def hardware_command_preview(request: JobCreateRequest) -> dict[str, Any]:
        try:
            return runtime.hardware.preview(request)
        except PhysicalExecutionError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.post("/api/devices/discover", response_model=list[DeviceRecord])
    async def discover_devices(
        include_simulated: Annotated[bool, Query()] = True,
    ) -> list[DeviceRecord]:
        return runtime.discovery.discover(include_simulated=include_simulated)

    @app.get("/api/devices", response_model=list[DeviceRecord])
    async def devices() -> list[DeviceRecord]:
        return runtime.repository.list_entities("device", DeviceRecord)

    @app.get("/api/robots", response_model=list[RobotProfile])
    async def robots() -> list[RobotProfile]:
        return runtime.repository.list_entities("robot", RobotProfile)

    @app.post("/api/robots", response_model=RobotProfile)
    async def save_robot(profile: RobotProfile) -> RobotProfile:
        runtime.repository.upsert_entity("robot", profile)
        return profile

    @app.get("/api/cameras", response_model=list[CameraProfile])
    async def cameras() -> list[CameraProfile]:
        return runtime.repository.list_entities("camera", CameraProfile)

    @app.post("/api/cameras", response_model=CameraProfile)
    async def save_camera(profile: CameraProfile) -> CameraProfile:
        runtime.repository.upsert_entity("camera", profile)
        return profile

    @app.get("/api/datasets", response_model=list[DatasetManifest])
    async def datasets() -> list[DatasetManifest]:
        return runtime.repository.list_entities("dataset", DatasetManifest)

    @app.post("/api/datasets", response_model=DatasetManifest)
    async def save_dataset(manifest: DatasetManifest) -> DatasetManifest:
        runtime.repository.upsert_entity("dataset", manifest)
        return manifest

    @app.get("/api/policies", response_model=list[PolicyManifest])
    async def policies() -> list[PolicyManifest]:
        return runtime.repository.list_entities("policy", PolicyManifest)

    @app.post("/api/policies", response_model=PolicyManifest)
    async def save_policy(manifest: PolicyManifest) -> PolicyManifest:
        runtime.repository.upsert_entity("policy", manifest)
        return manifest

    @app.get("/api/simulation/scenarios", response_model=list[SimulationScenario])
    async def scenarios() -> list[SimulationScenario]:
        return runtime.repository.list_entities("scenario", SimulationScenario)

    @app.post("/api/simulation/scenarios", response_model=SimulationScenario)
    async def save_scenario(scenario: SimulationScenario) -> SimulationScenario:
        runtime.repository.upsert_entity("scenario", scenario)
        return scenario

    @app.get("/api/remote/endpoints", response_model=list[RemoteEndpoint])
    async def remote_endpoints() -> list[RemoteEndpoint]:
        return runtime.repository.list_entities("remote_endpoint", RemoteEndpoint)

    @app.post("/api/remote/endpoints", response_model=RemoteEndpoint)
    async def save_remote_endpoint(endpoint: RemoteEndpoint) -> RemoteEndpoint:
        runtime.repository.upsert_entity("remote_endpoint", endpoint)
        return endpoint

    @app.get("/api/agents/sessions", response_model=list[AgentSession])
    async def agent_sessions() -> list[AgentSession]:
        return runtime.repository.list_entities("agent_session", AgentSession)

    @app.get("/api/agents/runtime")
    async def agent_runtime() -> dict[str, object]:
        return runtime.strands.status()

    @app.post("/api/agents/commands", response_model=AgentCommandResult)
    async def agent_command(command: AgentCommandRequest) -> AgentCommandResult:
        return await runtime.agents.execute(command)

    @app.post("/api/agents/plan", response_model=AgentPlanResult)
    async def agent_plan(request: AgentPlanRequest) -> AgentPlanResult:
        try:
            return await runtime.strands.plan(request)
        except StrandsRuntimeError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    @app.get("/api/jobs", response_model=list[JobRecord])
    async def jobs(limit: Annotated[int, Query(ge=1, le=500)] = 100) -> list[JobRecord]:
        return runtime.repository.list_jobs(limit=limit)

    @app.get("/api/jobs/{job_id}", response_model=JobRecord)
    async def job(job_id: str) -> JobRecord:
        result = runtime.repository.get_job(job_id)
        if result is None:
            raise HTTPException(status_code=404, detail="Job not found")
        return result

    @app.post("/api/jobs", response_model=JobRecord)
    async def create_job(request: JobCreateRequest) -> JobRecord:
        return await runtime.jobs.submit(request)

    @app.post("/api/jobs/{job_id}/confirm", response_model=JobRecord)
    async def confirm_job(
        job_id: str,
        approval_id: Annotated[str, Body(embed=True)],
    ) -> JobRecord:
        try:
            return await runtime.jobs.confirm(job_id, approval_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail="Job not found") from error
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    @app.post("/api/jobs/{job_id}/cancel", response_model=JobRecord)
    async def cancel_job(job_id: str) -> JobRecord:
        try:
            return await runtime.jobs.cancel(job_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail="Job not found") from error

    @app.post("/api/safety/emergency-stop", response_model=list[JobRecord])
    async def emergency_stop() -> list[JobRecord]:
        return await runtime.jobs.emergency_stop()

    @app.get("/api/audit", response_model=list[AuditEvent])
    async def audit(limit: Annotated[int, Query(ge=1, le=1000)] = 200) -> list[AuditEvent]:
        return runtime.repository.list_audit(limit=limit)

    @app.get("/api/fleet")
    async def fleet() -> dict[str, Any]:
        robots = runtime.repository.list_entities("robot", RobotProfile)
        return {
            "mode": "local-only",
            "cloud_connected": False,
            "robots": [robot.model_dump(mode="json") for robot in robots],
        }

    @app.get("/api/update/status")
    async def update_status() -> dict[str, Any]:
        return {
            "current_version": __version__,
            "channel": "development",
            "update_available": False,
            "network_checked": False,
        }

    @app.websocket("/api/events")
    async def events(websocket: WebSocket) -> None:
        await websocket.accept()
        try:
            while True:
                await websocket.send_json(
                    {
                        "type": "job_snapshot",
                        "jobs": [
                            item.model_dump(mode="json")
                            for item in runtime.repository.list_jobs(limit=30)
                        ],
                        "leases": [
                            item.model_dump(mode="json")
                            for item in runtime.repository.list_leases()
                        ],
                    }
                )
                await asyncio.sleep(0.75)
        except WebSocketDisconnect:
            return

    web_root = Path(__file__).parent / "web"
    index_file = web_root / "index.html"
    if index_file.exists():
        assets_dir = web_root / "assets"
        if assets_dir.exists():
            app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

        @app.get("/", include_in_schema=False)
        async def frontend_index() -> FileResponse:
            return FileResponse(index_file)

        @app.get("/{route:path}", include_in_schema=False)
        async def frontend_fallback(route: str) -> FileResponse:
            if route.startswith("api/"):
                raise HTTPException(status_code=404)
            return FileResponse(index_file)
    else:

        @app.get("/", include_in_schema=False)
        async def no_frontend() -> dict[str, str]:
            return {
                "name": "Hashtag Robotics Control Plane",
                "message": "Frontend assets are not built. Use the API at /docs.",
            }

    return app
