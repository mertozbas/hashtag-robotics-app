from __future__ import annotations

from hashtag_robotics.models import JobInputKey, TelemetryKind
from hashtag_robotics.telemetry import TelemetryBuffer, TelemetryParser, strip_ansi

TELEOP_BLOCK = """
------------------------
NAME             |    NORM
shoulder_pan     |   12.34
shoulder_lift    |  -45.60
elbow_flex       |    0.00
wrist_flex       |    3.20
wrist_roll       |   -8.75
gripper          |   50.00
Teleop loop time: 12.34ms (81 Hz)
"""

CALIBRATION_BLOCK = """
-------------------------------------------
NAME            |    MIN |    POS |    MAX
shoulder_pan    |   1114 |   2000 |   3027
shoulder_lift   |    800 |   1600 |   3168
"""

MIDDLE_PROMPT = (
    "Move follower01 SOFollower to the middle of its range of motion and press ENTER...."
)
EXISTING_PROMPT = (
    "Press ENTER to use provided calibration file associated with the id follower01, "
    "or type 'c' and press ENTER to run calibration: "
)
MOTOR_PROMPT = "Connect the controller board to the 'gripper' motor only and press enter."


def collect(lines: list[str]) -> list:
    parser = TelemetryParser()
    samples = []
    for line in lines:
        samples.extend(parser.feed(line))
    samples.extend(parser.feed(""))
    return samples


def test_strip_ansi_removes_cursor_movement() -> None:
    assert strip_ansi("\x1b[9Ashoulder_pan | 1114") == "shoulder_pan | 1114"


def test_teleop_block_yields_joints_and_loop_timing() -> None:
    samples = collect(TELEOP_BLOCK.splitlines())
    joints = next(sample for sample in samples if sample.kind == TelemetryKind.JOINTS)
    loop = next(sample for sample in samples if sample.kind == TelemetryKind.LOOP)
    assert joints.joints["shoulder_pan"] == 12.34
    assert joints.joints["shoulder_lift"] == -45.6
    assert len(joints.joints) == 6
    assert loop.loop_ms == 12.34
    assert loop.hz == 81.0


def test_calibration_block_yields_live_ranges() -> None:
    samples = collect(CALIBRATION_BLOCK.splitlines())
    ranges = next(sample for sample in samples if sample.kind == TelemetryKind.CALIBRATION_RANGE)
    assert ranges.ranges["shoulder_pan"] == {"min": 1114, "pos": 2000, "max": 3027}
    assert ranges.ranges["shoulder_lift"]["max"] == 3168


def test_calibration_ranges_survive_cursor_up_escapes() -> None:
    lines = ["\x1b[9A" + line for line in CALIBRATION_BLOCK.splitlines()]
    samples = collect(lines)
    ranges = next(sample for sample in samples if sample.kind == TelemetryKind.CALIBRATION_RANGE)
    assert ranges.ranges["shoulder_pan"]["pos"] == 2000


def test_prompts_declare_the_expected_operator_key() -> None:
    samples = collect([MIDDLE_PROMPT, MOTOR_PROMPT, EXISTING_PROMPT])
    prompts = [sample for sample in samples if sample.kind == TelemetryKind.PROMPT]
    assert [sample.expects for sample in prompts] == [
        JobInputKey.ENTER,
        JobInputKey.ENTER,
        JobInputKey.RECALIBRATE,
    ]


def test_recording_phases_are_tracked() -> None:
    samples = collect(
        [
            "INFO 2026-07-29 22:00:00 lerobot_record.py:471 Recording episode 0",
            "INFO 2026-07-29 22:00:19 lerobot_record.py:492 Reset the environment",
            "INFO 2026-07-29 22:00:29 lerobot_record.py:471 Recording episode 1",
            "INFO 2026-07-29 22:00:48 lerobot_record.py:517 Stop recording",
        ]
    )
    episodes = [sample for sample in samples if sample.kind == TelemetryKind.EPISODE]
    assert [sample.phase for sample in episodes] == [
        "recording",
        "reset",
        "recording",
        "stopping",
    ]
    assert episodes[2].episode == 1


def test_calibration_saved_path_is_reported() -> None:
    samples = collect(["Calibration saved to /tmp/hashtag/calibration/follower01.json"])
    notice = next(sample for sample in samples if sample.kind == TelemetryKind.NOTICE)
    assert notice.message == "/tmp/hashtag/calibration/follower01.json"


def test_buffer_summary_reports_latency_percentiles_and_latest_state() -> None:
    buffer = TelemetryBuffer()
    parser = TelemetryParser()
    for line in TELEOP_BLOCK.splitlines():
        for sample in parser.feed(line):
            buffer.append(sample)
    for loop_ms in (10.0, 20.0, 30.0, 40.0):
        for sample in parser.feed(f"Teleop loop time: {loop_ms}ms (30 Hz)"):
            buffer.append(sample)

    summary = buffer.summary()
    assert summary["p50_loop_ms"] is not None
    assert summary["p95_loop_ms"] >= summary["p50_loop_ms"]
    assert summary["joints"]["gripper"] == 50.0
    assert summary["prompt"] is None
