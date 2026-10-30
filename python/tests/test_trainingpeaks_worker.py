from __future__ import annotations

import asyncio
import json
from datetime import date
from pathlib import Path
from typing import Any

import pytest

from python.catence.providers.trainingpeaks.cli import load_known_workout_ids
from python.catence.providers.trainingpeaks.registry import TP_READ_ENDPOINTS, assert_read_only_registry
from python.catence.providers.trainingpeaks.staging import StagingWriter
from python.catence.providers.trainingpeaks.worker import (
    AUTH_EXPIRED_ERROR,
    TrainingPeaksStagingWorker,
    payload_day,
    structure_summary,
    workout_remote_id,
    zone_setting_payloads,
)

RUN_ID = "00000000-0000-4000-8000-000000000000"


class FakeResponse:
    def __init__(self, data: Any = None, error_code: str | None = None, message: str | None = None) -> None:
        self.data = data
        self.is_error = error_code is not None
        self.error_code = error_code
        self.message = message


class FakeClient:
    """Only the surface the worker is allowed to call; anything else raises."""

    def __init__(self, athlete_id: int = 4242, responses: dict[str, FakeResponse] | None = None) -> None:
        self.athlete_id = athlete_id
        self.responses = responses or {}
        self.calls: list[str] = []

    async def ensure_athlete_id(self) -> int | None:
        return self.athlete_id

    async def get(self, endpoint: str) -> FakeResponse:
        self.calls.append(endpoint)
        for prefix, response in self.responses.items():
            if endpoint.startswith(prefix):
                return response
        return FakeResponse(data={})


def read_records(output: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in output.read_text(encoding="utf-8").splitlines() if line.strip()]


def make_writer(tmp_path: Path) -> StagingWriter:
    output = tmp_path / "staging" / "trainingpeaks" / f"{RUN_ID}.jsonl"
    writer = StagingWriter(tmp_path, output)
    writer.manifest(RUN_ID, "2026-03-01")
    return writer


def test_registry_is_read_only_and_covers_only_phase_one_families() -> None:
    assert_read_only_registry()
    assert set(TP_READ_ENDPOINTS) == {"planned_workouts", "zones", "athlete_settings"}


def test_planned_workouts_are_staged_with_raw_archive(tmp_path: Path) -> None:
    client = FakeClient(responses={
        "/fitness/v6/athletes/4242/workouts": FakeResponse(data=[
            {"workoutId": 101, "workoutDay": "2026-03-02", "title": "Threshold", "description": "4x8",
             "sport": "Bike", "workoutTypeId": 2, "durationPlanned": 5400, "distancePlanned": 30000,
             "tssPlanned": 85, "ifPlanned": 0.92, "structure": {"blocks": [{"type": "Warmup", "totalDuration": 600}]},
             "coachComments": [{"comment": "go"}], "athleteComments": []},
        ]),
    })
    writer = make_writer(tmp_path)
    worker = TrainingPeaksStagingWorker(client, writer, today=date(2026, 3, 1))
    asyncio.run(worker.sync(date(2026, 3, 1)))
    records = read_records(writer.output)
    kinds = {record["kind"] for record in records}
    assert "run_manifest" in kinds
    assert "raw_object" in kinds
    entities = [record for record in records if record["kind"] == "source_entity"]
    planned = [record for record in entities if record["entityType"] == "planned_workout"]
    assert len(planned) == 1
    assert planned[0]["remoteId"] == "101"
    assert planned[0]["occurredOn"] == "2026-03-02"
    assert planned[0]["provider"] == "trainingpeaks"
    assert planned[0]["payload"]["tssPlanned"] == 85
    profile = [record for record in entities if record["entityType"] == "profile"]
    assert len(profile) == 1


def test_zone_settings_fan_out_per_metric_group(tmp_path: Path) -> None:
    # Key names mirror the live /fitness/v1/athletes/{id}/settings payload.
    settings = {
        "powerZones": [{"workoutTypeId": 2, "threshold": 260, "calculationMethod": "PercentOfThreshold", "zones": [{"minimum": 0, "maximum": 150}]}],
        "heartRateZones": [{"workoutTypeId": 2, "threshold": 168, "zones": [{"minimum": 0, "maximum": 140}]}],
        "speedZones": [{"workoutTypeId": 3, "threshold": 4.2, "zones": [{"minimum": 0, "maximum": 3.0}]}],
    }
    client = FakeClient(responses={"/fitness/v1/athletes/4242/settings": FakeResponse(data=settings)})
    writer = make_writer(tmp_path)
    worker = TrainingPeaksStagingWorker(client, writer, today=date(2026, 3, 1))
    asyncio.run(worker.sync(date(2026, 3, 1)))
    entities = [record for record in read_records(writer.output) if record["kind"] == "source_entity"]
    zones = [record for record in entities if record["entityType"] == "zone_setting"]
    assert sorted(record["remoteId"] for record in zones) == ["2:heartrate", "2:power", "3:speed"]
    for zone in zones:
        assert zone["payload"]["threshold"] is not None


