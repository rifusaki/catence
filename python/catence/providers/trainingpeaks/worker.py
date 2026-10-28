"""TrainingPeaks staging worker.

Fetches only the two Phase-1 endpoint families (planned workouts for a
future window, zones/thresholds settings) plus the cheap athlete context
endpoint, and emits Catence staging JSONL. The worker never touches
DuckDB; Node owns all writes. Per-endpoint error isolation mirrors the
existing sync semantics: a failed family fails only its own batch, and
cookie expiry is surfaced as a distinct, actionable error code so the
Console can prompt a cookie re-paste.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any, Iterable, Mapping

from .staging import StagingWriter, utc_now

AUTH_EXPIRED_ERROR = "trainingpeaks_auth_expired"
AUTH_EXPIRED_MESSAGE = "TrainingPeaks session expired; re-paste the Production_tpAuth cookie."

PLANNED_WORKOUTS_DAYS_AHEAD = 14


class WorkerInterrupted(Exception):
    """Raised between extraction steps when the run is asked to stop."""


def as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {"value": value}


def as_items(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, list):
        return [as_dict(item) for item in value]
    if isinstance(value, dict):
        for key in ("workouts", "items", "data", "results"):
            if isinstance(value.get(key), list):
                return [as_dict(item) for item in value[key]]
        return [value]
    return []


def payload_day(payload: Mapping[str, Any]) -> str | None:
    for key in ("workoutDay", "date", "day", "calendarDate", "startTimePlanned"):
        value = payload.get(key)
        if not isinstance(value, str) or len(value) < 10:
            continue
        try:
            return date.fromisoformat(value[:10]).isoformat()
        except ValueError:
            continue
    return None


def workout_remote_id(payload: Mapping[str, Any], fallback: str) -> str:
    for key in ("workoutId", "id", "uniqueId"):
        if payload.get(key) is not None:
            return str(payload[key])
    return fallback


def structure_summary(payload: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Flat outline of the workout's structured intervals.

    TP nests repeat groups; the outline keeps one row per block with its
    repeat count and totals. The full structure stays in the archived raw
    payload and the entity's extension_json, never discarded.
    """
    structure = payload.get("structure")
    if not isinstance(structure, Mapping):
        return []
    blocks = structure.get("blocks")
    if not isinstance(blocks, Iterable):
        return []
    summary: list[dict[str, Any]] = []
    for block in blocks:
        if not isinstance(block, Mapping):
            continue
        summary.append({
            "type": block.get("type"),
            "repeatCount": block.get("repeatCount"),
            "totalDuration": block.get("totalDuration"),
            "totalDistance": block.get("totalDistance"),
        })
    return summary


def zone_setting_payloads(settings_payload: Any) -> list[tuple[str, dict[str, Any]]]:
    """Fan the TP settings document out into one zone_setting entity per group.

    A settings payload carries multiple zone sets (one per workout type and
    metric family: powerZones/heartRateZones/speedZones, plus weights and
    thresholds). Each becomes a separately keyed zone_setting entity so the
    normalizer can upsert idempotently by workout type + metric + date.
    """
    document = as_dict(settings_payload)
    # The endpoint family returns either the bare settings object or a
    # {"settings": {...}} wrapper.
    settings = document.get("settings") if isinstance(document.get("settings"), Mapping) else document
    if not isinstance(settings, Mapping):
        return []
    entities: list[tuple[str, dict[str, Any]]] = []
    # The live API names the zone groups in camelCase; the short lowercase
    # metric key stays the remoteId/normalizer contract.
    for metric_key, payload_key in (("power", "powerZones"), ("heartrate", "heartRateZones"), ("speed", "speedZones")):
        groups = settings.get(payload_key) or settings.get(metric_key) or []
        if not isinstance(groups, list):
            continue
        for index, group in enumerate(groups):
            if not isinstance(group, Mapping):
                continue
            workout_type_id = group.get("workoutTypeId", 0)
            remote_id = f"{workout_type_id}:{metric_key}"
            if len(groups) > 1:
                remote_id = f"{remote_id}:{index}"
            entities.append((remote_id, dict(group)))
    return entities


