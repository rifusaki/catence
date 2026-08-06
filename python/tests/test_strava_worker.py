from __future__ import annotations

import json
import stat
from argparse import Namespace
from pathlib import Path

from python.catence.providers.strava.cli import SCOPES, StravaConnectionError, StravaReader, matches_activity, read_secret, stage_activity, stage_segment_history, write_secret
from python.catence.providers.strava.staging import StravaStagingWriter


def test_secret_is_owner_only_and_never_enters_staging(tmp_path: Path) -> None:
    write_secret(tmp_path, {"client_id": "id", "client_secret": "secret", "access_token": "token"})
    secret = tmp_path / "secrets" / "strava.json"
    assert read_secret(tmp_path)["access_token"] == "token"
    assert stat.S_IMODE(secret.stat().st_mode) == 0o600

    output = tmp_path / "staging" / "strava" / "test.jsonl"
    writer = StravaStagingWriter(tmp_path, output)
    writer.manifest("00000000-0000-4000-8000-000000000000", "2026-02-01")
    writer.archive_json("athlete", "1", {"id": 1})
    contents = output.read_text()
    assert "access_token" not in contents
    assert "client_secret" not in contents


def test_matcher_uses_elapsed_time_and_normalized_sport_families() -> None:
    candidate = {"id": 1, "start_date": "2026-02-01T10:01:00Z", "sport_type": "Ride", "distance": 40_100, "elapsed_time": 7_180}
    matched, evidence = matches_activity(candidate, "2026-02-01T10:00:00Z", "cycling", 40_000, 7_200)
    assert matched is True
    assert evidence["startDeltaSeconds"] == 60
    virtual = {**candidate, "sport_type": "VirtualRide"}
    matched_virtual, _ = matches_activity(virtual, "2026-02-01T10:00:00Z", "road_biking", 40_000, 7_200)
    assert matched_virtual is True
    strength = {**candidate, "sport_type": "WeightTraining", "distance": 0, "elapsed_time": 3_600}
    assert matches_activity(strength, "2026-02-01T10:00:00Z", "strength_training", 0, 3_600)[0] is True
    outside, _ = matches_activity({**candidate, "start_date": "2026-02-01T10:01:31Z"}, "2026-02-01T10:00:00Z", "Ride", 40_000, 7_200)
    assert outside is False


def test_segment_history_resumes_and_returns_a_partial_rate_limited_state(tmp_path: Path) -> None:
    output = tmp_path / "stage.jsonl"
    writer = StravaStagingWriter(tmp_path, output)
    calls: list[tuple[str, int | None]] = []

    class Reader:
        observed_headers = {"x-ratelimit-limit": "100,1000"}

        def get(self, endpoint: str, _path: str, **params: object) -> object:
            calls.append((endpoint, params.get("page") if isinstance(params.get("page"), int) else None))
            if endpoint == "segment":
                return {"id": "42", "name": "Climb", "starred": True}
            raise StravaConnectionError("Strava rate limited this request (HTTP 429).")

    result = stage_segment_history(Reader(), writer, Namespace(segment_id="42", start_page=3))
    assert result["status"] == "partial"
    assert result["continuationPage"] == 3
    assert calls == [("segment", None), ("segment_efforts", 3)]


def test_rate_header_capture_preserves_the_stravalib_limiter() -> None:
    reader = object.__new__(StravaReader)
    reader.observed_headers = {}
    delegated: list[tuple[dict[str, str], str]] = []
    reader._delegate_rate_limiter = lambda headers, method: delegated.append((headers, method))

    reader._capture_rate_headers({"X-RateLimit-Limit": "100,1000", "x-ratelimit-usage": "2,20", "Content-Type": "application/json"}, "GET")

    assert reader.observed_headers == {"x-ratelimit-limit": "100,1000", "x-ratelimit-usage": "2,20"}
    assert delegated == [({"X-RateLimit-Limit": "100,1000", "x-ratelimit-usage": "2,20", "Content-Type": "application/json"}, "GET")]


