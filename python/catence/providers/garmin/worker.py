from __future__ import annotations

from datetime import date, timedelta
from pathlib import Path
import hashlib
import json
from typing import Any, Callable, Mapping

from .progress import ProgressReporter
from .registry import GARMIN_READ_METHODS, assert_read_only_registry
from .staging import StagingWriter
from .streams import SAMPLE_COLUMNS, activity_details_to_samples, activity_power_bests, fit_archive_to_samples, fit_archive_to_swim_lengths, write_parquet


class WorkerInterrupted(Exception):
    """Raised between extraction steps when the run is asked to stop."""


def as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {"value": value}


def as_items(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, list):
        return [as_dict(item) for item in value]
    if isinstance(value, dict):
        for key in ("activityList", "items", "data", "meals", "foodLogEntries", "hrvSummaries", "individualStats", "results", "values", "events", "racePredictions", "predictions", "dailyPredictions"):
            if isinstance(value.get(key), list):
                return [as_dict(item) for item in value[key]]
        return [value]
    return []


def functional_threshold_power_items(value: Any) -> list[dict[str, Any]]:
    """Extract records from the undocumented threshold-power range response."""
    if isinstance(value, list):
        return [as_dict(item) for item in value]
    if isinstance(value, dict):
        for key in ("items", "data", "results", "stats", "series", "values"):
            nested = value.get(key)
            if isinstance(nested, list):
                return [as_dict(item) for item in nested]
        return [value]
    return []


def ftp_history_date(payload: Mapping[str, Any]) -> str | None:
    for key in ("until", "calendarDate", "date", "updatedDate", "from"):
        value = payload.get(key)
        if not isinstance(value, str) or len(value) < 10:
            continue
        try:
            return date.fromisoformat(value[:10]).isoformat()
        except ValueError:
            continue
    return None


def remote_id(payload: dict[str, Any], fallback: str) -> str:
    for key in ("activityId", "workoutId", "scheduleId", "id", "calendarDate", "date", "uuid"):
        if payload.get(key) is not None:
            return str(payload[key])
    return fallback


def payload_date(payload: Mapping[str, Any]) -> str | None:
    """Return the first ISO calendar day exposed by a Garmin payload."""
    for key in ("calendarDate", "date", "until", "from", "timestamp", "timestampLocal", "startTimestampGMT"):
        value = payload.get(key)
        if not isinstance(value, str) or len(value) < 10:
            continue
        try:
            return date.fromisoformat(value[:10]).isoformat()
        except ValueError:
            continue
    for key in ("generic", "cycling", "heatAltitudeAcclimation", "hrvSummary"):
        nested = payload.get(key)
        if isinstance(nested, Mapping):
            nested_date = payload_date(nested)
            if nested_date:
                return nested_date
    return None


