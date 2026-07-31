from __future__ import annotations

import json
import stat
from argparse import Namespace
from pathlib import Path

from python.catence.providers.strava.cli import SCOPES, StravaConnectionError, StravaReader, matches_activity, read_secret, stage_segment_history, write_secret
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


def test_matcher_requires_the_safe_time_sport_duration_and_distance_window() -> None:
    candidate = {"id": 1, "start_date": "2026-02-01T10:01:00Z", "sport_type": "Ride", "distance": 40_100, "moving_time": 7_180}
    matched, evidence = matches_activity(candidate, "2026-02-01T10:00:00Z", "cycling", 40_000, 7_200)
    assert matched is True
    assert evidence["startDeltaSeconds"] == 60
    virtual = {**candidate, "sport_type": "VirtualRide"}
    matched_virtual, _ = matches_activity(virtual, "2026-02-01T10:00:00Z", "Ride", 40_000, 7_200)
    assert matched_virtual is False
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


def test_scope_set_is_the_minimum_requested_for_targeted_enrichment() -> None:
    assert SCOPES == ["read", "activity:read_all", "read_all"]
