from __future__ import annotations

import re
from collections import deque
from statistics import median
from typing import Any

from hashtag_robotics.models import JobInputKey, TelemetryKind, TelemetrySample

ANSI_PATTERN = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")

LOOP_PATTERN = re.compile(r"Teleop loop time:\s*([0-9.]+)\s*ms\s*\(\s*([0-9.]+)\s*Hz\s*\)")
JOINT_HEADER = re.compile(r"^NAME\s*\|\s*NORM$")
RANGE_HEADER = re.compile(r"^NAME\s*\|\s*MIN\s*\|\s*POS\s*\|\s*MAX$")
JOINT_ROW = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)\s*\|\s*(-?[0-9]+\.[0-9]+)$")
RANGE_ROW = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)\s*\|\s*(-?\d+)\s*\|\s*(-?\d+)\s*\|\s*(-?\d+)$")

EPISODE_PATTERN = re.compile(r"Recording episode\s+(\d+)")
RESET_PATTERN = re.compile(r"Reset the environment")
RERECORD_PATTERN = re.compile(r"Re-record episode")
STOP_PATTERN = re.compile(r"Stop recording")
SAVED_PATTERN = re.compile(r"Calibration saved to\s+(\S+)")

CHOICE_PROMPT = re.compile(r"type 'c' and press ENTER", re.IGNORECASE)
ENTER_PROMPT = re.compile(r"press ENTER", re.IGNORECASE)


class TelemetryError(RuntimeError):
    pass


def strip_ansi(value: str) -> str:
    return ANSI_PATTERN.sub("", value).replace("\r", "")


class TelemetryParser:
    def __init__(self) -> None:
        self._mode: str | None = None
        self._joints: dict[str, float] = {}
        self._ranges: dict[str, dict[str, int]] = {}

    def feed(self, line: str) -> list[TelemetrySample]:
        text = strip_ansi(line).strip()
        if JOINT_HEADER.match(text):
            samples = self._flush()
            self._mode = "joints"
            self._joints = {}
            return samples
        if RANGE_HEADER.match(text):
            samples = self._flush()
            self._mode = "ranges"
            self._ranges = {}
            return samples

        if self._mode == "joints":
            row = JOINT_ROW.match(text)
            if row:
                self._joints[row.group(1)] = float(row.group(2))
                return []
        if self._mode == "ranges":
            row = RANGE_ROW.match(text)
            if row:
                self._ranges[row.group(1)] = {
                    "min": int(row.group(2)),
                    "pos": int(row.group(3)),
                    "max": int(row.group(4)),
                }
                return []

        samples = self._flush()
        event = self._event(text)
        if event is not None:
            samples.append(event)
        return samples

    def _flush(self) -> list[TelemetrySample]:
        samples: list[TelemetrySample] = []
        if self._mode == "joints" and self._joints:
            samples.append(TelemetrySample(kind=TelemetryKind.JOINTS, joints=dict(self._joints)))
        if self._mode == "ranges" and self._ranges:
            samples.append(
                TelemetrySample(
                    kind=TelemetryKind.CALIBRATION_RANGE,
                    ranges={motor: dict(values) for motor, values in self._ranges.items()},
                )
            )
        self._mode = None
        return samples

    def _event(self, text: str) -> TelemetrySample | None:
        if not text:
            return None

        loop = LOOP_PATTERN.search(text)
        if loop:
            return TelemetrySample(
                kind=TelemetryKind.LOOP,
                loop_ms=float(loop.group(1)),
                hz=float(loop.group(2)),
            )

        if CHOICE_PROMPT.search(text):
            return TelemetrySample(
                kind=TelemetryKind.PROMPT,
                prompt=text,
                expects=JobInputKey.RECALIBRATE,
            )
        if ENTER_PROMPT.search(text):
            return TelemetrySample(
                kind=TelemetryKind.PROMPT,
                prompt=text,
                expects=JobInputKey.ENTER,
            )

        episode = EPISODE_PATTERN.search(text)
        if episode:
            return TelemetrySample(
                kind=TelemetryKind.EPISODE,
                episode=int(episode.group(1)),
                phase="recording",
                message=text,
            )
        for pattern, phase in (
            (RERECORD_PATTERN, "rerecord"),
            (RESET_PATTERN, "reset"),
            (STOP_PATTERN, "stopping"),
        ):
            if pattern.search(text):
                return TelemetrySample(kind=TelemetryKind.EPISODE, phase=phase, message=text)

        saved = SAVED_PATTERN.search(text)
        if saved:
            return TelemetrySample(
                kind=TelemetryKind.NOTICE,
                phase="calibration_saved",
                message=saved.group(1),
            )
        return None


class TelemetryBuffer:
    def __init__(self, capacity: int = 240) -> None:
        self._samples: deque[TelemetrySample] = deque(maxlen=capacity)
        self._loop_ms: deque[float] = deque(maxlen=capacity)

    def append(self, sample: TelemetrySample) -> None:
        self._samples.append(sample)
        if sample.loop_ms is not None:
            self._loop_ms.append(sample.loop_ms)

    def latest(self, kind: TelemetryKind) -> TelemetrySample | None:
        for sample in reversed(self._samples):
            if sample.kind == kind:
                return sample
        return None

    def summary(self) -> dict[str, Any]:
        joints = self.latest(TelemetryKind.JOINTS)
        ranges = self.latest(TelemetryKind.CALIBRATION_RANGE)
        prompt = self.latest(TelemetryKind.PROMPT)
        episode = self.latest(TelemetryKind.EPISODE)
        return {
            "samples": len(self._samples),
            "p50_loop_ms": _percentile(self._loop_ms, 0.5),
            "p95_loop_ms": _percentile(self._loop_ms, 0.95),
            "joints": joints.joints if joints else {},
            "ranges": ranges.ranges if ranges else {},
            "prompt": prompt.model_dump(mode="json") if prompt else None,
            "episode": episode.model_dump(mode="json") if episode else None,
        }


def _percentile(values: deque[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    if fraction <= 0.5:
        return round(median(ordered), 3)
    index = min(len(ordered) - 1, int(round(fraction * (len(ordered) - 1))))
    return round(ordered[index], 3)
