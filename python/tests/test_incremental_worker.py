import hashlib
import json
from datetime import date

from python.catence.providers.garmin.worker import GarminStagingWorker


class Writer:
    def __init__(self) -> None:
        self.states: list[tuple[str, str, bool]] = []

    def archive_json(self, *_args, **_kwargs):
        return "a" * 64

    def source_entity(self, *_args, **_kwargs):
        return None

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


def test_unchanged_activity_skips_deep_garmin_calls(tmp_path):
    summary = {"activityId": 42, "startTimeGMT": "2026-07-30T10:00:00Z", "activityName": "Ride"}
    digest = hashlib.sha256(json.dumps(summary, sort_keys=True, separators=(",", ":"), default=str).encode()).hexdigest()
    writer = Writer()
    api = Api(summary)
    worker = GarminStagingWorker(api, writer, tmp_path, {"42": digest})

    worker._activities(date(2026, 7, 30), date(2026, 7, 30))

    assert api.detail_calls == 0
    assert writer.states == [("42", digest, False)]
