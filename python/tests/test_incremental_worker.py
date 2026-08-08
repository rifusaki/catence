import hashlib
import json
from datetime import date

from python.catence.providers.garmin.worker import GarminStagingWorker


class Writer:
    def __init__(self) -> None:
        self.states: list[tuple[str, str, bool]] = []
        self.entities: list[tuple[object, ...]] = []

    def archive_json(self, *_args, **_kwargs):
        return "a" * 64

    def source_entity(self, *args, **kwargs):
        self.entities.append(args + (kwargs,))

    def activity_sync_state(self, activity_id, summary_hash, details_fetched):
        self.states.append((activity_id, summary_hash, details_fetched))

    def error(self, *_args, **_kwargs):
        return None


class Api:
    def __init__(self, summary):
        self.summary = summary
        self.detail_calls = 0

    def get_activities_by_date(self, *_args):
        return [self.summary]

    def get_activity(self, *_args):
        self.detail_calls += 1
        return {}


class RangeApi:
    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple[object, ...]]] = []

    def __getattr__(self, name: str):
        def call(*arguments: object):
            self.calls.append((name, arguments))
            return []

        return call


class FunctionalThresholdPowerApi:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str, str]] = []

    def get_functional_threshold_power_range(self, start, end, *, sport, aggregation="daily"):
        self.calls.append((start, end, sport, aggregation))
        return [
            {"series": "cycling", "value": 255, "from": f"{start}T00:00:00.0", "until": f"{start}T23:59:59.999"},
            {"series": "running", "value": 300, "until": f"{start}T23:59:59.999"},
            {"series": "cycling", "value": None, "until": f"{start}T23:59:59.999"},
        ]


class MaxMetricsApi:
    def __init__(self) -> None:
        self.fallback_calls: list[str] = []

    def get_max_metrics_range(self, _start, _end):
        return [
            {"generic": {"calendarDate": "2025-06-01", "vo2MaxPreciseValue": 51.2}},
            {"cycling": {"calendarDate": "2025-06-02", "vo2MaxPreciseValue": 54.8}},
        ]

    def get_max_metrics(self, day):
        self.fallback_calls.append(day)
        return []


def test_unchanged_activity_skips_deep_garmin_calls(tmp_path):
    summary = {"activityId": 42, "startTimeGMT": "2026-07-30T10:00:00Z", "activityName": "Ride"}
    digest = hashlib.sha256(json.dumps(summary, sort_keys=True, separators=(",", ":"), default=str).encode()).hexdigest()
    writer = Writer()
    api = Api(summary)
    worker = GarminStagingWorker(api, writer, tmp_path, {"42": digest})

    worker._activities(date(2026, 7, 30), date(2026, 7, 30))

    assert api.detail_calls == 0
    assert writer.states == [("42", digest, False)]


def test_multisport_parent_stages_its_child_activities(tmp_path):
    class MultiSportApi:
        def __init__(self) -> None:
            self.calls: list[str] = []

        def get_activity(self, activity_id: str):
            self.calls.append(activity_id)
            return {"activityId": int(activity_id), "summaryDTO": {"startTimeGMT": "2026-07-30T10:00:00.0"}}

    writer = Writer()
    api = MultiSportApi()
    worker = GarminStagingWorker(api, writer, tmp_path)

    worker._multisport_children("100", {"isMultiSportParent": True, "metadataDTO": {"childIds": ["101", "102", "101", "100"]}})

    assert api.calls == ["101", "102"]
    assert [(entity[0], entity[1], entity[-1]["parent_remote_id"]) for entity in writer.entities] == [
        ("activity", "101", "100"),
        ("activity", "102", "100"),
    ]


def test_range_limited_endpoints_are_chunked_and_scheduled_workouts_receive_a_month(tmp_path):
    writer = Writer()
    api = RangeApi()
    worker = GarminStagingWorker(api, writer, tmp_path)

    worker._range(date(2025, 1, 1), date(2025, 7, 1))
    worker._collections()

    body_battery_calls = [arguments for name, arguments in api.calls if name == "get_body_battery"]
    assert len(body_battery_calls) == 26
    assert all((date.fromisoformat(arguments[1]) - date.fromisoformat(arguments[0])).days < 7 for arguments in body_battery_calls)
    menstrual_calls = [arguments for name, arguments in api.calls if name == "get_menstrual_calendar_data"]
    assert len(menstrual_calls) == 3
    assert all((date.fromisoformat(arguments[1]) - date.fromisoformat(arguments[0])).days < 90 for arguments in menstrual_calls)
    scheduled = [arguments for name, arguments in api.calls if name == "get_scheduled_workouts"]
    assert scheduled == [(date.today().year, date.today().month)]


def test_historical_only_sync_skips_non_historical_endpoints_and_respects_activity_window(tmp_path):
    writer = Writer()
    api = RangeApi()
    worker = GarminStagingWorker(api, writer, tmp_path)

    worker.sync(
        daily_from_date=None,
        activity_from_date=date(2025, 1, 1),
        to_date=date(2025, 7, 1),
        activity_to_date=date(2025, 1, 31),
        include_non_historical=False,
    )

    assert [arguments for name, arguments in api.calls if name == "get_activities_by_date"] == [("2025-01-01", "2025-01-31")]
    assert "get_user_profile" not in [name for name, _arguments in api.calls]
    assert "get_workouts" not in [name for name, _arguments in api.calls]


def test_cycling_ftp_history_uses_bounded_ranges_and_stages_date_stable_entities(tmp_path):
    writer = Writer()
    api = FunctionalThresholdPowerApi()
    worker = GarminStagingWorker(api, writer, tmp_path)

    worker._cycling_ftp_history(date(2025, 6, 1), date(2025, 8, 31))

    assert api.calls == [
        ("2025-06-01", "2025-08-29", "CYCLING", "daily"),
        ("2025-08-30", "2025-08-31", "CYCLING", "daily"),
    ]
    assert [(entity[0], entity[1], entity[2]["calendarDate"], entity[-1]["occurred_on"]) for entity in writer.entities] == [
        ("functional_threshold_power", "cycling:2025-06-01", "2025-06-01", "2025-06-01"),
        ("functional_threshold_power", "cycling:2025-08-30", "2025-08-30", "2025-08-30"),
    ]


def test_max_metrics_history_retains_distinct_historical_days(tmp_path):
    writer = Writer()
    api = MaxMetricsApi()
    worker = GarminStagingWorker(api, writer, tmp_path)

    worker._max_metrics_history(date(2025, 6, 1), date(2025, 6, 2))

    assert [(entity[0], entity[1], entity[-1]["occurred_on"]) for entity in writer.entities] == [
        ("max_metric", "max_metrics:2025-06-01", "2025-06-01"),
        ("max_metric", "max_metrics:2025-06-02", "2025-06-02"),
    ]
    assert api.fallback_calls == []
