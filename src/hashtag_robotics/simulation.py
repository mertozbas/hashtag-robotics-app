from __future__ import annotations

import importlib.util
import math
from typing import Any

from hashtag_robotics.models import SimulationScenario

SO101_CONTRACT_MJCF = """
<mujoco model="hashtag_so101_contract">
  <compiler angle="radian"/>
  <option timestep="0.002" gravity="0 0 -9.81"/>
  <default>
    <joint damping="1.5" armature="0.02"/>
    <geom type="capsule" size="0.018" rgba="0.42 0.58 0.22 1"/>
    <position kp="28" kv="3"/>
  </default>
  <worldbody>
    <light pos="0 -1 2" dir="0 0 -1"/>
    <geom name="floor" type="plane" size="1 1 0.05" rgba="0.08 0.1 0.08 1"/>
    <camera name="front" pos="0.7 -0.8 0.55" xyaxes="0.75 0.66 0 -0.28 0.32 0.9"/>
    <body name="base" pos="0 0 0.035">
      <geom type="cylinder" size="0.07 0.035" rgba="0.15 0.2 0.14 1"/>
      <body name="shoulder_pan_link" pos="0 0 0.04">
        <joint name="shoulder_pan" axis="0 0 1" range="-1.9 1.9"/>
        <geom fromto="0 0 0 0 0 0.10"/>
        <body name="shoulder_lift_link" pos="0 0 0.10">
          <joint name="shoulder_lift" axis="0 1 0" range="-1.7 1.7"/>
          <geom fromto="0 0 0 0 0 0.16"/>
          <body name="elbow_link" pos="0 0 0.16">
            <joint name="elbow_flex" axis="0 1 0" range="-1.9 1.9"/>
            <geom fromto="0 0 0 0 0 0.15"/>
            <body name="wrist_flex_link" pos="0 0 0.15">
              <joint name="wrist_flex" axis="0 1 0" range="-1.8 1.8"/>
              <geom fromto="0 0 0 0 0 0.09"/>
              <body name="wrist_roll_link" pos="0 0 0.09">
                <joint name="wrist_roll" axis="0 0 1" range="-2.8 2.8"/>
                <geom fromto="0 0 0 0 0 0.06"/>
                <body name="gripper_link" pos="0 0 0.06">
                  <joint name="gripper" axis="0 1 0" range="0 1.2"/>
                  <geom fromto="0 0 0 0 0 0.045" size="0.012"/>
                </body>
              </body>
            </body>
          </body>
        </body>
      </body>
    </body>
  </worldbody>
  <actuator>
    <position joint="shoulder_pan" ctrlrange="-1.9 1.9"/>
    <position joint="shoulder_lift" ctrlrange="-1.7 1.7"/>
    <position joint="elbow_flex" ctrlrange="-1.9 1.9"/>
    <position joint="wrist_flex" ctrlrange="-1.8 1.8"/>
    <position joint="wrist_roll" ctrlrange="-2.8 2.8"/>
    <position joint="gripper" ctrlrange="0 1.2"/>
  </actuator>
</mujoco>
"""


class MujocoContractAdapter:
    def available(self) -> bool:
        return importlib.util.find_spec("mujoco") is not None

    def run(
        self,
        scenario: SimulationScenario,
        control_ticks: int = 180,
        control_hz: int = 30,
    ) -> dict[str, Any]:
        if not self.available():
            raise RuntimeError("MuJoCo feature pack is not installed.")

        import mujoco

        model = mujoco.MjModel.from_xml_string(SO101_CONTRACT_MJCF)
        data = mujoco.MjData(model)
        physics_hz = round(1 / model.opt.timestep)
        substeps = max(1, round(physics_hz / control_hz))
        previous = [float(value) for value in data.qpos]
        max_joint_delta = 0.0
        constraint_violations = 0

        for tick in range(control_ticks):
            phase = tick / max(1, control_ticks - 1)
            targets = [
                0.35 * math.sin(phase * math.tau),
                0.25 * math.sin(phase * math.tau + 0.4),
                -0.3 * math.sin(phase * math.tau + 0.8),
                0.2 * math.sin(phase * math.tau + 1.2),
                0.4 * math.sin(phase * math.tau + 1.6),
                0.5 + 0.2 * math.sin(phase * math.tau),
            ]
            for index, target in enumerate(targets):
                data.ctrl[index] = target
            for _ in range(substeps):
                mujoco.mj_step(model, data)

            current = [float(value) for value in data.qpos]
            max_joint_delta = max(
                max_joint_delta,
                max(abs(value - previous[index]) for index, value in enumerate(current)),
            )
            previous = current
            for joint_index, value in enumerate(current):
                low, high = model.jnt_range[joint_index]
                if value < low - 1e-5 or value > high + 1e-5:
                    constraint_violations += 1

        return {
            "scenario_id": scenario.id,
            "backend": "mujoco",
            "model": "hashtag-so101-contract-v1",
            "control_ticks": control_ticks,
            "control_hz": control_hz,
            "physics_hz": physics_hz,
            "max_joint_delta": round(max_joint_delta, 6),
            "constraint_violations": constraint_violations,
            "camera_count": model.ncam,
            "joint_names": [
                "shoulder_pan",
                "shoulder_lift",
                "elbow_flex",
                "wrist_flex",
                "wrist_roll",
                "gripper",
            ],
            "warning": "Contract model only; it is not a validated SO-101 digital twin.",
        }
