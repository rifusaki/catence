import hashlib
import json
from datetime import date

from python.catence.providers.garmin.worker import GarminStagingWorker, shift_month


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
    # Months run from SCHEDULED_WORKOUTS_MONTHS_BACK to _AHEAD relative to
    # today, each requested exactly once, oldest first.
    expected_months = [shift_month(date.today(), offset) for offset in range(-3, 13)]
    assert scheduled == [(month.year, month.month) for month in expected_months]


def test_scheduled_workout_calendar_items_stage_per_item_and_skip_empty_months(tmp_path):
    class CalendarApi:
        def __init__(self) -> None:
            self.calls: list[tuple[int, int]] = []

        def get_scheduled_workouts(self, year: int, month: int):
            self.calls.append((year, month))
            # Real calendar-service shape: a grid wrapper; exactly one month has items.
            if (year, month) == (2026, 8):
                return {"calendarItems": [
                    {"workoutId": 77, "itemType": "workout", "date": "2026-08-10", "workoutName": "Threshold"},
                    {"id": 555, "itemType": "activity", "date": "2026-08-11", "title": "Morning Ride", "distance": 32100},
                ]}
            return {"calendarItems": []}

    writer = Writer()
    api = CalendarApi()
    worker = GarminStagingWorker(api, writer, tmp_path)

    worker._collections()

    assert len(api.calls) == 16  # months back + current + months ahead
    staged = [entity for entity in writer.entities if entity[0] == "scheduled_workout"]
    assert len(staged) == 1
    endpoint, remote_id_value, item, raw_hash, parent, occurred_on, _kwargs = staged[0]
    assert occurred_on == "2026-08-10"
    assert remote_id_value == "77"
    assert item["workoutName"] == "Threshold"
    # itemType 'activity' entries are echoes of recorded activities; the
    # activities pipeline owns those, so they never stage here.
    assert not [entity for entity in writer.entities if entity[0] == "scheduled_workout" and "555" in str(entity[1])]


def test_garmin_events_default_to_a_short_lookback_and_paginate(tmp_path):
    class EventsApi:
        def __init__(self) -> None:
            self.calls: list[tuple[str, int, int]] = []

        def get_events(self, start_date: str, limit: int = 100, page: int = 1):
            self.calls.append((start_date, limit, page))
            if page == 1:
                return [
                    {"id": 123, "eventName": "Race Day", "date": "2026-09-13", "eventType": "running", "location": "Berlin, DE", "shareableEventUuid": "abc-123"},
                    {"id": 124, "eventName": "Old Race", "date": "2026-02-01", "eventType": "cycling", "location": "Dresden, DE", "shareableEventUuid": "def-456"},
                ]
            return []  # A short final page stops pagination after one call.

    writer = Writer()
    api = EventsApi()
    worker = GarminStagingWorker(api, writer, tmp_path)

    worker._collections()

    # Default lookback is EVENTS_PAST_DAYS before today.
    assert len(api.calls) == 1
    start_date, limit, page = api.calls[0]
    assert (date.today() - date.fromisoformat(start_date)).days == 30
    assert (limit, page) == (100, 1)
    staged = [entity for entity in writer.entities if entity[0] == "event"]
    assert len(staged) == 2
    by_id = {entity[1]: entity for entity in staged}
    assert by_id["123"][5] == "2026-09-13"
    assert by_id["124"][5] == "2026-02-01"


def test_garmin_events_fetch_follows_pagination_until_a_short_page(tmp_path):
    class PagingApi:
        def __init__(self) -> None:
            self.pages: list[int] = []

        def get_events(self, _start_date: str, limit: int = 100, page: int = 1):
            self.pages.append(page)
            count = limit if page == 1 else 20  # A short final page stops pagination.
            return [{"id": f"{page}-{index}", "eventName": f"E{index}", "date": "2026-09-13"} for index in range(count)]

    writer = Writer()
    api = PagingApi()
    worker = GarminStagingWorker(api, writer, tmp_path)

    worker._fetch_garmin_events("2025-08-25")

    assert api.pages == [1, 2]
    staged = [entity for entity in writer.entities if entity[0] == "event"]
    assert len(staged) == 120

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


def test_stage_course_fetches_and_stages_a_course_source_entity(tmp_path):
    class CourseApi:
        def __init__(self) -> None:
            self.calls: list[str] = []

        def connectapi(self, path: str) -> dict[str, object]:
            self.calls.append(path)
            return {"courseId": 507213271, "courseName": "Autumn Half", "geoPoints": [
                {"latitude": 47.3, "longitude": 11.2, "elevation": 540, "distance": 0},
            ]}

    writer = Writer()
    api = CourseApi()
    worker = GarminStagingWorker(api, writer, tmp_path)

    worker.stage_course("507213271")

    assert api.calls == ["course-service/course/507213271"]
    courses = [entity for entity in writer.entities if entity[0] == "course"]
    assert len(courses) == 1
    # entity tuple: (entity_type, remote_id, item, raw_hash, parent_remote_id, occurred_on, kwargs)
    assert courses[0][1] == "507213271"
    assert courses[0][4] == "507213271"


def test_event_course_auto_discovery_stages_each_distinct_course_once(tmp_path):
    class DiscoveryApi:
        def __init__(self) -> None:
            self.course_calls: list[str] = []

        def get_events(self, _start_date, limit=100, page=1):
            return [
                {"id": page * 10 + 1, "eventName": "Race A", "courseId": "507213271"},
                {"id": page * 10 + 2, "eventName": "Race B", "course_id": 507213272},
                {"id": page * 10 + 3, "eventName": "Race A dup", "courseId": "507213271"},
            ]

        def connectapi(self, path):
            self.course_calls.append(path)
            return {"courseId": 507213271, "courseName": f"c{path}", "geoPoints": [
                {"latitude": 1, "longitude": 2, "elevation": 3, "distance": 0},
            ]}

    writer = Writer()
    api = DiscoveryApi()
    worker = GarminStagingWorker(api, writer, tmp_path)

    worker._fetch_garmin_events("2026-08-01")

    # Two distinct courseIds -> one course fetch each; the duplicate courseId is fetched once.
    assert api.course_calls == ["course-service/course/507213271", "course-service/course/507213272"]
    courses = [entity for entity in writer.entities if entity[0] == "course"]
    assert [entity[1] for entity in courses] == ["507213271", "507213272"]


def test_event_course_auto_discovery_skips_already_archived_courses(tmp_path):
    class ArchivedApi:
        def __init__(self) -> None:
            self.course_calls: list[str] = []

        def connectapi(self, path):
            self.course_calls.append(path)
            return {}

        def get_events(self, _start_date, limit=100, page=1):
            return [{"id": 9, "eventName": "Race A", "courseId": "507213271"}]

    archive = tmp_path / "raw" / "garmin" / "course" / "507213271"
    archive.mkdir(parents=True)
    (archive / "existing.json").write_text("{}")

    writer = Writer()
    api = ArchivedApi()
    worker = GarminStagingWorker(api, writer, tmp_path)

    worker._fetch_garmin_events("2026-08-01")

    assert api.course_calls == []
