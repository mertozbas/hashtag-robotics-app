#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$project_root"
npm --prefix frontend run build
uv build

wheel_path="$(find dist -maxdepth 1 -name 'hashtag_robotics-*.whl' -print -quit)"
if [[ -z "$wheel_path" ]]; then
  echo "Wheel was not produced." >&2
  exit 1
fi

if ! unzip -l "$wheel_path" | grep -q 'hashtag_robotics/web/index.html'; then
  echo "Dashboard assets are missing from the wheel." >&2
  exit 1
fi

echo "Package ready: $wheel_path"
