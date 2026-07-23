from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from hashtag_robotics.models import (
    ApprovalStatus,
    AuditEvent,
    JobCreateRequest,
    JobRecord,
    JobState,
    utc_now,
)
from hashtag_robotics.repository import Repository, ResourceBusyError
from hashtag_robotics.safety import SafetyService, parameter_hash
from hashtag_robotics.workflows import WorkflowCancelled, WorkflowEngine

TERMINAL_STATES = {
    JobState.BLOCKED,
    JobState.COMPLETED,
    JobState.FAILED,
    JobState.ABORTED,
    JobState.INTERRUPTED,
}


class JobCoordinator:
    def __init__(
        self,
        repository: Repository,
        safety: SafetyService,
        workflows: WorkflowEngine,
    ) -> None:
        self.repository = repository
        self.safety = safety
        self.workflows = workflows
        self._queue: asyncio.Queue[str | None] = asyncio.Queue()
        self._worker: asyncio.Task[None] | None = None
        self._cancelled: set[str] = set()

    async def start(self) -> None:
        self.repository.recover_incomplete_jobs()
        self._worker = asyncio.create_task(self._worker_loop(), name="hashtag-job-worker")

    async def stop(self) -> None:
        await self._queue.put(None)
        if self._worker is not None:
            await self._worker
            self._worker = None

    async def submit(self, request: JobCreateRequest) -> JobRecord:
        job = JobRecord(
            kind=request.kind,
            target_mode=request.target_mode,
            parameters=request.parameters,
            resources=request.resources,
            requested_by=request.requested_by,
            state=JobState.VALIDATING,
            message="Running deterministic preflight",
        )
        self.repository.create_job(job)
        preflight = self.safety.preflight(request)
        job.result["preflight"] = preflight.model_dump(mode="json")

        if not preflight.allowed:
            job.state = JobState.BLOCKED
            job.message = "Blocked by deterministic preflight"
            job.error_code = "preflight_blocked"
            job.error_message = "; ".join(
                check.message for check in preflight.checks if check.status.value == "blocked"
            )
        elif preflight.requires_approval:
            approval = self.safety.create_approval(job.id, request)
            self.repository.create_approval(approval)
            job.approval_id = approval.id
            job.state = JobState.AWAITING_CONFIRMATION
            job.message = "Waiting for explicit physical actuation approval"
        else:
            job.state = JobState.QUEUED
            job.message = "Queued"

        self.repository.update_job(job)
        self._audit(job, "job.submit", job.state.value)
        if job.state == JobState.QUEUED:
            await self._queue.put(job.id)
        return job

    async def confirm(self, job_id: str, approval_id: str) -> JobRecord:
        job = self.repository.get_job(job_id)
        if job is None:
            raise KeyError(job_id)
        if job.state != JobState.AWAITING_CONFIRMATION or job.approval_id != approval_id:
            raise ValueError("The job is not waiting for this approval.")

        approval = self.repository.get_approval(approval_id)
        if approval is None:
            raise ValueError("Approval was not found.")
        if approval.status != ApprovalStatus.PENDING:
            raise ValueError(f"Approval is '{approval.status.value}'.")
        if approval.expires_at <= datetime.now(UTC):
            self.repository.expire_approval(approval)
            raise ValueError("Approval expired.")

        request = JobCreateRequest(
            kind=job.kind,
            target_mode=job.target_mode,
            parameters=job.parameters,
            resources=job.resources,
            requested_by=job.requested_by,
        )
        if approval.parameters_hash != parameter_hash(request):
            raise ValueError("Job parameters changed after approval was created.")

        preflight = self.safety.preflight(request)
        if not preflight.allowed:
            job.state = JobState.BLOCKED
            job.error_code = "preflight_changed"
            job.error_message = "The safety preflight no longer permits this job."
            job.message = "Blocked after approval revalidation"
        else:
            approval.status = ApprovalStatus.CONFIRMED
            approval.confirmed_at = utc_now()
            self.repository.update_approval(approval)
            job.state = JobState.QUEUED
            job.message = "Approved and queued"
            await self._queue.put(job.id)

        self.repository.update_job(job)
        self._audit(job, "job.confirm", job.state.value)
        return job

    async def cancel(self, job_id: str, actor: str = "local-user") -> JobRecord:
        job = self.repository.get_job(job_id)
        if job is None:
            raise KeyError(job_id)
        if job.state in TERMINAL_STATES:
            return job

        self._cancelled.add(job_id)
        if job.state in {
            JobState.CREATED,
            JobState.VALIDATING,
            JobState.AWAITING_CONFIRMATION,
            JobState.QUEUED,
        }:
            job.state = JobState.ABORTED
            job.message = "Cancelled before execution"
            self.repository.release_leases(job.id)
        else:
            job.state = JobState.STOPPING
            job.message = "Stopping safely"
        self.repository.update_job(job)
        self._audit(job, "job.cancel", job.state.value, actor=actor)
        return job

    async def emergency_stop(self, actor: str = "local-user") -> list[JobRecord]:
        affected: list[JobRecord] = []
        for job in self.repository.list_jobs(limit=500):
            if job.state in {
                JobState.QUEUED,
                JobState.STARTING,
                JobState.RUNNING,
                JobState.STOPPING,
                JobState.AWAITING_CONFIRMATION,
            }:
                affected.append(await self.cancel(job.id, actor=actor))
        event = AuditEvent(
            actor=actor,
            action="safety.emergency_stop",
            target="all-active-jobs",
            correlation_id="emergency-stop",
            outcome="triggered",
            details={"affected_jobs": [job.id for job in affected]},
        )
        self.repository.append_audit(event)
        return affected

    async def _worker_loop(self) -> None:
        while True:
            job_id = await self._queue.get()
            if job_id is None:
                self._queue.task_done()
                break
            try:
                await self._run_job(job_id)
            finally:
                self._queue.task_done()

    async def _run_job(self, job_id: str) -> None:
        job = self.repository.get_job(job_id)
        if job is None or job.state != JobState.QUEUED:
            return

        try:
            job.state = JobState.STARTING
            job.message = "Acquiring resource leases"
            self.repository.update_job(job)
            self.repository.acquire_leases(job.id, job.resources)

            if job.approval_id:
                approval = self.repository.get_approval(job.approval_id)
                if approval and approval.status == ApprovalStatus.CONFIRMED:
                    approval.status = ApprovalStatus.CONSUMED
                    self.repository.update_approval(approval)

            job.state = JobState.RUNNING
            job.message = "Running"
            self.repository.update_job(job)
            self._audit(job, "job.start", "running")

            async def progress(value: float, message: str) -> None:
                current = self.repository.get_job(job.id)
                if current is None:
                    return
                current.progress = value
                current.message = message
                self.repository.update_job(current)
                self.repository.heartbeat_leases(job.id)

            result = await self.workflows.execute(
                job,
                progress=progress,
                cancelled=lambda: job.id in self._cancelled,
            )
            job = self.repository.get_job(job.id) or job
            job.state = JobState.COMPLETED
            job.progress = 1.0
            job.message = "Completed"
            job.result.update(result)
            self.repository.update_job(job)
            self._audit(job, "job.complete", "completed")
        except WorkflowCancelled as error:
            job = self.repository.get_job(job.id) or job
            job.state = JobState.ABORTED
            job.message = "Stopped safely"
            job.error_code = "operator_cancelled"
            job.error_message = str(error)
            self.repository.update_job(job)
            self._audit(job, "job.abort", "aborted")
        except ResourceBusyError as error:
            job.state = JobState.BLOCKED
            job.message = "Required resource is busy"
            job.error_code = "resource_busy"
            job.error_message = str(error)
            self.repository.update_job(job)
            self._audit(job, "job.block", "resource_busy")
        except Exception as error:
            job = self.repository.get_job(job.id) or job
            job.state = JobState.FAILED
            job.message = "Workflow failed safely"
            job.error_code = "workflow_failed"
            job.error_message = str(error)
            self.repository.update_job(job)
            self._audit(job, "job.fail", "failed")
        finally:
            self.repository.release_leases(job.id)
            self._cancelled.discard(job.id)

    def _audit(
        self,
        job: JobRecord,
        action: str,
        outcome: str,
        actor: str | None = None,
    ) -> None:
        self.repository.append_audit(
            AuditEvent(
                actor=actor or job.requested_by,
                action=action,
                target=job.id,
                correlation_id=job.correlation_id,
                outcome=outcome,
                details={
                    "kind": job.kind.value,
                    "target_mode": job.target_mode.value,
                },
            )
        )
