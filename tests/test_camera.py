from __future__ import annotations

import time
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from hashtag_robotics.api import create_app
from hashtag_robotics.camera import (
    FORMAT_GAIN_THRESHOLD,
    WARMUP_FRAMES,
    CameraError,
    CameraService,
    decode_fourcc,
    load_cv2,
)
from hashtag_robotics.config import Settings
from hashtag_robotics.discovery import DiscoveryService
from hashtag_robotics.models import CameraProfile, ResourceRequest
from hashtag_robotics.repository import Repository

pytest.importorskip("cv2", reason="OpenCV ships with the [so101] extra.")

WIDTH, HEIGHT, FRAMES = 64, 48, 12


def write_clip(path: Path) -> None:
    """A short clip stands in for a V4L2 node so no real webcam is opened."""
    cv2 = load_cv2()
    numpy = pytest.importorskip("numpy")
    writer = cv2.VideoWriter(
        str(path),
        cv2.VideoWriter_fourcc(*"MJPG"),
        30,
        (WIDTH, HEIGHT),
    )
    try:
        for index in range(FRAMES):
            frame = numpy.full((HEIGHT, WIDTH, 3), index * 8 % 255, dtype=numpy.uint8)
            writer.write(frame)
    finally:
        writer.release()
    if not path.is_file():
        pytest.skip("OpenCV could not write a test clip on this machine.")


@pytest.fixture
def service(tmp_path: Path, monkeypatch) -> CameraService:
    root = tmp_path / "v4l-by-id"
    root.mkdir()
    monkeypatch.setattr("hashtag_robotics.discovery.CAMERA_BY_ID", root)
    settings = Settings(data_dir=tmp_path, open_browser=False)
    settings.ensure_directories()
    repository = Repository(settings.database_path)
    return CameraService(settings, repository, DiscoveryService(repository))


def connect(service: CameraService, tmp_path: Path, name: str) -> str:
    clip = tmp_path / "clip.avi"
    write_clip(clip)
    link = tmp_path / "v4l-by-id" / name
    link.symlink_to(clip)
    return str(link)


def profile_for(service: CameraService) -> CameraProfile:
    device = next(item for item in service.connected())
    return CameraProfile(
        name="Front",
        device_fingerprint=device.stable_fingerprint,
        semantic_name="front",
        width=WIDTH,
        height=HEIGHT,
        fps=30,
    )


def test_only_the_capture_node_is_discovered(service: CameraService, tmp_path: Path) -> None:
    connect(service, tmp_path, "usb-SO101_Front_0001-video-index0")
    (tmp_path / "v4l-by-id" / "usb-SO101_Front_0001-video-index1").symlink_to(tmp_path / "clip.avi")

    devices = service.connected()

    assert len(devices) == 1
    assert devices[0].stable_path.endswith("index0")


def test_a_profile_resolves_to_its_stable_path(service: CameraService, tmp_path: Path) -> None:
    path = connect(service, tmp_path, "usb-SO101_Front_0001-video-index0")

    assert service.resolve_path(profile_for(service)) == path


def test_an_unplugged_camera_cannot_be_resolved(service: CameraService, tmp_path: Path) -> None:
    connect(service, tmp_path, "usb-SO101_Front_0001-video-index0")
    orphan = CameraProfile(
        name="Wrist",
        device_fingerprint="not-connected",
        semantic_name="wrist",
    )

    with pytest.raises(CameraError):
        service.resolve_path(orphan)


def test_the_lerobot_entry_carries_the_stable_path(service: CameraService, tmp_path: Path) -> None:
    path = connect(service, tmp_path, "usb-SO101_Front_0001-video-index0")
    profile = profile_for(service)

    assert service.lerobot_config(profile, path) == {
        "type": "opencv",
        "index_or_path": path,
        "fps": 30,
        "width": WIDTH,
        "height": HEIGHT,
        "rotation": 0,
    }


def test_probe_reports_measured_timing_not_the_request(
    service: CameraService,
    tmp_path: Path,
) -> None:
    connect(service, tmp_path, "usb-SO101_Front_0001-video-index0")

    result = service.probe(profile_for(service), samples=FRAMES)

    assert result["frames_captured"] > 0
    assert result["actual"] == {"width": WIDTH, "height": HEIGHT}
    assert result["requested"]["fps"] == 30
    assert result["measured_fps"] > 0
    assert result["p50_latency_ms"] is not None


def test_frames_yield_multipart_jpeg_and_release_the_device(
    service: CameraService,
    tmp_path: Path,
) -> None:
    connect(service, tmp_path, "usb-SO101_Front_0001-video-index0")
    profile = profile_for(service)

    chunks = list(service.frames(profile))

    assert chunks, "the clip should produce at least one frame"
    assert chunks[0].startswith(b"--hashtagframe")
    assert b"Content-Type: image/jpeg" in chunks[0]
    assert b"\xff\xd8" in chunks[0]
    # The generator ran to completion, so the capture was released and can reopen.
    assert service.probe(profile, samples=2)["frames_captured"] > 0


def test_fourcc_is_reported_as_text() -> None:
    cv2 = load_cv2()
    assert decode_fourcc(int(cv2.VideoWriter_fourcc(*"MJPG"))) == "MJPG"
    assert decode_fourcc(0) == "unknown"


