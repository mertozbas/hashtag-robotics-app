#!/bin/zsh

set -euo pipefail

rollout_repo_dir="${0:A:h:h}"
rollout_lerobot_home="$rollout_repo_dir/.local-data/lerobot-data"
rollout_helper="$rollout_repo_dir/.local-data/bin/avfoundation-uid-capture"
rollout_robot_port="/dev/cu.usbmodem5A7C1213581"
rollout_calibration_dir="$rollout_lerobot_home/calibration/robots/so_follower"
rollout_model_dir="$rollout_repo_dir/.local-data/policies/HashtagRobotics--smolvla-tic-tac-toe-games-1-5-80k/d65f5ec4f771b4e6d21c5be78ddc18af242895a6"
rollout_presets_file="$rollout_repo_dir/src/hashtag_robotics/ttt_training_presets.json"

if [[ ! -x "$rollout_helper" ]]; then
  print -u2 -- "Kamera helper bulunamadi veya calistirilabilir degil: $rollout_helper"
  exit 1
fi
if [[ ! -e "$rollout_robot_port" ]]; then
  print -u2 -- "Follower seri portu bulunamadi: $rollout_robot_port"
  exit 1
fi
if [[ ! -f "$rollout_calibration_dir/denizli.json" ]]; then
  print -u2 -- "denizli kalibrasyonu bulunamadi: $rollout_calibration_dir/denizli.json"
  exit 1
fi
if [[ ! -d "$rollout_model_dir" ]]; then
  print -u2 -- "Model checkpoint bulunamadi: $rollout_model_dir"
  exit 1
fi
if [[ ! -f "$rollout_presets_file" ]]; then
  print -u2 -- "Tic-tac-toe eğitim presetleri bulunamadı: $rollout_presets_file"
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  print -u2 -- "Bu script kamera JSON'u icin jq gerektiriyor."
  exit 1
fi
if pgrep -f '[h]ashtag-lerobot-rollout' >/dev/null 2>&1; then
  print -u2 -- "Baska bir rollout process'i zaten calisiyor."
  exit 1
fi
if pgrep -f '[a]vfoundation-uid-capture' >/dev/null 2>&1; then
  print -u2 -- "Kamera helper zaten kullanimda. Dashboard kamera onizlemesini kapat."
  exit 1
fi
if lsof "$rollout_robot_port" >/dev/null 2>&1; then
  print -u2 -- "Follower seri portu baska bir process tarafindan tutuluyor."
  exit 1
fi

rollout_tag="$(date +%Y%m%d_%H%M%S)"
if [[ -n "${TTT_SINGLE_TASK:-}" ]]; then
  rollout_label="${TTT_RUN_LABEL:-single}"
  if [[ -z "$rollout_label" || "$rollout_label" == *[^A-Za-z0-9_-]* ]]; then
    print -u2 -- "TTT_RUN_LABEL yalnizca harf, rakam, alt cizgi ve tire icerebilir."
    exit 1
  fi
  rollout_tasks=("$TTT_SINGLE_TASK")
  rollout_dataset_repo="hashtagrobotics/rollout_tic_tac_toe_80k_single"
  # Keep inference off the 30 Hz control thread, but preserve SmolVLA's
  # complete 50-action chunks. RTC guidance replaces the remaining trajectory
  # every ~8-9 frames on this MPS host; that can prevent a pick/place sequence
  # from ever reaching its gripper phase. With guidance disabled, the same
  # background engine appends each newly inferred chunk instead.
  rollout_inference_args=(
    "--inference.type=rtc"
    "--inference.queue_threshold=18"
    "--inference.rtc.enabled=false"
  )
  rollout_inference_label="async full-chunk"
else
  rollout_label="game"
  rollout_tasks=(
    "put the red X in the middle center cell"
    "put the white O in the bottom center cell"
    "put the red X in the top left cell"
    "put the white O in the bottom right cell"
    "put the red X in the top right cell"
    "put the white O in the middle left cell"
    "put the red X in the middle right cell"
    "put the white O in the top center cell"
    "put the red X in the bottom left cell"
  )
  rollout_dataset_repo="hashtagrobotics/rollout_tic_tac_toe_80k_game"
  # Multi-move mode changes the language task while one process is alive.
  # Keep it synchronous until task switching and RTC chunk generation share
  # an explicit lock; the 18 single-cell launchers all take the RTC branch.
  rollout_inference_args=("--inference.type=sync")
  rollout_inference_label="sync"
