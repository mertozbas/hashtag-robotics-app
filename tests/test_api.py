from __future__ import annotations

import time

from fastapi.testclient import TestClient


def wait_for_terminal(client: TestClient, job_id: str, timeout: float = 2.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        payload = client.get(f"/api/jobs/{job_id}").json()
        if payload["state"] in {"completed", "failed", "blocked", "aborted", "interrupted"}:
            return payload
        time.sleep(0.01)
    raise AssertionError(f"Job {job_id} did not reach a terminal state.")


def test_health_summary_and_seeded_profiles(client: TestClient) -> None:
    health = client.get("/api/health")
    assert health.status_code == 200
    assert health.json()["mode"] == "software-only"

    summary = client.get("/api/summary").json()
    assert summary["physical_enabled"] is False
    assert summary["robots"] == 1
    assert summary["policies"] == 1

    robots = client.get("/api/robots").json()
    assert robots[0]["target_mode"] == "sim"
    assert robots[0]["calibration_verified"] is True


def test_read_only_discovery_persists_safe_simulated_devices(client: TestClient) -> None:
    response = client.post("/api/devices/discover?include_simulated=true")
    assert response.status_code == 200
    devices = response.json()
    assert any(device["id"] == "sim_so101" for device in devices)
    assert any(device["kind"] == "gpu" for device in devices)

    inventory = client.get("/api/devices").json()
    assert len(inventory) >= 2


def test_simulation_job_completes_and_is_audited(client: TestClient) -> None:
    response = client.post(
        "/api/jobs",
        json={
            "kind": "simulation",
            "target_mode": "sim",
            "parameters": {"scenario_id": "scenario_tabletop"},
            "resources": [
                {
                    "resource_id": "sim-so101",
                    "resource_type": "robot",
                    "mode": "exclusive",
                }
            ],
            "requested_by": "test",
        },
    )
    assert response.status_code == 200
    job = wait_for_terminal(client, response.json()["id"])
    assert job["state"] == "completed"
    assert job["result"]["constraint_violations"] == 0

    audit = client.get("/api/audit").json()
    actions = {event["action"] for event in audit}
    assert {"job.submit", "job.start", "job.complete"} <= actions


def test_real_teleoperation_is_blocked_before_hil(client: TestClient) -> None:
    response = client.post(
        "/api/jobs",
        json={
            "kind": "teleoperation",
            "target_mode": "real",
            "parameters": {
                "calibration_verified": True,
                "joint_limits_verified": True,
                "emergency_stop_ready": True,
                "robot_port": "/dev/example-follower",
                "robot_id": "follower",
                "teleop_port": "/dev/example-leader",
                "teleop_id": "leader",
            },
            "resources": [
                {
                    "resource_id": "follower",
                    "resource_type": "robot",
                    "mode": "exclusive",
                },
                {
                    "resource_id": "leader",
                    "resource_type": "teleoperator",
                    "mode": "exclusive",
                },
            ],
            "requested_by": "test",
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["state"] == "blocked"
    assert payload["error_code"] == "preflight_blocked"
    assert "locked" in payload["error_message"].lower()


def test_record_validate_train_and_evaluate_workflow(client: TestClient) -> None:
    recording_response = client.post(
        "/api/jobs",
        json={
            "kind": "recording",
            "target_mode": "sim",
            "parameters": {
                "name": "Contract dataset",
                "task": "Move the test cube",
                "episodes": 4,
                "fps": 30,
                "camera_mapping": {"front": "observation.images.front"},
            },
            "resources": [],
            "requested_by": "test",
        },
    )
    recording = wait_for_terminal(client, recording_response.json()["id"])
    assert recording["state"] == "completed"

    datasets = client.get("/api/datasets").json()
    assert len(datasets) == 1
    dataset = datasets[0]
    assert dataset["episodes"] == 4
    assert dataset["integrity_status"] == "verified"

    validation_response = client.post(
        "/api/jobs",
        json={
            "kind": "dataset_validate",
            "target_mode": "read_only",
            "parameters": {"dataset_id": dataset["id"]},
            "resources": [],
            "requested_by": "test",
        },
    )
    validation = wait_for_terminal(client, validation_response.json()["id"])
    assert validation["result"]["feature_count"] == 3

    training_response = client.post(
        "/api/jobs",
        json={
            "kind": "training",
            "target_mode": "sim",
            "parameters": {
                "dataset_id": dataset["id"],
                "policy_type": "act",
                "action_shape": [6],
            },
            "resources": [],
            "requested_by": "test",
        },
    )
    training = wait_for_terminal(client, training_response.json()["id"])
    assert training["state"] == "completed"

    policies = client.get("/api/policies").json()
    trained = next(item for item in policies if item["id"] == training["result"]["policy_id"])
    assert trained["source_dataset_id"] == dataset["id"]

    evaluation_response = client.post(
        "/api/jobs",
        json={
            "kind": "evaluation",
            "target_mode": "sim",
            "parameters": {
                "policy_id": trained["id"],
                "episodes": 5,
                "feature_mapping_verified": True,
            },
            "resources": [],
            "requested_by": "test",
        },
    )
    evaluation = wait_for_terminal(client, evaluation_response.json()["id"])
    assert evaluation["state"] == "completed"
    assert evaluation["result"]["episodes"] == 5
    assert evaluation["result"]["successes"] == 4


def test_agent_permissions_and_deterministic_job_conversion(client: TestClient) -> None:
    denied = client.post(
        "/api/agents/commands",
        json={
            "session_id": "agent_lab_assistant",
            "action": "prepare_training",
            "parameters": {"target_mode": "sim"},
        },
    ).json()
    assert denied["accepted"] is False

    inspection = client.post(
        "/api/agents/commands",
        json={
            "session_id": "agent_lab_assistant",
            "action": "inspect_lab",
            "parameters": {},
        },
    ).json()
    assert inspection["accepted"] is True
    assert "capabilities" in inspection["data"]

    command = client.post(
        "/api/agents/commands",
        json={
            "session_id": "agent_training_advisor",
            "action": "prepare_training",
            "parameters": {"target_mode": "sim", "policy_type": "act"},
        },
    ).json()
    assert command["accepted"] is True
    job = wait_for_terminal(client, command["job"]["id"])
    assert job["state"] == "completed"


def test_strands_runtime_is_optional_and_requires_explicit_model(client: TestClient) -> None:
    runtime = client.get("/api/agents/runtime")
    assert runtime.status_code == 200
    assert runtime.json()["execution_boundary"] == "deterministic-command-gateway"
    assert runtime.json()["raw_robot_tools_exposed"] is False

    response = client.post(
        "/api/agents/plan",
        json={
            "session_id": "agent_lab_assistant",
            "prompt": "Inspect the lab safely.",
            "execute": False,
        },
    )
    assert response.status_code == 409
    assert "HASHTAG_AGENT_MODEL" in response.json()["detail"]


def test_remote_probe_rejects_plaintext_endpoint(client: TestClient) -> None:
    response = client.post(
        "/api/jobs",
        json={
            "kind": "remote_inference_probe",
            "target_mode": "sim",
            "parameters": {"url": "http://unsafe.example", "tls_required": True},
            "resources": [],
            "requested_by": "test",
        },
    )
    job = wait_for_terminal(client, response.json()["id"])
    assert job["state"] == "failed"
    assert "TLS" in job["error_message"]


def test_emergency_stop_aborts_queued_or_active_jobs(client: TestClient) -> None:
    response = client.post(
        "/api/jobs",
        json={
            "kind": "simulation",
            "target_mode": "sim",
            "parameters": {},
            "resources": [],
            "requested_by": "test",
        },
    )
    job_id = response.json()["id"]
    stopped = client.post("/api/safety/emergency-stop")
    assert stopped.status_code == 200
    job = wait_for_terminal(client, job_id)
    assert job["state"] in {"aborted", "completed"}
