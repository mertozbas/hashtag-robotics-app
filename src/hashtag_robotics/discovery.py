from __future__ import annotations

import hashlib
import platform
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from serial.tools import list_ports

from hashtag_robotics.models import (
    DeviceKind,
    DeviceRecord,
    DeviceRole,
    RobotProfile,
    TeleoperatorProfile,
)
from hashtag_robotics.repository import Repository

SERIAL_BY_ID = Path("/dev/serial/by-id")
CAMERA_BY_ID = Path("/dev/v4l/by-id")

# A device the table remembers but cannot currently find. Distinct from
# "unknown": this one was here, and it is not here now.
DEVICE_ABSENT = "absent"


def _fingerprint(parts: Iterable[str | None]) -> str:
    material = "|".join(part or "" for part in parts)
    return hashlib.sha256(material.encode()).hexdigest()[:20]


def _serial_identity(port: Any) -> tuple[str, bool]:
    """Identify a serial adapter by what it *is*, not by where it is plugged in.

    pyserial's `hwid` carries `LOCATION=<usb path>`, so folding it into the
    fingerprint makes the identity change the moment a cable moves to another
    port -- exactly what a stable fingerprint exists to survive. The adapter's
    own serial number is unique, so it carries the identity on its own.

    An adapter with no serial number is a different case: nothing but its
    position distinguishes it from an identical one, so location stays in the
    material and the record says the identity cannot survive a re-plug.
    """
    identity = [
        port.vid and f"{port.vid:04x}",
        port.pid and f"{port.pid:04x}",
        port.serial_number,
        port.manufacturer,
        port.product,
    ]
    if port.serial_number:
        return _fingerprint(identity), True
    return _fingerprint([*identity, port.hwid]), False


def _stable_paths(root: Path) -> dict[str, str]:
    if not root.is_dir():
        return {}
    resolved: dict[str, str] = {}
    for link in sorted(root.iterdir()):
        try:
            resolved[str(link.resolve())] = str(link)
        except OSError:
            continue
    return resolved


