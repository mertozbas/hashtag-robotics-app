from __future__ import annotations

import asyncio
import importlib.util

from hashtag_robotics.agents import ROLE_PERMISSIONS, AgentGateway
from hashtag_robotics.config import Settings
from hashtag_robotics.models import (
    AgentCommandRequest,
    AgentPlan,
    AgentPlanRequest,
    AgentPlanResult,
    AgentSession,
)
from hashtag_robotics.repository import Repository


class StrandsRuntimeError(RuntimeError):
    pass


class StrandsPlanner:
    """Use Strands for structured planning; execution remains in AgentGateway."""

    def __init__(
        self,
        settings: Settings,
        repository: Repository,
        gateway: AgentGateway,
    ) -> None:
        self.settings = settings
        self.repository = repository
        self.gateway = gateway

    def status(self) -> dict[str, object]:
        installed = importlib.util.find_spec("strands") is not None
        return {
            "installed": installed,
            "model_configured": bool(self.settings.agent_model),
            "model": self.settings.agent_model,
            "execution_boundary": "deterministic-command-gateway",
            "raw_robot_tools_exposed": False,
        }

    async def plan(self, request: AgentPlanRequest) -> AgentPlanResult:
        session = self.repository.get_entity("agent_session", request.session_id, AgentSession)
        if session is None:
            raise StrandsRuntimeError("Agent session was not found.")
        if importlib.util.find_spec("strands") is None:
            raise StrandsRuntimeError("Install the 'agents' feature pack first.")
        if not self.settings.agent_model:
            raise StrandsRuntimeError(
                "Set HASHTAG_AGENT_MODEL before invoking a live Strands model."
            )

        allowed_actions = sorted(ROLE_PERMISSIONS.get(session.role, set()))
        system_prompt = "\n".join(
            [
                "You are a planning component inside Hashtag Robotics.",
                "Return exactly one structured plan using the provided AgentPlan schema.",
                f"Your role is {session.role}.",
                f"Allowed actions: {', '.join(allowed_actions)}.",
                "Never invent raw serial, shell, Python, joint-stream or servo-loop actions.",
                "Prefer read-only inspection and simulation.",
                "Real robot actions always require deterministic preflight and human approval.",
                "Do not claim that a command has executed.",
            ]
        )

        def invoke() -> AgentPlan:
            from strands import Agent

            agent = Agent(
                model=self.settings.agent_model,
                name=session.name,
                system_prompt=system_prompt,
                structured_output_model=AgentPlan,
                tools=[],
                trace_attributes={
                    "hashtag.session_id": session.id,
                    "hashtag.role": session.role,
                },
            )
            result = agent(request.prompt)
            plan = result.structured_output
            if not isinstance(plan, AgentPlan):
                return AgentPlan.model_validate(plan)
            return plan

        plan = await asyncio.to_thread(invoke)
        if plan.action not in allowed_actions:
            raise StrandsRuntimeError(
                f"Planned action '{plan.action}' is outside role '{session.role}'."
            )

        command_result = None
        if request.execute:
            command_result = await self.gateway.execute(
                AgentCommandRequest(
                    session_id=session.id,
                    action=plan.action,
                    parameters=plan.parameters,
                )
            )
        return AgentPlanResult(
            plan=plan,
            executed=request.execute,
            command_result=command_result,
        )
