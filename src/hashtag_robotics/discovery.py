from __future__ import annotations

import hashlib
import platform
from collections.abc import Iterable

from serial.tools import list_ports

from hashtag_robotics.models import DeviceKind, DeviceRecord
from hashtag_robotics.repository import Repository


def _fingerprint(parts: Iterable[str | None]) -> str:
    material = "|".join(part or "" for part in parts)
    return hashlib.sha256(material.encode()).hexdigest()[:20]


class DiscoveryService:
    def __init__(self, repository: Repository) -> None:
        self.repository = repository

    def discover(self, include_simulated: bool = True) -> list[DeviceRecord]:
        devices: list[DeviceRecord] = []

        for port in list_ports.comports():
            fingerprint = _fingerprint(
                [
                    port.vid and f"{port.vid:04x}",
                    port.pid and f"{port.pid:04x}",
                    port.serial_number,
                    port.manufacturer,
                    port.product,
                    port.hwid,
                ]
            )
            record = DeviceRecord(
                id=f"serial_{fingerprint}",
                kind=DeviceKind.SERIAL,
                name=port.product or port.description or port.device,
                stable_fingerprint=fingerprint,
                transient_path=port.device,
                vendor=port.manufacturer,
                product=port.product,
                serial_number=port.serial_number,
                capabilities=["serial", "read-only-discovery"],
                health="available",
            )
            self.repository.upsert_entity("device", record)
            devices.append(record)

        if include_simulated:
            simulation = DeviceRecord(
                id="sim_so101",
                kind=DeviceKind.SIMULATOR,
                name="SO-101 Safe Simulator",
                stable_fingerprint="sim-so101-v1",
                vendor="Hashtag Robotics",
                product="SO-101",
                capabilities=["teleoperation", "recording", "training", "rollout"],
                health="ready",
                is_simulated=True,
            )
            self.repository.upsert_entity("device", simulation)
            devices.append(simulation)

            gpu = DeviceRecord(
                id="compute_local",
                kind=DeviceKind.GPU,
                name=f"Local compute · {platform.machine()}",
                stable_fingerprint=f"local-{platform.node()}-{platform.machine()}",
                vendor=platform.system(),
                product=platform.processor() or platform.machine(),
                capabilities=["training", "inference"],
                health="ready",
                is_simulated=True,
            )
            self.repository.upsert_entity("device", gpu)
            devices.append(gpu)

        return devices
