from __future__ import annotations

import importlib.util
import platform
import shutil
import sys
from importlib import metadata
from pathlib import Path

from packaging.version import InvalidVersion, Version

from hashtag_robotics import __version__
from hashtag_robotics.config import Settings
from hashtag_robotics.models import (
    CapabilityManifest,
    CheckStatus,
    DoctorCheck,
    DoctorReport,
)

PACKAGE_DISTRIBUTIONS = {
    "lerobot": "lerobot",
    "strands-agents": "strands-agents",
    "strands-robots": "strands-robots",
    "torch": "torch",
    "mujoco": "mujoco",
    "opencv": "opencv-python",
    "pyserial": "pyserial",
}


def package_version(distribution: str) -> str | None:
    try:
        return metadata.version(distribution)
    except metadata.PackageNotFoundError:
        return None


def module_available(module: str) -> bool:
    return importlib.util.find_spec(module) is not None


def _version(value: str | None) -> Version | None:
    if value is None:
        return None
    try:
        return Version(value)
    except InvalidVersion:
        return None


class DoctorService:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def capabilities(self) -> CapabilityManifest:
        packages = {
            label: package_version(distribution)
            for label, distribution in PACKAGE_DISTRIBUTIONS.items()
        }
        camera_backends: list[str] = []
        if module_available("cv2"):
            camera_backends.append("opencv")
        if module_available("pyrealsense2"):
            camera_backends.append("realsense")

        robot_adapters = ["safe-mock"]
        if module_available("lerobot"):
            robot_adapters.append("lerobot")

        policy_adapters = ["mock-policy"]
        if module_available("lerobot"):
            policy_adapters.append("lerobot-local")
        if module_available("strands_robots"):
            policy_adapters.append("strands-robots")

        simulation_backends = ["safe-mock"]
        if module_available("mujoco"):
            simulation_backends.append("mujoco")

        accelerator = "cpu"
        if module_available("torch"):
            import torch

            if torch.cuda.is_available():
                accelerator = "cuda"
            elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
                accelerator = "mps"

        return CapabilityManifest(
            platform_version=__version__,
            python_version=platform.python_version(),
            os=platform.system().lower(),
            architecture=platform.machine(),
            packages=packages,
            accelerator=accelerator,
            camera_backends=camera_backends,
            robot_adapters=robot_adapters,
            policy_adapters=policy_adapters,
            simulation_backends=simulation_backends,
            physical_enabled=self.settings.enable_physical,
        )

    def run(self) -> DoctorReport:
        capabilities = self.capabilities()
        checks: list[DoctorCheck] = []

        python_supported = (3, 12) <= sys.version_info[:2] < (3, 14)
        checks.append(
            DoctorCheck(
                code="python.version",
                label="Python runtime",
                status=CheckStatus.PASS if python_supported else CheckStatus.BLOCKED,
                detail=f"Python {platform.python_version()}",
                remediation=None if python_supported else "Use Python 3.12 or 3.13.",
            )
        )

        os_supported = platform.system().lower() in {"darwin", "linux", "windows"}
        checks.append(
            DoctorCheck(
                code="os.support",
                label="Operating system",
                status=CheckStatus.PASS if os_supported else CheckStatus.WARNING,
                detail=f"{platform.system()} {platform.release()} ({platform.machine()})",
                remediation=None if os_supported else "Run compatibility tests for this OS.",
            )
        )

        ffmpeg = shutil.which("ffmpeg")
        checks.append(
            DoctorCheck(
                code="binary.ffmpeg",
                label="FFmpeg",
                status=CheckStatus.PASS if ffmpeg else CheckStatus.WARNING,
                detail=ffmpeg or "Not found",
                remediation=None if ffmpeg else "Install FFmpeg before video recording.",
            )
        )

        disk = shutil.disk_usage(self.settings.data_dir)
        free_gb = disk.free / (1024**3)
        checks.append(
            DoctorCheck(
                code="storage.free",
                label="Artifact storage",
                status=CheckStatus.PASS if free_gb >= 10 else CheckStatus.WARNING,
                detail=f"{free_gb:.1f} GB free at {self.settings.data_dir}",
                remediation=None if free_gb >= 10 else "Free at least 10 GB for datasets.",
            )
        )

        for label in ("lerobot", "strands-agents", "strands-robots", "torch"):
            value = capabilities.packages[label]
            required_for_core = label == "torch"
            status = (
                CheckStatus.PASS
                if value
                else (CheckStatus.WARNING if required_for_core else CheckStatus.NOT_APPLICABLE)
            )
            checks.append(
                DoctorCheck(
                    code=f"package.{label}",
                    label=label,
                    status=status,
                    detail=value or "Optional package is not installed",
                    remediation=(
                        None if value else f"Install the matching feature pack to enable {label}."
                    ),
                )
            )

        lerobot = _version(capabilities.packages["lerobot"])
        strands_robots = _version(capabilities.packages["strands-robots"])
        conflict = (
            lerobot is not None
            and strands_robots is not None
            and lerobot >= Version("0.6")
            and strands_robots <= Version("0.4.1")
        )
        checks.append(
            DoctorCheck(
                code="compat.lerobot-strands-robots",
                label="LeRobot / Strands Robots compatibility",
                status=CheckStatus.BLOCKED if conflict else CheckStatus.PASS,
                detail=(
                    "Known conflict: Strands Robots 0.4.1 pins LeRobot below 0.6."
                    if conflict
                    else "No known blocked version pair detected."
                ),
                remediation=(
                    "Use a tested Strands Robots release/commit compatible with LeRobot 0.6."
                    if conflict
                    else None
                ),
            )
        )

        checks.append(
            DoctorCheck(
                code="physical.mode",
                label="Physical actuation gate",
                status=(CheckStatus.WARNING if self.settings.enable_physical else CheckStatus.PASS),
                detail=(
                    "Physical adapters are enabled."
                    if self.settings.enable_physical
                    else "Physical adapters are locked; sim/read-only workflows only."
                ),
                remediation=(
                    "Keep disabled until the HIL checklist is complete."
                    if self.settings.enable_physical
                    else None
                ),
            )
        )

        statuses = {check.status for check in checks}
        overall = (
            CheckStatus.BLOCKED
            if CheckStatus.BLOCKED in statuses
            else CheckStatus.WARNING
            if CheckStatus.WARNING in statuses
            else CheckStatus.PASS
        )
        return DoctorReport(overall=overall, checks=checks, capabilities=capabilities)


def diagnostics_payload(settings: Settings) -> dict[str, object]:
    report = DoctorService(settings).run()
    return {
        "doctor": report.model_dump(mode="json"),
        "paths": {
            "data_dir": str(Path(settings.data_dir).resolve()),
        },
        "safety": {
            "physical_enabled": settings.enable_physical,
            "network_bind": settings.host,
        },
    }