fi
rollout_root="$rollout_lerobot_home/hashtagrobotics/rollout_tic_tac_toe_80k_${rollout_label}_$rollout_tag"
rollout_task="${rollout_tasks[1]}"
rollout_tasks_json="$(jq -cn --args '$ARGS.positional' "${rollout_tasks[@]}")"
rollout_piece="${rollout_task#put the }"
rollout_piece="${rollout_piece%% in the *}"
rollout_target_cell="${rollout_task##* in the }"
rollout_target_cell="${rollout_target_cell% cell}"
rollout_preset_json=""
rollout_board_robot=""
rollout_board_camera=""
rollout_demo_episode=""
if (( ${#rollout_tasks[@]} == 1 )); then
  rollout_preset_json="$(jq -ce --arg task "$rollout_task" '.[$task]' "$rollout_presets_file")" || {
    print -u2 -- "Görev için eğitim preseti bulunamadı: $rollout_task"
    exit 1
  }
  rollout_board_robot="$(jq -r '.board_robot' <<<"$rollout_preset_json")"
  rollout_board_camera="$(jq -r '.board_camera' <<<"$rollout_preset_json")"
  rollout_demo_episode="$(jq -r '.episode_index' <<<"$rollout_preset_json")"
fi

rollout_cameras="$(
  jq -cn \
    --arg helper "$rollout_helper" \
    '{
      wrist: {
        type: "avfoundation_uid",
        unique_id: "0x11000005a39230",
        helper_path: $helper,
        fps: 30,
        width: 640,
        height: 480,
        rotation: 0,
        preview_name: "wrist"
      },
      top: {
        type: "avfoundation_uid",
        unique_id: "0x12000005a39230",
        helper_path: $helper,
        fps: 30,
        width: 640,
        height: 480,
        rotation: 0,
        preview_name: "top"
      }
    }'
)"
rollout_rename_map="$(
  jq -cn '{
    "observation.images.top": "observation.images.camera1",
    "observation.images.wrist": "observation.images.camera2"
  }'
)"

print -- "Kayıt klasörü: $rollout_root"
if (( ${#rollout_tasks[@]} == 1 )); then
  print -- "Görev: $rollout_task"
  print -- "Eğitim referansı: episode $rollout_demo_episode"
  print -- "Top kamera görünümünde başlangıç tahtası: $rollout_board_camera"
  for rollout_board_row in ${(s:/:)rollout_board_camera}; do
    print -- "  $rollout_board_row"
  done
  print -- "Model/robot yönündeki aynı tahta: $rollout_board_robot"
  print -- "Ön kontrol: homing sırasında tahta üstü ve robotun süpürme alanı boş olmalı"
  print -- "Q veya sağ ok: denemeyi kaydet, home'a dön, torku kapat ve çık"
else
  print -- "Oyun planı:"
  for ((rollout_index = 1; rollout_index <= ${#rollout_tasks[@]}; rollout_index++)); do
    print -- "  $rollout_index. ${rollout_tasks[$rollout_index]}"
  done
  print -- "Sağ ok: başarılı hamleyi kaydet ve sıradaki prompt'a geç"
  print -- "Q: mevcut hamleyi kaydet, oyunu bitir, home'a dön ve torku kapat"
fi
print -- "Süre sınırı yok | FPS: 30 | inference: $rollout_inference_label | hareket limiti: 5.0"
printf "Robot önce eğitim başlangıç pozuna gidecek. Alan boş ve güç kesme erişilebilir ise HOME yaz: "
IFS= read -r rollout_confirmation
if [[ "$rollout_confirmation" != "HOME" ]]; then
  print -- "Rollout iptal edildi; robot bağlantısı açılmadı."
  exit 1
fi
if (( ${#rollout_tasks[@]} == 1 )); then
  print -- "Homing sonrası ekrandaki tahta düzenini kur; sağ ok ile modeli başlat."
  print -- "Hamle tamamlanınca q veya sağ ok tuşuna bir kez bas."
else
  print -- "Her başarılı hamlede sağ oka bir kez bas; oyun bitince q tuşuna bir kez bas."
fi

cd "$rollout_repo_dir"

rollout_args=(
  "--robot.type=so101_follower"
  "--robot.port=$rollout_robot_port"
  "--robot.id=denizli"
  "--robot.calibration_dir=$rollout_calibration_dir"
  "--robot.max_relative_target=5.0"
  "--robot.disable_torque_on_disconnect=true"
  "--robot.cameras=$rollout_cameras"
  "--policy.path=$rollout_model_dir"
  "--strategy.type=episodic"
  "--strategy.reset_to_initial_position=true"
  "${rollout_inference_args[@]}"
  "--task=$rollout_task"
  "--fps=30"
  "--device=mps"
  "--display_data=false"
  "--play_sounds=false"
  "--return_to_initial_position=true"
  "--rename_map=$rollout_rename_map"
  "--dataset.repo_id=$rollout_dataset_repo"
  "--dataset.single_task=$rollout_task"
  "--dataset.root=$rollout_root"
  "--dataset.fps=30"
  "--dataset.num_episodes=${#rollout_tasks[@]}"
  "--dataset.episode_time_s=86400"
  "--dataset.reset_time_s=0"
  "--dataset.video=true"
  "--dataset.video_encoding_batch_size=1"
  "--dataset.push_to_hub=false"
)

if HASHTAG_ROLLOUT_EPISODE_TASKS_JSON="$rollout_tasks_json" \
  HASHTAG_UNBOUNDED_ROLLOUT=1 \
  HASHTAG_ASYNC_CHUNK_APPEND=1 \
  HASHTAG_TTT_DEMO_PRESET_JSON="$rollout_preset_json" \
  HF_LEROBOT_HOME="$rollout_lerobot_home" \
  uv run hashtag-lerobot-rollout "${rollout_args[@]}"; then
  print -- "Rollout tamamlandı. Dataset: $rollout_root"
else
  rollout_status=$?
  print -u2 -- "Rollout başarısız oldu (exit=$rollout_status). Hedef dataset: $rollout_root"
  exit "$rollout_status"
fi
