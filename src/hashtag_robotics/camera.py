from __future__ import annotations

import contextlib
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from hashtag_robotics.config import Settings
from hashtag_robotics.discovery import DiscoveryService
from hashtag_robotics.models import CameraProfile, DeviceKind, DeviceRecord
from hashtag_robotics.repository import Repository

MJPEG_BOUNDARY = "hashtagframe"
MJPEG_CONTENT_TYPE = f"multipart/x-mixed-replace; boundary={MJPEG_BOUNDARY}"

# Formats worth trying on a UVC webcam: compressed first, raw as the fallback.
CANDIDATE_FOURCC = ("MJPG", "YUYV")

# Frames discarded before timing starts, so stream start-up is not charged to
# the format under test.
WARMUP_FRAMES = 5

# A format has to be meaningfully faster before it is worth recommending.
FORMAT_GAIN_THRESHOLD = 1.15

# Drivers rarely hit a requested rate exactly; this is the band we call "met".
FPS_TOLERANCE = 0.95


class CameraError(RuntimeError):
    pass


def load_cv2() -> Any:
    """Import OpenCV lazily so the control plane still starts without it."""
    try:
        import cv2
    except ImportError as error:  # pragma: no cover - exercised only without the extra
        raise CameraError(
            "OpenCV is not installed. Install the [so101] extra to use camera features."
        ) from error
    return cv2