class TrainingPeaksStagingWorker:
    """Extract TrainingPeaks planned workouts and zone settings into JSONL staging."""

    def __init__(self, client: Any, writer: StagingWriter, progress: Any = None, today: date | None = None) -> None:
        self.client = client
        self.writer = writer
        self.progress = progress
        self.today = today or date.today()
        self._interrupted = False

    def request_interrupt(self) -> None:
        self._interrupted = True

    def _check_interrupted(self) -> None:
        if self._interrupted:
            if self.progress is not None:
                self.progress.finish("interrupted")
            raise WorkerInterrupted("Sync run interrupted between extraction steps")

    async def sync(self, from_date: date, to_date: date | None = None) -> None:
        """Fetch the two endpoint families with per-family error isolation."""
        end = to_date or (self.today + timedelta(days=PLANNED_WORKOUTS_DAYS_AHEAD))
        self._check_interrupted()
        athlete_id = await self._ensure_athlete_id()
        if athlete_id is None:
            return
        self._check_interrupted()
        await self._sync_athlete_settings(athlete_id)
        self._check_interrupted()
        await self._sync_zones(athlete_id)
        self._check_interrupted()
        await self._sync_planned_workouts(athlete_id, from_date, end)

    async def _ensure_athlete_id(self) -> int | None:
        if self.progress is not None:
            self.progress.set_stage("auth")
        athlete_id = await self.client.ensure_athlete_id()
        if self.progress is not None:
            self.progress.finish("auth")
        if not athlete_id:
            self.writer.error("user", AUTH_EXPIRED_MESSAGE, retryable=False)
        return athlete_id

    async def _get(self, endpoint: str) -> Any:
        """GET an endpoint, translating auth failures into the expiry error."""
        response = await self.client.get(endpoint)
        if response.is_error:
            error_code = getattr(response, "error_code", None)
            code = getattr(getattr(error_code, "value", error_code), "value", error_code) or ""
            code = str(code)
            message = getattr(response, "message", None) or "TrainingPeaks request failed"
            if "AUTH_EXPIRED" in code or "AUTH_INVALID" in code or "401" in str(message):
                raise PermissionError(AUTH_EXPIRED_MESSAGE)
            raise RuntimeError(message)
        return response.data

    async def _sync_planned_workouts(self, athlete_id: int, from_date: date, to_date: date) -> None:
        if self.progress is not None:
            self.progress.set_stage("planned_workouts")
        endpoint = f"/fitness/v6/athletes/{athlete_id}/workouts/{from_date.isoformat()}/{to_date.isoformat()}"
        try:
            data = await self._get(endpoint)
        except PermissionError as error:
            self.writer.error("workouts", f"{AUTH_EXPIRED_ERROR}: {error}", retryable=False)
            return
        except Exception as error:  # noqa: BLE001 - per-family isolation by design
            self.writer.error("workouts", str(error))
            return
        raw_hash = self.writer.archive_json("workouts", None, data, {"fromDate": from_date.isoformat(), "toDate": to_date.isoformat()})
        for index, item in enumerate(as_items(data)):
            remote_id = workout_remote_id(item, f"workouts:{index}")
            self.writer.source_entity("planned_workout", remote_id, dict(item), raw_hash, occurred_on=payload_day(item))
        if self.progress is not None:
            self.progress.finish("planned_workouts")

    async def _sync_zones(self, athlete_id: int) -> None:
        if self.progress is not None:
            self.progress.set_stage("zones")
        try:
            data = await self._get(f"/fitness/v1/athletes/{athlete_id}/settings")
        except PermissionError as error:
            self.writer.error("settings", f"{AUTH_EXPIRED_ERROR}: {error}", retryable=False)
            return
        except Exception as error:  # noqa: BLE001 - per-family isolation by design
            self.writer.error("settings", str(error))
            return
        raw_hash = self.writer.archive_json("settings", None, data)
        for remote_id, payload in zone_setting_payloads(data):
            self.writer.source_entity("zone_setting", remote_id, payload, raw_hash, occurred_on=self.today.isoformat())
        if self.progress is not None:
            self.progress.finish("zones")

    async def _sync_athlete_settings(self, athlete_id: int) -> None:
        """Cheap context entity: units and athlete identity, not training data."""
        if self.progress is not None:
            self.progress.set_stage("athlete_settings")
        try:
            data = await self._get("/users/v3/user")
        except PermissionError as error:
            self.writer.error("user", f"{AUTH_EXPIRED_ERROR}: {error}", retryable=False)
            return
        except Exception as error:  # noqa: BLE001 - per-family isolation by design
            self.writer.error("user", str(error))
            return
        raw_hash = self.writer.archive_json("user", str(athlete_id), data)
        self.writer.source_entity("profile", str(athlete_id), as_dict(data), raw_hash)
        if self.progress is not None:
            self.progress.finish("athlete_settings")