@pytest.fixture
def camera_client(tmp_path: Path, monkeypatch) -> Iterator[TestClient]:
    root = tmp_path / "v4l-by-id"
    root.mkdir()
    monkeypatch.setattr("hashtag_robotics.discovery.CAMERA_BY_ID", root)
    clip = tmp_path / "clip.avi"
    write_clip(clip)
    (root / "usb-SO101_Front_0001-video-index0").symlink_to(clip)

    settings = Settings(
        data_dir=tmp_path / "state",
        open_browser=False,
        simulation_step_seconds=0.001,
    )
    with TestClient(create_app(settings), base_url="http://127.0.0.1") as client:
        client.headers["X-Hashtag-Token"] = client.app.state.runtime.session_token
        yield client


def register_camera(client: TestClient) -> str:
    devices = client.post("/api/cameras/discover").json()
    assert len(devices) == 1
    profile = client.post(
        "/api/cameras",
        json={
            "name": "Front",
            "device_fingerprint": devices[0]["stable_fingerprint"],
            "semantic_name": "front",
            "width": WIDTH,
            "height": HEIGHT,
            "fps": 30,
        },
    )
    assert profile.status_code == 200
    return str(profile.json()["id"])


def camera_leases(client: TestClient, camera_id: str) -> list[str]:
    repository = client.app.state.runtime.repository
    return [
        lease.owner_job_id for lease in repository.list_leases() if lease.resource_id == camera_id
    ]


def test_the_preview_stream_serves_jpeg_and_releases_the_camera(
    camera_client: TestClient,
) -> None:
    camera_id = register_camera(camera_client)

    with camera_client.stream("GET", f"/api/cameras/{camera_id}/preview.mjpg") as stream:
        assert stream.status_code == 200
        assert "multipart/x-mixed-replace" in stream.headers["content-type"]
        body = b"".join(stream.iter_bytes())

    assert body.count(b"Content-Type: image/jpeg") > 0
    assert b"\xff\xd8" in body
    # The clip ran out, so the finally block must have handed the device back.
    assert camera_leases(camera_client, camera_id) == []


def test_a_camera_held_by_another_job_refuses_a_preview(camera_client: TestClient) -> None:
    camera_id = register_camera(camera_client)
    repository = camera_client.app.state.runtime.repository
    repository.acquire_leases(
        "job_recording",
        [ResourceRequest(resource_id=camera_id, resource_type="camera", mode="exclusive")],
    )

    busy = camera_client.get(f"/api/cameras/{camera_id}/preview.mjpg")
    assert busy.status_code == 409
    assert "job_recording" in busy.json()["detail"]

    repository.release_leases("job_recording")
    assert camera_client.get(f"/api/cameras/{camera_id}/preview.mjpg").status_code == 200


def test_a_camera_preview_job_reports_measured_timing(camera_client: TestClient) -> None:
    camera_id = register_camera(camera_client)
    response = camera_client.post(
        "/api/jobs",
        json={
            "kind": "camera_preview",
            "target_mode": "sim",
            "parameters": {"camera_id": camera_id, "samples": FRAMES},
            "resources": [],
            "requested_by": "test",
        },
    )
    job_id = response.json()["id"]
    for _ in range(200):
        job = camera_client.get(f"/api/jobs/{job_id}").json()
        if job["state"] in {"completed", "failed", "aborted", "blocked"}:
            break
        time.sleep(0.05)

    assert job["state"] == "completed"
    assert job["result"]["frames_captured"] > 0
    assert job["result"]["actual"] == {"width": WIDTH, "height": HEIGHT}
    assert job["result"]["path"].endswith("index0")

    stored = camera_client.get("/api/cameras").json()
    front = next(item for item in stored if item["id"] == camera_id)
    assert front["latency_baseline_ms"] is not None


def test_probe_discards_the_stream_warmup_before_timing(
    service: CameraService,
    tmp_path: Path,
) -> None:
    """Timing from the first frame charges stream start-up to the format.

    On a real webcam that alone made every camera look about a quarter slower
    than it is, which is enough for an operator to blame hardware that is fine.
    """
    connect(service, tmp_path, "usb-SO101_Front_0001-video-index0")
    camera = profile_for(service)

    assert WARMUP_FRAMES > 0
    samples = FRAMES - WARMUP_FRAMES - 1
    result = service.probe(camera, samples=samples, compare_formats=False)

    # Every timed frame is a real frame; the warm-up ones never enter the stats.
    assert result["frames_captured"] == samples
    assert result["measured_fps"] > 0


def test_the_pixel_format_reaches_the_lerobot_config(
    service: CameraService,
    tmp_path: Path,
) -> None:
    """Without this the driver picks, so a dataset's format is not reproducible."""
    connect(service, tmp_path, "usb-SO101_Front_0001-video-index0")
    camera = profile_for(service)
    assert "fourcc" not in service.lerobot_config(camera, "/dev/video0")

    camera.fourcc = "MJPG"
    config = service.lerobot_config(camera, "/dev/video0")
    assert config["fourcc"] == "MJPG"


def test_a_format_is_only_recommended_when_the_gain_is_real() -> None:
    """A few percent is measurement noise, not a reason to change the format."""
    assert FORMAT_GAIN_THRESHOLD > 1.0
    measured, alternative = 28.6, 30.0
    assert alternative <= measured * FORMAT_GAIN_THRESHOLD
