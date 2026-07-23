from __future__ import annotations

import pytest

from hashtag_robotics.models import SimulationScenario
from hashtag_robotics.simulation import MujocoContractAdapter


def test_mujoco_contract_stays_inside_joint_limits() -> None:
    adapter = MujocoContractAdapter()
    if not adapter.available():
        pytest.skip("MuJoCo feature pack is not installed.")
    result = adapter.run(
        SimulationScenario(
            id="test-scenario",
            name="Test scenario",
            backend="mujoco",
        ),
        control_ticks=30,
        control_hz=30,
    )
    assert result["backend"] == "mujoco"
    assert result["constraint_violations"] == 0
    assert len(result["joint_names"]) == 6
    assert result["camera_count"] == 1