def test_expired_cookie_maps_to_actionable_error(tmp_path: Path) -> None:
    client = FakeClient(responses={
        "/users/v3/user": FakeResponse(data={"user": {"personId": 4242}}),
        "/fitness/v1/athletes/4242/settings": FakeResponse(error_code="AUTH_EXPIRED", message="Cookie expired"),
        "/fitness/v6/athletes/4242/workouts": FakeResponse(error_code="AUTH_EXPIRED", message="Cookie expired"),
    })
    writer = make_writer(tmp_path)
    worker = TrainingPeaksStagingWorker(client, writer, today=date(2026, 3, 1))
    asyncio.run(worker.sync(date(2026, 3, 1)))
    errors = [record for record in read_records(writer.output) if record["kind"] == "extraction_error"]
    assert len(errors) == 2
    for error in errors:
        assert error["retryable"] is False
        assert AUTH_EXPIRED_ERROR in error["message"]


def test_failed_zone_family_does_not_block_planned_workouts(tmp_path: Path) -> None:
    client = FakeClient(responses={
        "/fitness/v1/athletes/4242/settings": FakeResponse(error_code="API_ERROR", message="route changed"),
        "/fitness/v6/athletes/4242/workouts": FakeResponse(data=[{"workoutId": 7, "workoutDay": "2026-03-03"}]),
    })
    writer = make_writer(tmp_path)
    worker = TrainingPeaksStagingWorker(client, writer, today=date(2026, 3, 1))
    asyncio.run(worker.sync(date(2026, 3, 1)))
    records = read_records(writer.output)
    entities = [record for record in records if record["kind"] == "source_entity"]
    assert any(record["entityType"] == "planned_workout" for record in entities)
    errors = [record for record in records if record["kind"] == "extraction_error"]
    assert len(errors) == 1
    assert errors[0]["endpoint"] == "settings"


def test_cookie_never_enters_staging(tmp_path: Path) -> None:
    secret_cookie = "super-secret-cookie-value"
    client = FakeClient(responses={"/fitness/v6/athletes/4242/workouts": FakeResponse(data=[{"workoutId": 1}])})
    writer = make_writer(tmp_path)
    worker = TrainingPeaksStagingWorker(client, writer, today=date(2026, 3, 1))
    asyncio.run(worker.sync(date(2026, 3, 1)))
    staging_text = writer.output.read_text(encoding="utf-8")
    assert secret_cookie not in staging_text
    for archive in (tmp_path / "raw" / "trainingpeaks").rglob("*.json"):
        assert secret_cookie not in archive.read_text(encoding="utf-8")


def test_planned_workout_window_defaults_to_today_plus_14_days(tmp_path: Path) -> None:
    client = FakeClient()
    writer = make_writer(tmp_path)
    worker = TrainingPeaksStagingWorker(client, writer, today=date(2026, 3, 1))
    asyncio.run(worker.sync(date(2026, 3, 1)))
    assert any(call == "/fitness/v6/athletes/4242/workouts/2026-03-01/2026-03-15" for call in client.calls)


def test_known_past_workouts_are_not_re_staged_but_unknown_past_ones_accumulate(tmp_path: Path) -> None:
    client = FakeClient(responses={
        "/fitness/v6/athletes/4242/workouts": FakeResponse(data=[
            {"workoutId": 1, "workoutDay": "2026-02-10", "title": "Already stored"},
            {"workoutId": 2, "workoutDay": "2026-02-12", "title": "Never stored"},
            {"workoutId": 1, "workoutDay": "2026-03-10", "title": "Known but future"},
        ]),
    })
    writer = make_writer(tmp_path)
    worker = TrainingPeaksStagingWorker(client, writer, today=date(2026, 3, 1), known_workout_ids=["1"])
    asyncio.run(worker.sync(date(2026, 2, 1)))
    entities = [record for record in read_records(writer.output) if record["kind"] == "source_entity"]
    planned = {record["remoteId"]: record for record in entities if record["entityType"] == "planned_workout"}
    assert "1" in planned and planned["1"]["occurredOn"] == "2026-03-10"
    assert "2" in planned and planned["2"]["occurredOn"] == "2026-02-12"
    assert planned["1"]["payload"]["title"] == "Known but future"


