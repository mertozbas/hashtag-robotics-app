from __future__ import annotations

import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LAUNCHERS = ROOT / "ttt-rollouts"
PRESETS = ROOT / "src" / "hashtag_robotics" / "ttt_training_presets.json"
CELLS = {
    1: "top left",
    2: "top center",
    3: "top right",
    4: "middle left",
    5: "middle center",
    6: "middle right",
    7: "bottom left",
    8: "bottom center",
    9: "bottom right",
}


def test_all_eighteen_tic_tac_toe_launchers_are_present_and_executable() -> None:
    expected = {f"{piece}-{cell}" for piece in ("X", "O") for cell in CELLS}
    actual = {path.name for path in LAUNCHERS.iterdir() if path.is_file()}

    assert actual == expected
    assert all(os.access(LAUNCHERS / name, os.X_OK) for name in expected)


def test_each_launcher_uses_the_exact_training_task_for_its_cell() -> None:
    for piece, object_name in (("X", "red X"), ("O", "white O")):
        for cell_number, cell_name in CELLS.items():
            name = f"{piece}-{cell_number}"
            source = (LAUNCHERS / name).read_text()

            assert f'TTT_RUN_LABEL="{name}"' in source
            assert f'TTT_SINGLE_TASK="put the {object_name} in the {cell_name} cell"' in source
            assert "run_ttt_recorded_rollout.zsh" in source


def test_single_cell_launchers_use_async_full_chunks_without_relaxing_the_safety_limit() -> None:
    runner = (ROOT / "scripts" / "run_ttt_recorded_rollout.zsh").read_text()

    assert '"--inference.type=rtc"' in runner
    assert '"--inference.queue_threshold=18"' in runner
    assert '"--inference.rtc.enabled=false"' in runner
    assert '"--inference.rtc.execution_horizon=10"' not in runner
    assert '"--inference.rtc.max_guidance_weight=10.0"' not in runner
    assert '"--robot.max_relative_target=5.0"' in runner
    assert 'rollout_inference_label="async full-chunk"' in runner
    assert "HASHTAG_ASYNC_CHUNK_APPEND=1" in runner


def test_runner_requires_the_target_cell_to_be_empty_before_move_confirmation() -> None:
    runner = (ROOT / "scripts" / "run_ttt_recorded_rollout.zsh").read_text()

    assert "rollout_target_cell=" in runner
    assert "ttt_training_presets.json" in runner
    assert "HASHTAG_TTT_DEMO_PRESET_JSON" in runner
    assert "Robot önce eğitim başlangıç pozuna gidecek" in runner
    assert '!= "HOME"' in runner


def test_all_launchers_have_an_in_distribution_training_preset() -> None:
    presets = json.loads(PRESETS.read_text())
    expected_tasks = {
        f"put the {piece} in the {cell} cell"
        for piece in ("red X", "white O")
        for cell in CELLS.values()
    }

    assert set(presets) == expected_tasks
    for task, preset in presets.items():
        assert isinstance(preset["episode_index"], int)
        assert len(preset["start_pose"]) == 6
        robot_rows = preset["board_robot"].split("/")
        camera_rows = preset["board_camera"].split("/")
        assert len(robot_rows) == len(camera_rows) == 3
        assert all(len(row) == 3 and set(row) <= set("XO.") for row in robot_rows)
        assert camera_rows == [row[::-1] for row in robot_rows[::-1]]

        cell_name = task.removesuffix(" cell").rsplit(" in the ", 1)[1]
        cell_index = list(CELLS.values()).index(cell_name)
        assert "".join(robot_rows)[cell_index] == "."