class GarminStagingWorker:
    """Extract Garmin data through the explicit read-only registry into JSONL/Parquet staging."""

    def __init__(self, api: Any, writer: StagingWriter, data_dir: Path, known_activity_hashes: Mapping[str, str] | None = None, progress: ProgressReporter | None = None) -> None:
        self.api = api
        self.writer = writer
        self.data_dir = data_dir
        self.known_activity_hashes = dict(known_activity_hashes or {})
        self.progress = progress
        self._interrupted = False

    def request_interrupt(self) -> None:
        """Ask the worker to stop at the next safe boundary."""
        self._interrupted = True

    def _check_interrupted(self) -> None:
        if self._interrupted:
            if self.progress is not None:
                self.progress.finish("interrupted")
            raise WorkerInterrupted("Sync run interrupted between extraction steps")

    def sync(
        self,
        daily_from_date: date | None,
        activity_from_date: date | None,
        to_date: date | None = None,
        daily_to_date: date | None = None,
        activity_to_date: date | None = None,
        include_non_historical: bool = True,
    ) -> None:
        assert_read_only_registry()
        end = to_date or date.today()
        daily_end = daily_to_date or end
        activity_end = activity_to_date or end
        if include_non_historical:
            self._check_interrupted()
            self._singletons()
        if daily_from_date and daily_from_date <= daily_end:
            self._check_interrupted()
            self._daily(daily_from_date, daily_end)
            self._check_interrupted()
            self._range(daily_from_date, daily_end)
            self._check_interrupted()
            self._cycling_ftp_history(daily_from_date, daily_end)
            self._check_interrupted()
            self._max_metrics_history(daily_from_date, daily_end)
            self._check_interrupted()
            self._hrv_history(daily_from_date, daily_end)
            self._check_interrupted()
            self._score_history(daily_from_date, daily_end)
        if activity_from_date and activity_from_date <= activity_end:
            self._check_interrupted()
            self._activities(activity_from_date, activity_end)
        if include_non_historical:
            self._check_interrupted()
            self._collections()

    def _capture(self, endpoint: str, action: Callable[[], Any], remote_id_value: str | None = None, scope: dict[str, Any] | None = None) -> tuple[Any | None, str | None]:
        try:
            payload = action()
            raw_hash = self.writer.archive_json(endpoint, remote_id_value, payload, scope)
            return payload, raw_hash
        except Exception as error:  # Provider availability is intentionally isolated per operation.
            self.writer.error(endpoint, str(error), remote_id_value)
            return None, None

    def _entity(
        self,
        endpoint: str,
        entity_type: str,
        payload: Any,
        raw_hash: str | None,
        occurred_on: str | None = None,
        parent_remote_id: str | None = None,
        fallback_scope: str | None = None,
    ) -> None:
        """Stage source entities without allowing date-scoped calls to collide."""
        for index, item in enumerate(as_items(payload)):
            item_day = occurred_on or payload_date(item)
            if occurred_on:
                discriminator = str(item.get("id") or item.get("uuid") or item.get("timestamp") or item.get("inputContext") or index)
                item_id = f"{endpoint}:{occurred_on}:{discriminator}"
            else:
                item_id = remote_id(item, f"{endpoint}:{fallback_scope or item_day or 'undated'}:{index}")
            self.writer.source_entity(entity_type, item_id, item, raw_hash, parent_remote_id, item_day)

    def _singletons(self) -> None:
        calls = {
            "user_profile": ("get_user_profile", "profile"),
            "userprofile_settings": ("get_userprofile_settings", "profile_setting"),
            "devices": ("get_devices", "device"),
            "device_last_used": ("get_device_last_used", "device"),
            "device_alarms": ("get_device_alarms", "device_alarm"),
            "lactate_threshold": ("get_lactate_threshold", "lactate_threshold"),
            "heart_rate_zones": ("get_heart_rate_zones", "activity_zone"),
            "power_zones": ("get_power_zones", "activity_zone"),
            "cycling_ftp": ("get_cycling_ftp", "training_metric"),
            "personal_record": ("get_personal_record", "personal_record"),
            "earned_badges": ("get_earned_badges", "badge"),
            "available_badges": ("get_available_badges", "badge"),
            "in_progress_badges": ("get_in_progress_badges", "badge"),
            "training_plans": ("get_training_plans", "training_plan"),
            "pregnancy_summary": ("get_pregnancy_summary", "pregnancy_summary"),
            "golf_user_stats": ("get_golf_user_stats", "golf_user_stat"),
            "golf_club_stats": ("get_golf_club_stats", "golf_club_stat"),
        }
        if self.progress is not None:
            self.progress.set_stage("singletons")
            self.progress.advance(total=len(calls))
        for index, (endpoint, (method, entity_type)) in enumerate(calls.items(), start=1):
            self._check_interrupted()
            if self.progress is not None:
                self.progress.advance(step=endpoint)
            payload, raw_hash = self._capture(endpoint, lambda method=method: getattr(self.api, method)())
            if payload is not None:
                self._entity(endpoint, entity_type, payload, raw_hash)
            if self.progress is not None:
                self.progress.advance(completed=index)

    def _daily(self, from_date: date, to_date: date) -> None:
        calls = {
            "stats": ("get_stats", "daily_health"), "user_summary": ("get_user_summary", "daily_health"),
            "floors": ("get_floors", "daily_health"), "intensity_minutes": ("get_intensity_minutes_data", "daily_health"),
            "steps": ("get_steps_data", "daily_health"), "heart_rates": ("get_heart_rates", "daily_health"),
            "sleep": ("get_sleep_data", "daily_health"), "stress": ("get_stress_data", "daily_health"),
            "all_day_stress": ("get_all_day_stress", "daily_health"), "body_battery_events": ("get_body_battery_events", "daily_health"),
            "respiration": ("get_respiration_data", "daily_health"), "spo2": ("get_spo2_data", "daily_health"),
            "all_day_events": ("get_all_day_events", "health_event"),
            "training_readiness": ("get_training_readiness", "daily_health"),
            "morning_training_readiness": ("get_morning_training_readiness", "daily_health"), "training_status": ("get_training_status", "training_status"),
            "fitness_age": ("get_fitnessage_data", "fitness_age"), "endurance_score": ("get_endurance_score", "endurance_score"),
            "hydration": ("get_hydration_data", "nutrition_log"), "menstrual": ("get_menstrual_data_for_date", "menstrual"),
            "nutrition_food_log": ("get_nutrition_daily_food_log", "nutrition_log"), "nutrition_meals": ("get_nutrition_daily_meals", "nutrition_log"),
            "nutrition_settings": ("get_nutrition_daily_settings", "nutrition_setting"),
        }
        total_days = (to_date - from_date).days + 1
        if self.progress is not None:
            self.progress.set_stage("daily")
            self.progress.advance(total=total_days)
        current = from_date
        completed_days = 0
        while current <= to_date:
            self._check_interrupted()
            day = current.isoformat()
            if self.progress is not None:
                self.progress.advance(step=day)
            for endpoint, (method, entity_type) in calls.items():
                if self.progress is not None:
                    self.progress.advance(step=f"{day} {endpoint}")
                payload, raw_hash = self._capture(endpoint, lambda method=method, day=day: getattr(self.api, method)(day), day, {"date": day})
                if payload is not None:
                    self._entity(endpoint, entity_type, payload, raw_hash, day)
            completed_days += 1
            if self.progress is not None:
                self.progress.advance(completed=completed_days)
            current += timedelta(days=1)

    def _range(self, from_date: date, to_date: date) -> None:
        calls = {
            "daily_steps": ("get_daily_steps", "daily_health"), "body_battery": ("get_body_battery", "daily_health"),
            "blood_pressure": ("get_blood_pressure", "blood_pressure"), "weigh_ins": ("get_weigh_ins", "body_composition"),
            "progress_summary": ("get_progress_summary_between_dates", "progress_summary"), "menstrual_calendar": ("get_menstrual_calendar_data", "menstrual"),
        }
        if self.progress is not None:
            self.progress.set_stage("range")
            self.progress.advance(total=len(calls))
        for index, (endpoint, (method, entity_type)) in enumerate(calls.items(), start=1):
            # Garmin rejects broad body-battery and menstrual-calendar ranges.
            # Keep every request inside the provider's 92-day limit.
            window_start = from_date
            # Garmin rejects the Body Battery endpoint's larger historical
            # ranges. Keep it deliberately small; the captures are
            # content-addressed so overlapping retry windows are harmless.
            window_days = 7 if endpoint == "body_battery" else (90 if endpoint == "menstrual_calendar" else (to_date - from_date).days + 1)
            if self.progress is not None:
                self.progress.advance(step=endpoint)
            while window_start <= to_date:
                self._check_interrupted()
                window_end = min(to_date, window_start + timedelta(days=window_days - 1))
                start, end = window_start.isoformat(), window_end.isoformat()
                payload, raw_hash = self._capture(endpoint, lambda method=method, start=start, end=end: getattr(self.api, method)(start, end), None, {"from": start, "to": end})
                if payload is not None:
                    self._entity(endpoint, entity_type, payload, raw_hash, fallback_scope=start)
                window_start = window_end + timedelta(days=1)
            if self.progress is not None:
                self.progress.advance(completed=index)

    def _cycling_ftp_history(self, from_date: date, to_date: date) -> None:
        """Stage daily cycling FTP setting history from Garmin's range endpoint."""
        endpoint = "functional_threshold_power_range"
        window_start = from_date
        total_windows = (to_date - from_date).days // 89 + 1
        if self.progress is not None:
            self.progress.set_stage("ftp_history")
            self.progress.advance(total=total_windows)
        completed_windows = 0
        while window_start <= to_date:
            self._check_interrupted()
            # This private Connect endpoint is not documented with a maximum
            # range. Keep requests aligned with other conservative range calls.
            window_end = min(to_date, window_start + timedelta(days=89))
            start, end = window_start.isoformat(), window_end.isoformat()
            if self.progress is not None:
                self.progress.advance(step=start)
            payload, raw_hash = self._capture(
                endpoint,
                lambda start=start, end=end: self.api.get_functional_threshold_power_range(
                    start, end, sport="CYCLING"
                ),
                None,
                {"from": start, "to": end, "sport": "CYCLING", "aggregation": "daily"},
            )
            if payload is not None:
                for item in functional_threshold_power_items(payload):
                    series = str(item.get("series") or item.get("sport") or "").upper()
                    value = item.get("value", item.get("functionalThresholdPower"))
                    occurred_on = ftp_history_date(item)
                    if series != "CYCLING" or isinstance(value, bool) or not isinstance(value, (int, float)) or occurred_on is None:
                        continue
                    normalized = {
                        **item,
                        "sport": "CYCLING",
                        "calendarDate": occurred_on,
                        "functionalThresholdPower": value,
                    }
                    self.writer.source_entity(
                        "functional_threshold_power",
                        f"cycling:{occurred_on}",
                        normalized,
                        raw_hash,
                        occurred_on=occurred_on,
                    )
            completed_windows += 1
            if self.progress is not None:
                self.progress.advance(completed=completed_windows)
            window_start = window_end + timedelta(days=1)

    def _max_metrics_history(self, from_date: date, to_date: date) -> None:
        """Stage range max-metric responses by their actual calendar date."""
        window_start = from_date
        total_windows = (to_date - from_date).days // 89 + 1
        if self.progress is not None:
            self.progress.set_stage("max_metrics")
            self.progress.advance(total=total_windows)
        completed_windows = 0
        while window_start <= to_date:
            self._check_interrupted()
            window_end = min(to_date, window_start + timedelta(days=89))
            start, end = window_start.isoformat(), window_end.isoformat()
            if self.progress is not None:
                self.progress.advance(step=start)
            payload, raw_hash = self._capture(
                "max_metrics_range",
                lambda start=start, end=end: self.api.get_max_metrics_range(start, end),
                None,
                {"from": start, "to": end},
            )
            observed: set[str] = set()
            if payload is not None:
                for item in as_items(payload):
                    item_day = payload_date(item)
                    if item_day:
                        observed.add(item_day)
                        self.writer.source_entity("max_metric", f"max_metrics:{item_day}", item, raw_hash, occurred_on=item_day)
            current = window_start
            while current <= window_end:
                day = current.isoformat()
                if day not in observed:
                    fallback, fallback_hash = self._capture(
                        "max_metrics",
                        lambda day=day: self.api.get_max_metrics(day),
                        day,
                        {"date": day, "fallback": "range-missing"},
                    )
                    if fallback is not None:
                        for item in as_items(fallback):
                            self.writer.source_entity("max_metric", f"max_metrics:{day}", item, fallback_hash, occurred_on=day)
                current += timedelta(days=1)
            completed_windows += 1
            if self.progress is not None:
                self.progress.advance(completed=completed_windows)
            window_start = window_end + timedelta(days=1)

    def _hrv_history(self, from_date: date, to_date: date) -> None:
        """Stage the PR-402 HRV range API, retaining daily fallback coverage."""
        window_start = from_date
        total_windows = (to_date - from_date).days // 89 + 1
        if self.progress is not None:
            self.progress.set_stage("hrv_history")
            self.progress.advance(total=total_windows)
        completed_windows = 0
        while window_start <= to_date:
            self._check_interrupted()
            window_end = min(to_date, window_start + timedelta(days=89))
            start, end = window_start.isoformat(), window_end.isoformat()
            if self.progress is not None:
                self.progress.advance(step=start)
            payload, raw_hash = self._capture(
                "hrv_range",
                lambda start=start, end=end: self.api.get_hrv_data_range(start, end),
                None,
                {"from": start, "to": end},
            )
            observed: set[str] = set()
            if payload is not None:
                for item in as_items(payload):
                    item_day = payload_date(item)
                    if item_day:
                        observed.add(item_day)
                        self.writer.source_entity("daily_health", f"hrv:{item_day}", item, raw_hash, occurred_on=item_day)
            current = window_start
            while current <= window_end:
                day = current.isoformat()
                if day not in observed:
                    fallback, fallback_hash = self._capture("hrv", lambda day=day: self.api.get_hrv_data(day), day, {"date": day, "fallback": "range-missing"})
                    if fallback is not None:
                        self.writer.source_entity("daily_health", f"hrv:{day}", as_dict(fallback), fallback_hash, occurred_on=day)
                current += timedelta(days=1)
            completed_windows += 1
            if self.progress is not None:
                self.progress.advance(completed=completed_windows)
            window_start = window_end + timedelta(days=1)

    def _score_history(self, from_date: date, to_date: date) -> None:
        """Stage daily-capable endurance-adjacent metrics from range endpoints."""
        window_start = from_date
        total_windows = (to_date - from_date).days // 89 + 1
        if self.progress is not None:
            self.progress.set_stage("scores")
            self.progress.advance(total=total_windows)
        completed_windows = 0
        while window_start <= to_date:
            self._check_interrupted()
            window_end = min(to_date, window_start + timedelta(days=89))
            start, end = window_start.isoformat(), window_end.isoformat()
            if self.progress is not None:
                self.progress.advance(step=start)
            for endpoint, method, entity_type in (
                ("hill_score", lambda: self.api.get_hill_score(start, end), "hill_score"),
                ("running_tolerance", lambda: self.api.get_running_tolerance(start, end, aggregation="daily"), "running_tolerance"),
            ):
                payload, raw_hash = self._capture(endpoint, method, None, {"from": start, "to": end, "aggregation": "daily"})
                if payload is not None:
                    for index, item in enumerate(as_items(payload)):
                        item_day = payload_date(item)
                        if item_day:
                            self.writer.source_entity(entity_type, f"{endpoint}:{item_day}:{index}", item, raw_hash, occurred_on=item_day)
            completed_windows += 1
            if self.progress is not None:
                self.progress.advance(completed=completed_windows)
            window_start = window_end + timedelta(days=1)

        # Garmin limits daily race-prediction windows to one year.
        window_start = from_date
        total_windows = (to_date - from_date).days // 365 + 1
        if self.progress is not None:
            self.progress.advance(total=total_windows)
        completed_windows = 0
        while window_start <= to_date:
            self._check_interrupted()
            window_end = min(to_date, window_start + timedelta(days=365))
            start, end = window_start.isoformat(), window_end.isoformat()
            if self.progress is not None:
                self.progress.advance(step=start)
            payload, raw_hash = self._capture("race_predictions", lambda start=start, end=end: self.api.get_race_predictions(start, end, "daily"), None, {"from": start, "to": end, "aggregation": "daily"})
            if payload is not None:
                for index, item in enumerate(as_items(payload)):
                    item_day = payload_date(item) or start
                    self.writer.source_entity("race_prediction", f"race_prediction:{item_day}:{index}", item, raw_hash, occurred_on=item_day)
            completed_windows += 1
            if self.progress is not None:
                self.progress.advance(completed=completed_windows)
            window_start = window_end + timedelta(days=1)

    def _activities(self, from_date: date, to_date: date) -> None:
        start, end = from_date.isoformat(), to_date.isoformat()
        if self.progress is not None:
            self.progress.set_stage("activities")
        payload, raw_hash = self._capture("activities", lambda: self.api.get_activities_by_date(start, end), None, {"from": start, "to": end})
        if payload is None:
            return
        self._entity("activities", "activity", payload, raw_hash)
        summaries = as_items(payload)
        if self.progress is not None:
            self.progress.advance(total=len(summaries))
        for index, summary in enumerate(summaries, start=1):
            self._check_interrupted()
            activity_id = remote_id(summary, "unknown")
            if self.progress is not None:
                self.progress.advance(step=activity_id)
            summary_hash = hashlib.sha256(json.dumps(summary, sort_keys=True, separators=(",", ":"), default=str).encode()).hexdigest()
            details_fetched = self.known_activity_hashes.get(activity_id) != summary_hash
            if details_fetched:
                self._activity_details(activity_id, summary)
            self.writer.activity_sync_state(activity_id, summary_hash, details_fetched)
            if self.progress is not None:
                self.progress.advance(completed=index)

    def _multisport_children(self, parent_activity_id: str, activity: dict[str, Any]) -> None:
        if not activity.get("isMultiSportParent"):
            return
        metadata = as_dict(activity.get("metadataDTO"))
        child_ids = metadata.get("childIds")
        if not isinstance(child_ids, list):
            return
        for child_id in dict.fromkeys(str(value) for value in child_ids if value is not None and str(value) != parent_activity_id):
            payload, raw_hash = self._capture("activity", lambda child_id=child_id: self.api.get_activity(child_id), child_id, {"parentActivityId": parent_activity_id})
            if isinstance(payload, dict):
                self.writer.source_entity("activity", child_id, payload, raw_hash, parent_remote_id=parent_activity_id)

    def _is_swim_activity(self, summary: dict[str, Any], activity: dict[str, Any] | None, details: dict[str, Any] | None) -> bool:
        """Return True when any of the Garmin sport/type fields indicates a swim."""
        candidates: list[str] = []
        # Direct sport string fields on the list summary (including flat activityType string).
        for key in ("sport", "sportType", "sport_type", "activityType", "activityTypeKey"):
            value = summary.get(key)
            if isinstance(value, str) and value:
                candidates.append(value)
        # Nested activityType shapes on the list summary.
        for key in ("activityType", "activityTypeDTO"):
            nested = summary.get(key)
            if isinstance(nested, dict):
                type_key = nested.get("typeKey") or nested.get("type_key") or nested.get("type") or nested.get("key")
                if isinstance(type_key, str) and type_key:
                    candidates.append(type_key)
        # Detailed payloads provide the authoritative typeKey.
        for payload in (activity, details):
            if not isinstance(payload, dict):
                continue
            for key in ("activityType", "activityTypeDTO"):
                nested = payload.get(key)
                if isinstance(nested, dict):
                    type_key = nested.get("typeKey")
                    if isinstance(type_key, str) and type_key:
                        candidates.append(type_key)
            for key in ("sport", "sportType"):
                value = payload.get(key)
                if isinstance(value, str) and value:
                    candidates.append(value)
            summary_dto = payload.get("summaryDTO")
            if isinstance(summary_dto, dict):
                for key in ("activityType", "activityTypeDTO"):
                    nested = summary_dto.get(key)
                    if isinstance(nested, dict):
                        type_key = nested.get("typeKey")
                        if isinstance(type_key, str) and type_key:
                            candidates.append(type_key)
        for candidate in candidates:
            lowered = candidate.lower()
            if lowered == "lap_swimming" or "swim" in lowered:
                return True
        return False

    def _activity_details(self, activity_id: str, summary: dict[str, Any]) -> None:
        calls = {
            "activity": ("get_activity", "activity_detail"), "activity_details": ("get_activity_details", "activity_detail"),
            "activity_splits": ("get_activity_splits", "activity_interval"), "activity_typed_splits": ("get_activity_typed_splits", "activity_interval"),
            "activity_split_summaries": ("get_activity_split_summaries", "activity_interval"), "activity_weather": ("get_activity_weather", "activity_weather"),
            "activity_hr_zones": ("get_activity_hr_in_timezones", "activity_zone"), "activity_power_zones": ("get_activity_power_in_timezones", "activity_zone"),
            "activity_exercise_sets": ("get_activity_exercise_sets", "activity_exercise_set"), "activity_gear": ("get_activity_gear", "activity_gear"),
        }
        details: dict[str, Any] | None = None
        activity_payload: dict[str, Any] | None = None
        for endpoint, (method, entity_type) in calls.items():
            payload, raw_hash = self._capture(endpoint, lambda method=method: getattr(self.api, method)(activity_id), activity_id)
            if payload is not None:
                self._entity(endpoint, entity_type, payload, raw_hash, parent_remote_id=activity_id)
                if endpoint == "activity" and isinstance(payload, dict):
                    activity_payload = payload
                    self._multisport_children(activity_id, payload)
                if endpoint == "activity_details" and isinstance(payload, dict):
                    details = payload
        self._activity_files(activity_id, summary, activity_payload, details)

    def _activity_files(self, activity_id: str, summary: dict[str, Any], activity: dict[str, Any] | None, details: dict[str, Any] | None) -> None:
        try:
            from garminconnect import Garmin
            formats = {
                "activity_original": Garmin.ActivityDownloadFormat.ORIGINAL,
                "activity_tcx": Garmin.ActivityDownloadFormat.TCX,
                "activity_gpx": Garmin.ActivityDownloadFormat.GPX,
                "activity_kml": Garmin.ActivityDownloadFormat.KML,
                "activity_csv": Garmin.ActivityDownloadFormat.CSV,
            }
        except ImportError as error:
            self.writer.error("activity_files", str(error), activity_id, False)
            return
        original_path: Path | None = None
        original_hash: str | None = None
        for endpoint, format_value in formats.items():
            try:
                contents = self.api.download_activity(activity_id, format_value)
                digest = self.writer.archive_bytes(endpoint, activity_id, contents, "zip" if endpoint == "activity_original" else endpoint.rsplit("_", 1)[1])
                if endpoint == "activity_original":
                    original_path = self.data_dir / "raw" / "garmin" / endpoint / activity_id / f"{digest}.zip"
                    original_hash = digest
            except Exception as error:
                self.writer.error(endpoint, str(error), activity_id)
        samples = activity_details_to_samples(f"garmin:{activity_id}", details or {})
        if not samples and original_path and original_path.exists():
            samples = fit_archive_to_samples(f"garmin:{activity_id}", original_path)
        if samples:
            start_date = str(summary.get("startTimeLocal") or summary.get("startTimeGMT") or date.today().isoformat())
            destination, digest, row_count = write_parquet(self.data_dir, activity_id, start_date, samples)
            self.writer.emit({
                "kind": "stream_manifest", "provider": "garmin", "activityRemoteId": activity_id,
                "relativePath": str(destination.relative_to(self.data_dir)), "contentHash": digest, "rowCount": row_count,
                "startAt": samples[0].get("timestamp_utc"), "endAt": samples[-1].get("timestamp_utc"),
                "columns": SAMPLE_COLUMNS, "rawObjectHash": None,
            })
            for duration, best_power in activity_power_bests(samples).items():
                self.writer.source_entity(
                    "activity_power_best",
                    f"{activity_id}:{duration}",
                    {"durationSeconds": duration, "bestPowerWatts": best_power, "sourceType": "garmin_fit_derived"},
                    original_hash,
                    parent_remote_id=activity_id,
                    occurred_on=start_date[:10],
                )
        if original_path and original_path.exists():
            if self._is_swim_activity(summary, activity, details):
                lengths = fit_archive_to_swim_lengths(f"garmin:{activity_id}", original_path)
                if lengths:
                    start_date = str(summary.get("startTimeLocal") or summary.get("startTimeGMT") or date.today().isoformat())
                    self.writer.source_entity(
                        "activity_swim_lengths",
                        f"{activity_id}:fit",
                        {"lengths": lengths},
                        original_hash,
                        parent_remote_id=activity_id,
                        occurred_on=start_date[:10],
                    )

    def _collections(self) -> None:
        today = date.today()
        calls = {
            "workouts": ("get_workouts", (), "workout"), "scheduled_workouts": ("get_scheduled_workouts", (today.year, today.month), "scheduled_workout"),
            "goals": ("get_goals", (), "goal"), "golf_summary": ("get_golf_summary", (), "golf_scorecard"),
        }
        if self.progress is not None:
            self.progress.set_stage("collections")
            self.progress.advance(total=len(calls))
        for index, (endpoint, (method, arguments, entity_type)) in enumerate(calls.items(), start=1):
            self._check_interrupted()
            if self.progress is not None:
                self.progress.advance(step=endpoint)
            payload, raw_hash = self._capture(endpoint, lambda method=method, arguments=arguments: getattr(self.api, method)(*arguments))
            if payload is not None:
                self._entity(endpoint, entity_type, payload, raw_hash)
            if self.progress is not None:
                self.progress.advance(completed=index)