class DiscoveryService:
    def __init__(self, repository: Repository) -> None:
        self.repository = repository

    def discover(self, include_simulated: bool = True) -> list[DeviceRecord]:
        self.reconcile_fingerprints()
        devices = self.snapshot(include_simulated=include_simulated)
        for record in devices:
            self.repository.upsert_entity("device", record)
        self.retire_stale_devices(devices)
        return devices

    def retire_stale_devices(self, present: list[DeviceRecord]) -> dict[str, list[str]]:
        """Stop the device table from claiming that yesterday's rows are here now.

        Discovery only ever wrote what it saw, so nothing removed what it stopped
        seeing. Every fingerprint an arm has ever had -- one per cable position
        under the old scheme, one more when the scheme itself changed -- stayed
        in the table saying `health: available`. Two arms had grown into six rows,
        all six claiming to be plugged in.

        The rows split into two kinds, and they need opposite treatment:

        **Superseded** -- the serial number matches an arm that is present, but
        the fingerprint does not. That is not another device; it is this device
        under an identity it no longer uses. Keeping it would offer the operator
        a second copy of the same arm carrying a port path that is now wrong,
        which is how a job ends up addressed to the other arm. Deleted.

        **Absent** -- nothing connected shares its serial number. That is a real
        device that is simply unplugged, and the record is worth keeping; it just
        must not go on saying `available`.
        """
        live_fingerprints = {record.stable_fingerprint for record in present}
        live_serials = {record.serial_number for record in present if record.serial_number}

        retired: dict[str, list[str]] = {"superseded": [], "absent": []}
        for stored in self.repository.list_entities("device", DeviceRecord):
            if stored.stable_fingerprint in live_fingerprints or stored.is_simulated:
                continue
            if stored.serial_number and stored.serial_number in live_serials:
                self.repository.delete_entity("device", stored.id)
                retired["superseded"].append(stored.id)
            elif stored.health != DEVICE_ABSENT:
                stored.health = DEVICE_ABSENT
                stored.matched_profile_id = None
                stored.matched_role = DeviceRole.UNASSIGNED
                self.repository.upsert_entity("device", stored)
                retired["absent"].append(stored.id)
        return retired

    def inventory(self, include_simulated: bool = True) -> list[DeviceRecord]:
        """What is connected now, plus what is remembered but gone -- read-only.

        `snapshot` answers "what is here"; the stored table answers "what has
        been here". Neither alone is what an operator needs to see, and a GET
        must not write, so this merges them without touching the repository.
        """
        present = self.snapshot(include_simulated=include_simulated)
        live_fingerprints = {record.stable_fingerprint for record in present}
        live_serials = {record.serial_number for record in present if record.serial_number}

        records = list(present)
        for stored in self.repository.list_entities("device", DeviceRecord):
            if stored.stable_fingerprint in live_fingerprints or stored.is_simulated:
                continue
            if stored.serial_number and stored.serial_number in live_serials:
                continue  # the same arm under a retired identity
            stored.health = DEVICE_ABSENT
            records.append(stored)
        return records

    def reconcile_fingerprints(self) -> list[str]:
        """Re-attach a profile whose arm is present but fingerprinted differently.

        A profile stored under an older fingerprinting scheme, or written before
        a cable moved, points at an identity that no longer exists even though
        the arm is sitting right there. The adapter's serial number is the same
        physical fact in both records, so it is what reconnects them.
        """
        connected = {
            record.serial_number: record
            for record in self.snapshot(include_simulated=False)
            if record.kind == DeviceKind.SERIAL and record.serial_number
        }
        if not connected:
            return []

        healed: list[str] = []
        for kind, model in (("robot", RobotProfile), ("teleoperator", TeleoperatorProfile)):
            for profile in self.repository.list_entities(kind, model):
                device = connected.get(profile.serial_number or "")
                if device is None or profile.device_fingerprint == device.stable_fingerprint:
                    continue
                profile.device_fingerprint = device.stable_fingerprint
                profile.port = device.stable_path or device.transient_path
                self.repository.upsert_entity(kind, profile)
                healed.append(f"{kind}:{profile.id}")
        return healed

    def snapshot(self, include_simulated: bool = True) -> list[DeviceRecord]:
        """Enumerate what is connected right now without writing to the repository."""
        devices: list[DeviceRecord] = []
        robots = self.repository.list_entities("robot", RobotProfile)
        teleoperators = self.repository.list_entities("teleoperator", TeleoperatorProfile)

        serial_paths = _stable_paths(SERIAL_BY_ID)
        for port in list_ports.comports():
            if port.vid is None:
                continue
            fingerprint, identity_stable = _serial_identity(port)
            record = DeviceRecord(
                id=f"serial_{fingerprint}",
                kind=DeviceKind.SERIAL,
                name=port.product or port.description or port.device,
                stable_fingerprint=fingerprint,
                identity_stable=identity_stable,
                transient_path=port.device,
                stable_path=serial_paths.get(port.device),
                vendor=port.manufacturer,
                product=port.product,
                serial_number=port.serial_number,
                capabilities=["serial", "read-only-discovery"],
                health="available",
            )
            self._match_profile(record, robots, teleoperators)
            devices.append(record)

        devices.extend(self._cameras())

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
            devices.append(gpu)

        return devices

    def _cameras(self) -> list[DeviceRecord]:
        records: list[DeviceRecord] = []
        if not CAMERA_BY_ID.is_dir():
            return records
        for link in sorted(CAMERA_BY_ID.iterdir()):
            if not link.name.endswith("index0"):
                continue
            fingerprint = _fingerprint([link.name])
            try:
                transient = str(link.resolve())
            except OSError:
                continue
            records.append(
                DeviceRecord(
                    id=f"camera_{fingerprint}",
                    kind=DeviceKind.CAMERA,
                    name=link.name.replace("usb-", "").replace("-video-index0", ""),
                    stable_fingerprint=fingerprint,
                    transient_path=transient,
                    stable_path=str(link),
                    capabilities=["opencv", "read-only-discovery"],
                    health="available",
                    matched_role=DeviceRole.CAMERA,
                )
            )
        return records

    def _match_profile(
        self,
        record: DeviceRecord,
        robots: list[RobotProfile],
        teleoperators: list[TeleoperatorProfile],
    ) -> None:
        for robot in robots:
            if robot.device_fingerprint == record.stable_fingerprint:
                record.matched_profile_id = robot.id
                record.matched_role = DeviceRole.FOLLOWER
                return
        for teleoperator in teleoperators:
            if teleoperator.device_fingerprint == record.stable_fingerprint:
                record.matched_profile_id = teleoperator.id
                record.matched_role = DeviceRole.LEADER
                return