class CameraService:
    """Opens cameras by their stable /dev/v4l/by-id path, never by index.

    A V4L2 device can only be opened by one consumer at a time, so every
    preview and every recording takes an exclusive lease on the camera; the
    capture handle is released in a finally block on every path.
    """

    def __init__(
        self,
        settings: Settings,
        repository: Repository,
        discovery: DiscoveryService,
    ) -> None:
        self.settings = settings
        self.repository = repository
        self.discovery = discovery

    def connected(self) -> list[DeviceRecord]:
        return [
            device
            for device in self.discovery.snapshot(include_simulated=False)
            if device.kind == DeviceKind.CAMERA
        ]

    def discover(self) -> list[DeviceRecord]:
        records = self.connected()
        for record in records:
            self.repository.upsert_entity("device", record)
        return records

    def resolve_path(self, profile: CameraProfile) -> str:
        """Map a stored profile back to a live device path."""
        for device in self.connected():
            if device.stable_fingerprint == profile.device_fingerprint:
                path = device.stable_path or device.transient_path
                if path:
                    return path
        raise CameraError(f"No connected camera matches profile '{profile.name}'.")

    def lerobot_config(self, profile: CameraProfile, path: str) -> dict[str, Any]:
        """The entry LeRobot expects inside --robot.cameras."""
        config: dict[str, Any] = {
            "type": "opencv",
            "index_or_path": path,
            "fps": profile.fps,
            "width": profile.width,
            "height": profile.height,
            "rotation": profile.orientation_degrees,
        }
        # Without this LeRobot lets the driver pick, which on a USB2 webcam means
        # raw YUYV and a frame rate well under the one the dataset claims.
        if profile.fourcc:
            config["fourcc"] = profile.fourcc
        return config

    @contextlib.contextmanager
    def _capture(
        self,
        profile: CameraProfile,
        fourcc: str | None = None,
    ) -> Iterator[Any]:
        cv2 = load_cv2()
        path = self.resolve_path(profile)
        # V4L2 for real devices; anything else (a recorded clip) uses the default backend.
        backend = cv2.CAP_V4L2 if Path(path).resolve().is_char_device() else cv2.CAP_ANY
        capture = cv2.VideoCapture(path, backend)
        try:
            if not capture.isOpened():
                raise CameraError(f"Camera '{path}' could not be opened.")
            # FOURCC has to be negotiated before the geometry, or V4L2 keeps the
            # format it already picked and silently ignores the request.
            requested = fourcc or profile.fourcc
            if requested:
                capture.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*requested))
            capture.set(cv2.CAP_PROP_FRAME_WIDTH, profile.width)
            capture.set(cv2.CAP_PROP_FRAME_HEIGHT, profile.height)
            capture.set(cv2.CAP_PROP_FPS, profile.fps)
            yield capture
        finally:
            capture.release()

    def _measure(
        self,
        profile: CameraProfile,
        samples: int,
        fourcc: str | None = None,
    ) -> dict[str, Any]:
        cv2 = load_cv2()
        latencies: list[float] = []
        dropped = 0
        width = height = 0
        negotiated = 0

        with self._capture(profile, fourcc=fourcc) as capture:
            negotiated = int(capture.get(cv2.CAP_PROP_FOURCC))
            # The first frames carry the cost of starting the stream; measuring
            # them would blame the format for a warm-up it did not cause.
            for _ in range(WARMUP_FRAMES):
                capture.read()
            started = time.perf_counter()
            for _ in range(samples):
                frame_started = time.perf_counter()
                ok, frame = capture.read()
                if not ok or frame is None:
                    dropped += 1
                    continue
                latencies.append((time.perf_counter() - frame_started) * 1000)
                height, width = frame.shape[0], frame.shape[1]
            elapsed = time.perf_counter() - started

        captured = len(latencies)
        return {
            "fourcc": decode_fourcc(negotiated),
            "actual": {"width": width, "height": height},
            "measured_fps": round(captured / elapsed, 2) if elapsed > 0 and captured else 0.0,
            "p50_latency_ms": round(sorted(latencies)[captured // 2], 2) if captured else None,
            "frames_captured": captured,
            "frames_dropped": dropped,
        }

    def probe(
        self,
        profile: CameraProfile,
        samples: int = 15,
        compare_formats: bool = True,
    ) -> dict[str, Any]:
        """Measure what the camera actually delivers, not what was requested.

        When the profile pins no format the driver picks one, and on a USB2
        webcam that is raw YUYV, which cannot carry 640x480 at 30 fps. Measuring
        the alternatives here is what turns 'you asked for 30 and got 21' into a
        decision the operator can actually make.
        """
        path = self.resolve_path(profile)
        result = self._measure(profile, samples)

        benchmark: dict[str, float] = {result["fourcc"]: result["measured_fps"]}
        if compare_formats and not profile.fourcc:
            for candidate in CANDIDATE_FOURCC:
                if candidate in benchmark:
                    continue
                try:
                    trial = self._measure(profile, samples, fourcc=candidate)
                except CameraError:
                    continue
                # A driver that ignores the request reports a format we already
                # measured; recording it under the requested name would lie.
                if trial["fourcc"] not in benchmark:
                    benchmark[trial["fourcc"]] = trial["measured_fps"]

        best = max(benchmark, key=lambda key: benchmark[key]) if benchmark else None
        recommended = (
            best
            if best
            and best != result["fourcc"]
            and benchmark[best] > result["measured_fps"] * FORMAT_GAIN_THRESHOLD
            else None
        )
        return {
            "path": path,
            "backend": "opencv/v4l2",
            "requested": {
                "width": profile.width,
                "height": profile.height,
                "fps": profile.fps,
                "fourcc": profile.fourcc,
            },
            **result,
            "format_benchmark": benchmark,
            "recommended_fourcc": recommended,
            "meets_requested_fps": result["measured_fps"] >= profile.fps * FPS_TOLERANCE,
        }

    def frames(self, profile: CameraProfile) -> Iterator[bytes]:
        """Yield multipart JPEG parts until the client disconnects."""
        cv2 = load_cv2()
        interval = 1 / max(1, profile.fps)
        with self._capture(profile) as capture:
            while True:
                ok, frame = capture.read()
                if not ok or frame is None:
                    break
                encoded, buffer = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 70])
                if not encoded:
                    continue
                payload = buffer.tobytes()
                yield (
                    (
                        f"--{MJPEG_BOUNDARY}\r\n"
                        f"Content-Type: image/jpeg\r\n"
                        f"Content-Length: {len(payload)}\r\n\r\n"
                    ).encode()
                    + payload
                    + b"\r\n"
                )
                time.sleep(interval)


def decode_fourcc(value: int) -> str:
    """Turn the OpenCV FOURCC integer into the pixel format the driver negotiated."""
    if value <= 0:
        return "unknown"
    return "".join(chr((value >> shift) & 0xFF) for shift in (0, 8, 16, 24)).strip()