def test_activity_hydration_uses_the_provider_supplied_strava_id_directly(tmp_path: Path) -> None:
    output = tmp_path / "stage.jsonl"
    writer = StravaStagingWriter(tmp_path, output)
    calls: list[tuple[str, str]] = []

    class Reader:
        observed_headers = {"x-ratelimit-limit": "100,1000"}

        def get(self, endpoint: str, path: str, **_params: object) -> object:
            calls.append((endpoint, path))
            if endpoint == "activity_detail":
                return {"id": 23408388054, "gear_id": "bike-1", "segment_efforts": []}
            return {"id": "bike-1", "name": "Road bike"}

    result = stage_activity(Reader(), writer, Namespace(activity_id="intervals:i162943791", strava_activity_id="23408388054", strava_match_method="source_strava_id", started_at=None, sport=None, distance_m=None, elapsed_s=None))

    assert result["status"] == "completed"
    assert result["matchEvidence"] == {"method": "source_strava_id", "stravaActivityId": "23408388054"}
    assert calls == [("activity_detail", "/activities/23408388054"), ("gear", "/gear/bike-1")]


def test_activity_hydration_falls_back_to_timestamp_matching_after_a_missing_strava_id(tmp_path: Path) -> None:
    output = tmp_path / "stage.jsonl"
    writer = StravaStagingWriter(tmp_path, output)
    calls: list[tuple[str, str]] = []

    class Reader:
        observed_headers: dict[str, str] = {}

        def get(self, endpoint: str, path: str, **_params: object) -> object:
            calls.append((endpoint, path))
            if path == "/activities/22995929424":
                raise StravaConnectionError("Not Found: Record Not Found: []")
            if endpoint == "activity_candidates":
                return [{"id": 18635626846, "start_date": "2026-05-24T12:24:15Z", "sport_type": "Ride", "distance": 7_000, "elapsed_time": 670}]
            return {"id": 18635626846, "segment_efforts": []}

    result = stage_activity(Reader(), writer, Namespace(activity_id="intervals:i151098464", strava_activity_id="22995929424", strava_match_method="linked_strava_source", started_at="2026-05-24T12:24:15Z", sport="Ride", distance_m=7_000, elapsed_s=670))

    assert result["status"] == "completed"
    assert result["stravaActivityId"] == "18635626846"
    assert calls == [("activity_detail", "/activities/22995929424"), ("activity_candidates", "/athlete/activities"), ("activity_detail", "/activities/18635626846")]


def test_source_strava_id_does_not_fall_back_to_a_different_activity(tmp_path: Path) -> None:
    writer = StravaStagingWriter(tmp_path, tmp_path / "stage.jsonl")

    class Reader:
        observed_headers: dict[str, str] = {}

        def get(self, _endpoint: str, _path: str, **_params: object) -> object:
            raise StravaConnectionError("Not Found: Record Not Found: []")

    result = stage_activity(Reader(), writer, Namespace(activity_id="intervals:i151098464", strava_activity_id="18635626894", strava_match_method="source_strava_id", started_at="2026-05-24T13:00:57Z", sport="Ride", distance_m=21_064, elapsed_s=2_170))

    assert result["status"] == "not_found"
    assert result["stravaActivityId"] == "18635626894"


def test_activity_hydration_reports_a_search_window_when_strava_returns_no_candidates(tmp_path: Path) -> None:
    writer = StravaStagingWriter(tmp_path, tmp_path / "stage.jsonl")

    class Reader:
        observed_headers: dict[str, str] = {}

        def get(self, endpoint: str, _path: str, **_params: object) -> object:
            assert endpoint == "activity_candidates"
            return []

    result = stage_activity(Reader(), writer, Namespace(activity_id="garmin:1", strava_activity_id=None, strava_match_method=None, started_at="2026-05-24T13:00:57Z", sport="Ride", distance_m=21_064, elapsed_s=2_170))

    assert result["status"] == "not_found"
    assert result["candidateCount"] == 0
    assert result["matchDiagnostics"] == {
        "strategy": "time_sport_distance",
        "searchWindow": {"startAt": "2026-05-24T12:59:27Z", "endAt": "2026-05-24T13:02:27Z"},
        "returnedCandidateCount": 0,
        "qualifiedCandidateCount": 0,
        "rejectionCounts": {},
        "directLookupUnavailable": False,
        "likelyReasons": [
            "Strava returned no activities in the exact ±90-second search window.",
            "Confirm that Catence is connected to the same Strava athlete and that activity:read_all access includes the activity.",
            "A private, deleted, or differently timestamped Strava activity cannot be matched from this result.",
        ],
    }


def test_scope_set_is_the_minimum_requested_for_targeted_enrichment() -> None:
    assert SCOPES == ["read", "activity:read_all", "read_all"]
