from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from hashtag_robotics.config import Settings
from hashtag_robotics.models import PolicyManifest
from hashtag_robotics.repository import Repository

CHECKPOINTS_DIR = "checkpoints"
LAST_CHECKPOINT_LINK = "last"
PRETRAINED_MODEL_DIR = "pretrained_model"

STATUS_UNVERIFIED = "unverified"
STATUS_CHECKPOINT_READ = "checkpoint-read"


class PolicyError(RuntimeError):
    pass


class PolicyStore:
    """Reads a LeRobot training output directory instead of trusting the job.

    A checkpoint that was never written cannot produce a manifest, so a failed
    or cancelled training run leaves no policy claiming to exist.
    """

    def __init__(self, settings: Settings, repository: Repository) -> None:
        self.settings = settings
        self.repository = repository

    def latest_checkpoint(self, output_dir: str | Path) -> Path:
        root = Path(output_dir) / CHECKPOINTS_DIR
        if not root.is_dir():
            raise PolicyError(f"No checkpoints directory under '{output_dir}'.")

        link = root / LAST_CHECKPOINT_LINK
        if link.exists():
            resolved = link.resolve()
            if (resolved / PRETRAINED_MODEL_DIR).is_dir():
                return resolved

        steps = sorted(
            (item for item in root.iterdir() if item.is_dir() and item.name.isdigit()),
            key=lambda item: int(item.name),
        )
        for candidate in reversed(steps):
            if (candidate / PRETRAINED_MODEL_DIR).is_dir():
                return candidate
        raise PolicyError(f"No checkpoint with a {PRETRAINED_MODEL_DIR}/ exists under '{root}'.")

    def inspect(self, output_dir: str | Path) -> dict[str, Any]:
        checkpoint = self.latest_checkpoint(output_dir)
        pretrained = checkpoint / PRETRAINED_MODEL_DIR
        weights = pretrained / "model.safetensors"
        config = self._read_json(pretrained / "config.json")
        train_config = self._read_json(pretrained / "train_config.json")

        report: dict[str, Any] = {
            "output_dir": str(Path(output_dir)),
            "checkpoint_dir": str(pretrained),
            "step": int(checkpoint.name) if checkpoint.name.isdigit() else None,
            "policy_type": config.get("type") or train_config.get("policy", {}).get("type"),
            "weights_present": weights.is_file(),
            "weights_bytes": weights.stat().st_size if weights.is_file() else 0,
            "has_processor": (pretrained / "processor.json").is_file(),
            "source_repo_id": train_config.get("dataset", {}).get("repo_id"),
            "training_steps": train_config.get("steps"),
            "batch_size": train_config.get("batch_size"),
            "device": train_config.get("policy", {}).get("device"),
            "input_features": sorted(self._feature_names(config.get("input_features"))),
            "output_features": sorted(self._feature_names(config.get("output_features"))),
            "action_shape": self._shape_of(config.get("output_features"), "action"),
        }
        if not report["weights_present"]:
            raise PolicyError(f"Checkpoint '{pretrained}' has no model.safetensors.")
        return report

    def _read_json(self, path: Path) -> dict[str, Any]:
        if not path.is_file():
            return {}
        try:
            payload = json.loads(path.read_text())
        except json.JSONDecodeError:
            return {}
        return payload if isinstance(payload, dict) else {}

    def _feature_names(self, features: Any) -> list[str]:
        if isinstance(features, dict):
            return [str(key) for key in features]
        if isinstance(features, list):
            return [str(item) for item in features]
        return []

    def _shape_of(self, features: Any, key: str) -> list[int]:
        if isinstance(features, dict):
            entry = features.get(key)
            if isinstance(entry, dict):
                return [int(value) for value in entry.get("shape", []) or []]
        return []

    def manifest(
        self,
        report: dict[str, Any],
        *,
        name: str,
        source_dataset_id: str | None = None,
        camera_mapping: dict[str, str] | None = None,
        runtime: str = "lerobot-local",
    ) -> PolicyManifest:
        cameras = {
            key.rsplit(".", 1)[-1]: key
            for key in report["input_features"]
            if key.startswith("observation.images.")
        }
        manifest = PolicyManifest(
            name=name,
            policy_type=str(report.get("policy_type") or "unknown"),
            checkpoint=report["checkpoint_dir"],
            checkpoint_step=report.get("step"),
            source_dataset_id=source_dataset_id,
            source_repo_id=report.get("source_repo_id"),
            expected_features=list(report["input_features"] + report["output_features"]),
            processor_chain=["lerobot-processor"] if report["has_processor"] else [],
            action_shape=report["action_shape"],
            camera_mapping=dict(camera_mapping or cameras),
            runtime=runtime,
            training_steps=report.get("training_steps"),
            compatibility_status=STATUS_CHECKPOINT_READ,
            evaluation_summary={},
        )
        self.repository.upsert_entity("policy", manifest)
        return manifest
