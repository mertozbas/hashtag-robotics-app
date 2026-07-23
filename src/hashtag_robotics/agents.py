from __future__ import annotations

from typing import Any

from hashtag_robotics.doctor import DoctorService
from hashtag_robotics.jobs import JobCoordinator
from hashtag_robotics.models import (
    AgentCommandRequest,
    AgentCommandResult,
    AgentSession,
    DatasetManifest,
    JobCreateRequest,
    JobKind,
    PolicyManifest,
    TargetMode,
)
from hashtag_robotics.repository import Repository

ROLE_PERMISSIONS = {
    "lab_assistant": {
        "inspect_lab",
        "inspect_jobs",
        "prepare_discovery",
    },
    "dataset_curator": {
        "inspect_datasets",
        "prepare_dataset_validation",
        "prepare_recording",
    },
    "training_advisor": {
        "inspect_datasets",
        "inspect_policies",
        "prepare_training",
    },
    "evaluation_analyst": {
        "inspect_policies",
        "prepare_evaluation",
    },
    "robot_operator": {
        "inspect_lab",
        "prepare_teleoperation",
        "prepare_recording",
        "request_rollout",
        "stop_job",
    },
}


class AgentGateway:
    def __init__(
        self,
        repository: Repository,
        jobs: JobCoordinator,
        doctor: DoctorService,
    ) -> None:
        self.repository = repository
        self.jobs = jobs
        self.doctor = doctor

    async def execute(self, request: AgentCommandRequest) -> AgentCommandResult:
        session = self.repository.get_entity("agent_session", request.session_id, AgentSession)
        if session is None:
            return AgentCommandResult(
                accepted=False,
                action=request.action,
                message="Agent session was not found.",
            )

        allowed = ROLE_PERMISSIONS.get(session.role, set())
        if request.action not in allowed:
            return AgentCommandResult(
                accepted=False,
                action=request.action,
                message=f"Role '{session.role}' cannot run '{request.action}'.",
            )

        if request.action == "inspect_lab":
            report = self.doctor.run()
            return AgentCommandResult(
                accepted=True,
                action=request.action,
                message="Lab inspection completed without physical access.",
                data=report.model_dump(mode="json"),
            )

        if request.action == "inspect_jobs":
            jobs = self.repository.list_jobs(limit=20)
            return AgentCommandResult(
                accepted=True,
                action=request.action,
                message=f"Found {len(jobs)} recent jobs.",
                data={"jobs": [job.model_dump(mode="json") for job in jobs]},
            )

        if request.action == "inspect_datasets":
            datasets = self.repository.list_entities("dataset", DatasetManifest)
            return AgentCommandResult(
                accepted=True,
                action=request.action,
                message=f"Found {len(datasets)} datasets.",
                data={"datasets": [item.model_dump(mode="json") for item in datasets]},
            )

        if request.action == "inspect_policies":
            policies = self.repository.list_entities("policy", PolicyManifest)
            return AgentCommandResult(
                accepted=True,
                action=request.action,
                message=f"Found {len(policies)} policies.",
                data={"policies": [item.model_dump(mode="json") for item in policies]},
            )

        if request.action == "stop_job":
            job_id = str(request.parameters.get("job_id", ""))
            try:
                job = await self.jobs.cancel(job_id, actor=f"agent:{session.id}")
            except KeyError:
                return AgentCommandResult(
                    accepted=False,
                    action=request.action,
                    message=f"Job '{job_id}' was not found.",
                )
            return AgentCommandResult(
                accepted=True,
                action=request.action,
                message="Stop request passed to the deterministic job coordinator.",
                job=job,
            )

        job_request = self._job_request(session, request.action, request.parameters)
        if job_request is None:
            return AgentCommandResult(
                accepted=False,
                action=request.action,
                message="The command has no registered deterministic workflow.",
            )
        job = await self.jobs.submit(job_request)
        return AgentCommandResult(
            accepted=job.state.value not in {"blocked", "failed"},
            action=request.action,
            message=(
                "The command was converted to a validated job."
                if job.state.value != "blocked"
                else "The deterministic preflight blocked the command."
            ),
            job=job,
        )

    def _job_request(
        self,
        session: AgentSession,
        action: str,
        parameters: dict[str, Any],
    ) -> JobCreateRequest | None:
        parameters = dict(parameters)
        mapping = {
            "prepare_discovery": JobKind.HARDWARE_DISCOVERY,
            "prepare_dataset_validation": JobKind.DATASET_VALIDATE,
            "prepare_recording": JobKind.RECORDING,
            "prepare_training": JobKind.TRAINING,
            "prepare_evaluation": JobKind.EVALUATION,
            "prepare_teleoperation": JobKind.TELEOPERATION,
            "request_rollout": JobKind.POLICY_ROLLOUT,
        }
        kind = mapping.get(action)
        if kind is None:
            return None
        raw_mode = parameters.pop("target_mode", "sim")
        target_mode = TargetMode(raw_mode)
        return JobCreateRequest(
            kind=kind,
            target_mode=target_mode,
            parameters=parameters,
            requested_by=f"agent:{session.id}",
        )