def test_todays_workout_is_refreshed_even_when_known(tmp_path: Path) -> None:
    # Today is not history: the workout may still change or complete during
    # the day, so a known id must not suppress re-staging until tomorrow.
    client = FakeClient(responses={
        "/fitness/v6/athletes/4242/workouts": FakeResponse(data=[{"workoutId": 9, "workoutDay": "2026-03-01"}]),
    })
    writer = make_writer(tmp_path)
    worker = TrainingPeaksStagingWorker(client, writer, today=date(2026, 3, 1), known_workout_ids=["9"])
    asyncio.run(worker.sync(date(2026, 2, 1)))
    entities = [record for record in read_records(writer.output) if record["kind"] == "source_entity"]
    assert any(record["remoteId"] == "9" for record in entities if record["entityType"] == "planned_workout")


def test_workout_without_a_parseable_day_is_staged_rather_than_dropped(tmp_path: Path) -> None:
    client = FakeClient(responses={
        "/fitness/v6/athletes/4242/workouts": FakeResponse(data=[{"workoutId": 5, "title": "No day"}]),
    })
    writer = make_writer(tmp_path)
    worker = TrainingPeaksStagingWorker(client, writer, today=date(2026, 3, 1), known_workout_ids=["5"])
    asyncio.run(worker.sync(date(2026, 2, 1)))
    entities = [record for record in read_records(writer.output) if record["kind"] == "source_entity"]
    assert any(record["remoteId"] == "5" for record in entities if record["entityType"] == "planned_workout")


def test_known_past_workouts_are_skipped_only_after_the_raw_archive(tmp_path: Path) -> None:
    # The whole-response archive must exist even when every past workout is
    # skipped: the raw payload remains the durable record of the fetch.
    client = FakeClient(responses={
        "/fitness/v6/athletes/4242/workouts": FakeResponse(data=[{"workoutId": 1, "workoutDay": "2026-02-10"}]),
    })
    writer = make_writer(tmp_path)
    worker = TrainingPeaksStagingWorker(client, writer, today=date(2026, 3, 1), known_workout_ids=["1"])
    asyncio.run(worker.sync(date(2026, 2, 1)))
    records = read_records(writer.output)
    assert any(record["kind"] == "raw_object" for record in records)
    assert not any(record["kind"] == "source_entity" and record["entityType"] == "planned_workout" for record in records)


def test_load_known_workout_ids_reads_optional_json_array(tmp_path: Path) -> None:
    assert load_known_workout_ids(None) == set()
    assert load_known_workout_ids(tmp_path / "absent.json") == set()
    known = tmp_path / "known.json"
    known.write_text(json.dumps([101, "102"]), encoding="utf-8")
    assert load_known_workout_ids(known) == {"101", "102"}


def test_default_zone_group_inherits_into_populated_sports() -> None:
    # Martina-shaped payload: HR and power exist only as the common (type 0)
    # group; speed is populated per sport. The common groups must inherit into
    # the populated sports that lack their own group for that metric.
    settings = {
        "heartRateZones": [{"workoutTypeId": 0, "threshold": 178}],
        "powerZones": [{"workoutTypeId": 0, "threshold": 177}],
        "speedZones": [
            {"workoutTypeId": 3, "threshold": 4.35},
            {"workoutTypeId": 2, "threshold": 8.85},
            {"workoutTypeId": 1, "threshold": 0.83},
            {"workoutTypeId": 0, "threshold": 3.70},
        ],
    }
    entities = zone_setting_payloads(settings)
    by_remote_id = {remote_id: payload["threshold"] for remote_id, payload in entities}
    # Common HR inherits into bike and run; common power into bike; the common
    # speed group is superseded by the per-sport groups and inherits nowhere.
    assert by_remote_id["2:heartrate"] == 178
    assert by_remote_id["3:heartrate"] == 178
    assert by_remote_id["2:power"] == 177
    assert "2:speed" not in by_remote_id and "3:speed" not in by_remote_id
    assert by_remote_id["3:speed:0"] == 4.35
    assert by_remote_id["2:speed:1"] == 8.85
    assert by_remote_id["1:speed:2"] == 0.83


def test_default_zone_group_fans_out_when_no_sport_is_populated() -> None:
    settings = {
        "heartRateZones": [{"workoutTypeId": 0, "threshold": 165}],
        "powerZones": [{"workoutTypeId": 0, "threshold": 240}],
        "speedZones": [{"workoutTypeId": 0, "threshold": 3.1}],
    }
    entities = zone_setting_payloads(settings)
    assert sorted(remote_id for remote_id, _ in entities) == ["2:heartrate", "2:power", "3:heartrate", "3:speed"]


def test_helpers() -> None:
    assert payload_day({"workoutDay": "2026-03-02T10:00:00"}) == "2026-03-02"
    assert workout_remote_id({"workoutId": 5}, "fallback") == "5"
    assert workout_remote_id({"title": "x"}, "fallback") == "fallback"
    assert structure_summary({"structure": {"blocks": [{"type": "Warmup", "totalDuration": 600}]}}) == [
        {"type": "Warmup", "repeatCount": None, "totalDuration": 600, "totalDistance": None},
    ]
    assert zone_setting_payloads({"settings": {}}) == []
