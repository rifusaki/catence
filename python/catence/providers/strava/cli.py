from __future__ import annotations

import argparse
import json
import os
import stat
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .staging import StravaStagingWriter

SCOPES = ["read", "activity:read_all", "read_all"]
READ_ALLOWLIST = {
    "athlete", "gear", "activity_candidates", "activity_detail", "segment", "segment_efforts",
}


class StravaConnectionError(RuntimeError):
    pass


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Stage targeted, read-only Strava data for Catence.")
    parser.add_argument("--mode", required=True, choices=["authorization-url", "auth", "gear", "activity", "segment-history"])
    parser.add_argument("--data-dir", required=True, type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--result", required=True, type=Path)
    parser.add_argument("--run-id")
    parser.add_argument("--code")
    parser.add_argument("--redirect-uri", default="http://localhost")
    parser.add_argument("--activity-id")
    parser.add_argument("--strava-activity-id")
    parser.add_argument("--strava-match-method")
    parser.add_argument("--started-at")
    parser.add_argument("--sport")
    parser.add_argument("--distance-m", type=float)
    parser.add_argument("--elapsed-s", type=float)
    parser.add_argument("--segment-id")
    parser.add_argument("--start-page", type=int, default=1)
    parser.add_argument("--refresh", action="store_true")
    return parser.parse_args()


def secret_path(data_dir: Path) -> Path:
    return data_dir / "secrets" / "strava.json"


def write_secret(data_dir: Path, value: dict[str, Any]) -> None:
    destination = secret_path(data_dir)
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = destination.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True, default=str) + "\n", encoding="utf-8")
    os.chmod(temporary, stat.S_IRUSR | stat.S_IWUSR)
    os.replace(temporary, destination)
    os.chmod(destination, stat.S_IRUSR | stat.S_IWUSR)


def read_secret(data_dir: Path) -> dict[str, Any]:
    destination = secret_path(data_dir)
    try:
        value = json.loads(destination.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise StravaConnectionError("Strava is not connected. Run `catence-data auth strava` first.") from error
    if not isinstance(value, dict) or not value.get("client_id") or not value.get("client_secret") or not value.get("access_token"):
        raise StravaConnectionError("Strava credentials are incomplete. Run `catence-data auth strava` again.")
    return value


def object_value(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if hasattr(value, "model_dump"):
        dumped = value.model_dump()
        return dumped if isinstance(dumped, dict) else {}
    if hasattr(value, "dict"):
        dumped = value.dict()
        return dumped if isinstance(dumped, dict) else {}
    return {}


def timestamp(value: Any) -> float | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def sport_family(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = "".join(character for character in value.lower() if character.isalpha())
    if "ride" in normalized or "cycl" in normalized or "bik" in normalized:
        return "ride"
    if "run" in normalized:
        return "run"
    if "swim" in normalized:
        return "swim"
    if "walk" in normalized:
        return "walk"
    if "strength" in normalized or "weight" in normalized:
        return "strength"
    return normalized or None


def is_virtual_or_indoor(value: Any) -> bool:
    return isinstance(value, str) and ("virtual" in value.lower() or "indoor" in value.lower())


def is_not_found(error: Exception) -> bool:
    message = str(error).lower()
    return "404" in message or "not found" in message or "record not found" in message


def matches_activity(candidate: dict[str, Any], started_at: str, sport: str | None, distance_m: float | None, elapsed_s: float | None) -> tuple[bool, dict[str, Any]]:
    candidate_start = timestamp(candidate.get("start_date"))
    requested_start = timestamp(started_at)
    candidate_distance = candidate.get("distance")
    candidate_elapsed = candidate.get("elapsed_time")
    requested_sport = sport_family(sport)
    candidate_sport = sport_family(candidate.get("sport_type") or candidate.get("type"))
    evidence: dict[str, Any] = {
        "requestedSportFamily": requested_sport,
        "candidateSportFamily": candidate_sport,
        "candidateVirtualOrIndoor": is_virtual_or_indoor(candidate.get("sport_type") or candidate.get("type")),
        "rejectionReasons": [],
    }
    if requested_start is None or candidate_start is None or not isinstance(candidate_distance, (int, float)) or not isinstance(candidate_elapsed, (int, float)):
        evidence["rejectionReasons"] = ["candidate_missing_required_fields"]
        return False, evidence
    if distance_m is None or elapsed_s is None:
        evidence["rejectionReasons"] = ["catence_activity_missing_required_fields"]
        return False, evidence
    start_delta = abs(requested_start - candidate_start)
    duration_delta = abs(elapsed_s - float(candidate_elapsed))
    distance_delta = abs(distance_m - float(candidate_distance))
    duration_limit = max(120.0, elapsed_s * 0.05)
    distance_limit = max(200.0, distance_m * 0.025)
    evidence.update({
        "startDeltaSeconds": start_delta, "elapsedDurationDeltaSeconds": duration_delta,
        "distanceDeltaMeters": distance_delta, "elapsedDurationLimitSeconds": duration_limit,
        "distanceLimitMeters": distance_limit,
    })
    reasons: list[str] = []
    if candidate_sport != requested_sport:
        reasons.append("sport_family_mismatch")
    if start_delta > 90:
        reasons.append("start_time_outside_90_second_window")
    if duration_delta > duration_limit:
        reasons.append("elapsed_duration_outside_tolerance")
    if distance_delta > distance_limit:
        reasons.append("distance_outside_tolerance")
    evidence["rejectionReasons"] = reasons
    return not reasons, evidence


class StravaReader:
    """A raw GET-only adapter around stravalib's OAuth/session support."""

    def __init__(self, data_dir: Path):
        try:
            from stravalib.client import Client
        except ImportError as error:
            raise StravaConnectionError("stravalib is unavailable. Install the Catence Python dependencies before connecting Strava.") from error
        self.data_dir = data_dir
        self.secret = read_secret(data_dir)
        self.client = Client(access_token=str(self.secret["access_token"]))
        self.observed_headers: dict[str, str] = {}
        self._delegate_rate_limiter = self.client.protocol.rate_limiter
        self.client.protocol.rate_limiter = self._capture_rate_headers
        self._refresh_if_needed()

    @staticmethod
    def authorization_url(client_id: str, redirect_uri: str) -> str:
        from stravalib.client import Client
        return Client().authorization_url(client_id=client_id, redirect_uri=redirect_uri, scope=SCOPES)

    @staticmethod
    def exchange_code(data_dir: Path, code: str, redirect_uri: str, client_id: str, client_secret: str) -> dict[str, Any]:
        from stravalib.client import Client
        client = Client()
        token = object_value(client.exchange_code_for_token(client_id=client_id, client_secret=client_secret, code=code))
        token["client_id"] = client_id
        token["client_secret"] = client_secret
        token["redirect_uri"] = redirect_uri
        token["scopes"] = SCOPES
        if not token.get("access_token"):
            raise StravaConnectionError("Strava did not return an access token. Check the authorization code and requested scopes.")
        write_secret(data_dir, token)
        return token

    def _refresh_if_needed(self) -> None:
        expires_at = self.secret.get("expires_at")
        if not isinstance(expires_at, (int, float)) or expires_at > datetime.now(timezone.utc).timestamp() + 60:
            return
        refreshed = object_value(self.client.refresh_access_token(
            client_id=str(self.secret["client_id"]), client_secret=str(self.secret["client_secret"]),
            refresh_token=str(self.secret.get("refresh_token") or ""),
        ))
        if not refreshed.get("access_token"):
            raise StravaConnectionError("Strava token refresh failed. Reconnect with `catence-data auth strava`.")
        self.secret.update(refreshed)
        write_secret(self.data_dir, self.secret)
        self.client.access_token = str(self.secret["access_token"])

    def _capture_rate_headers(self, headers: dict[str, str], method: Any) -> None:
        """Record Strava's rate-limit headers without disabling stravalib's limiter.

        ``ApiV3`` calls its rate limiter after every non-OAuth response with
        ``(response.headers, request_method)``.  Keep the header names stable
        for the TypeScript worker result while delegating to the limiter that
        stravalib installed on the client.
        """
        for name, value in headers.items():
            normalized = str(name).lower()
            if normalized in {"x-ratelimit-limit", "x-ratelimit-usage"}:
                self.observed_headers[normalized] = str(value)
        self._delegate_rate_limiter(headers, method)

    def get(self, endpoint: str, path: str, **params: Any) -> Any:
        if endpoint not in READ_ALLOWLIST:
            raise RuntimeError(f"Strava endpoint {endpoint!r} is not in Catence's GET allowlist.")
        try:
            return self.client.protocol.get(path, **params)
        except Exception as error:
            if "rate" in type(error).__name__.lower() or "429" in str(error):
                raise StravaConnectionError("Strava rate limited this request (HTTP 429).") from error
            raise


def result_path_write(path: Path, result: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(result, indent=2, sort_keys=True, default=str) + "\n", encoding="utf-8")


def stage_gear(reader: StravaReader, writer: StravaStagingWriter) -> dict[str, Any]:
    athlete = object_value(reader.get("athlete", "/athlete"))
    athlete_hash = writer.archive_json("athlete", str(athlete.get("id") or "athlete"), athlete)
    writer.source_entity("athlete", str(athlete.get("id") or "athlete"), athlete, athlete_hash)
    gear_ids = [str(item.get("id")) for key in ("bikes", "shoes") for item in athlete.get(key, []) if isinstance(item, dict) and item.get("id")]
    for gear_id in gear_ids:
        gear = object_value(reader.get("gear", f"/gear/{gear_id}"))
        raw_hash = writer.archive_json("gear", gear_id, gear)
        writer.source_entity("gear", gear_id, gear, raw_hash)
    return {"status": "completed", "gearCount": len(gear_ids), "rateHeaders": reader.observed_headers}


def stage_activity(reader: StravaReader, writer: StravaStagingWriter, args: argparse.Namespace) -> dict[str, Any]:
    direct_lookup_unavailable = False
    if args.strava_activity_id:
        remote_id = str(args.strava_activity_id)
        match_method = args.strava_match_method or "strong_strava_id"
        try:
            detail = object_value(reader.get("activity_detail", f"/activities/{remote_id}", include_all_efforts="true"))
            if str(detail.get("id")) != remote_id:
                raise StravaConnectionError("Strava returned an activity whose ID did not match Catence's provider-supplied Strava ID.")
            detail_hash = writer.archive_json("activity_detail", remote_id, detail, {"activitySourceId": args.activity_id, "includeAllEfforts": True, "matchMethod": match_method})
            writer.source_entity("activity", remote_id, detail, detail_hash)
            gear_id = detail.get("gear_id")
            if isinstance(gear_id, (str, int)) and str(gear_id):
                gear = object_value(reader.get("gear", f"/gear/{gear_id}"))
                gear_hash = writer.archive_json("gear", str(gear_id), gear, {"activityId": remote_id})
                writer.source_entity("gear", str(gear_id), gear, gear_hash)
            return {"status": "completed", "stravaActivityId": remote_id, "rawHash": detail_hash, "matchEvidence": {"method": match_method, "stravaActivityId": remote_id}, "rateHeaders": reader.observed_headers}
        except Exception as error:
            if match_method == "source_strava_id" and is_not_found(error):
                return {
                    "status": "not_found", "stravaActivityId": remote_id,
                    "message": "The source's archived Strava activity ID is not available to the authenticated Strava account.",
                    "matchEvidence": {"method": match_method, "stravaActivityId": remote_id},
                    "matchDiagnostics": {
                        "strategy": "direct_strava_activity_id",
                        "likelyReasons": ["The activity is unavailable to the authenticated Strava account.", "Confirm the connected athlete and that the activity has not been deleted or made inaccessible."],
                    },
                    "rateHeaders": reader.observed_headers,
                }
            if not is_not_found(error):
                raise
            direct_lookup_unavailable = True
    if not args.started_at or not args.sport or args.distance_m is None or args.elapsed_s is None:
        raise StravaConnectionError("Activity hydration requires a start time, sport, distance, and elapsed duration from the Catence activity.")
    start = timestamp(args.started_at)
    if start is None:
        raise StravaConnectionError("The Catence activity has an invalid start time and cannot be matched to Strava.")
    candidates = reader.get("activity_candidates", "/athlete/activities", after=int(start - 90), before=int(start + 90), page=1, per_page=200)
    if not isinstance(candidates, list):
        candidates = []
    candidates_hash = writer.archive_json("activity_candidates", args.activity_id, candidates, {"activitySourceId": args.activity_id})
    qualified: list[tuple[dict[str, Any], dict[str, Any]]] = []
    rejection_counts: dict[str, int] = {}
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        accepted, evidence = matches_activity(candidate, args.started_at, args.sport, args.distance_m, args.elapsed_s)
        if accepted:
            qualified.append((candidate, evidence))
        else:
            for reason in evidence.get("rejectionReasons", []):
                rejection_counts[reason] = rejection_counts.get(reason, 0) + 1
    if len(qualified) != 1:
        search_start = datetime.fromtimestamp(start - 90, timezone.utc).isoformat().replace("+00:00", "Z")
        search_end = datetime.fromtimestamp(start + 90, timezone.utc).isoformat().replace("+00:00", "Z")
        if not candidates:
            likely_reasons = [
                "Strava returned no activities in the exact ±90-second search window.",
                "Confirm that Catence is connected to the same Strava athlete and that activity:read_all access includes the activity.",
                "A private, deleted, or differently timestamped Strava activity cannot be matched from this result.",
            ]
        elif not qualified:
            likely_reasons = ["Strava returned activities, but none met Catence's safe sport, time, elapsed-duration, and distance tolerances."]
        else:
            likely_reasons = ["More than one Strava activity met the safe matching tolerances; Catence will not choose one automatically."]
        return {
            "status": "not_found" if not qualified else "ambiguous", "candidateCount": len(qualified),
            "candidatesRawHash": candidates_hash,
            "matchDiagnostics": {
                "strategy": "time_sport_distance",
                "searchWindow": {"startAt": search_start, "endAt": search_end},
                "returnedCandidateCount": len(candidates), "qualifiedCandidateCount": len(qualified),
                "rejectionCounts": rejection_counts, "directLookupUnavailable": direct_lookup_unavailable,
                "likelyReasons": likely_reasons,
            },
            "rateHeaders": reader.observed_headers,
        }
    selected, evidence = qualified[0]
    remote_id = str(selected["id"])
    detail = object_value(reader.get("activity_detail", f"/activities/{remote_id}", include_all_efforts="true"))
    detail_hash = writer.archive_json("activity_detail", remote_id, detail, {"activitySourceId": args.activity_id, "includeAllEfforts": True})
    writer.source_entity("activity", remote_id, detail, detail_hash, occurred_on=str(detail.get("start_date") or "")[:10] or None)
    gear_id = detail.get("gear_id")
    if isinstance(gear_id, (str, int)) and str(gear_id):
        gear = object_value(reader.get("gear", f"/gear/{gear_id}"))
        gear_hash = writer.archive_json("gear", str(gear_id), gear, {"activityId": remote_id})
        writer.source_entity("gear", str(gear_id), gear, gear_hash)
    return {"status": "completed", "stravaActivityId": remote_id, "rawHash": detail_hash, "matchEvidence": evidence, "rateHeaders": reader.observed_headers}


def stage_segment_history(reader: StravaReader, writer: StravaStagingWriter, args: argparse.Namespace) -> dict[str, Any]:
    if not args.segment_id:
        raise StravaConnectionError("Segment history hydration requires a persisted Strava segment ID.")
    segment = object_value(reader.get("segment", f"/segments/{args.segment_id}"))
    segment_hash = writer.archive_json("segment", args.segment_id, segment)
    writer.source_entity("segment", args.segment_id, segment, segment_hash)
    page = max(1, args.start_page)
    effort_count = 0
    while True:
        try:
            efforts = reader.get("segment_efforts", "/segment_efforts", segment_id=args.segment_id, page=page, per_page=200)
        except StravaConnectionError as error:
            if "rate limited" in str(error).lower():
                return {"status": "partial", "segmentId": args.segment_id, "effortCount": effort_count, "continuationPage": page, "message": str(error), "rateHeaders": reader.observed_headers}
            raise
        if not isinstance(efforts, list):
            efforts = []
        raw_hash = writer.archive_json("segment_efforts", args.segment_id, efforts, {"segmentId": args.segment_id, "page": page})
        for effort in efforts:
            if not isinstance(effort, dict) or not effort.get("id"):
                continue
            effort.setdefault("segment", segment)
            writer.source_entity("segment_effort", str(effort["id"]), effort, raw_hash, parent_remote_id=args.segment_id, occurred_on=str(effort.get("start_date") or "")[:10] or None)
            effort_count += 1
        if len(efforts) < 200:
            return {"status": "completed", "segmentId": args.segment_id, "effortCount": effort_count, "lastCompletedPage": page, "rateHeaders": reader.observed_headers}
        page += 1


def main() -> None:
    args = parse_args()
    client_id = os.environ.get("STRAVA_CLIENT_ID")
    client_secret = os.environ.get("STRAVA_CLIENT_SECRET")
    try:
        if args.mode == "authorization-url":
            if not client_id:
                raise StravaConnectionError("STRAVA_CLIENT_ID is required to begin Strava authorization.")
            result_path_write(args.result, {"status": "authorization_required", "authorizationUrl": StravaReader.authorization_url(client_id, args.redirect_uri), "scopes": SCOPES})
            return
        if args.mode == "auth":
            if not args.code or not client_id or not client_secret:
                raise StravaConnectionError("STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, and --code are required to complete Strava authorization.")
            token = StravaReader.exchange_code(args.data_dir, args.code, args.redirect_uri, client_id, client_secret)
            result_path_write(args.result, {"status": "connected", "athleteId": object_value(token.get("athlete")).get("id"), "scopes": SCOPES})
            return
        if not args.output or not args.run_id:
            raise StravaConnectionError("Strava read operations require --output and --run-id.")
        writer = StravaStagingWriter(args.data_dir, args.output)
        writer.manifest(args.run_id, datetime.now(timezone.utc).date().isoformat())
        reader = StravaReader(args.data_dir)
        if args.mode == "gear":
            result = stage_gear(reader, writer)
        elif args.mode == "activity":
            result = stage_activity(reader, writer, args)
        else:
            result = stage_segment_history(reader, writer, args)
        result_path_write(args.result, result)
    except Exception as error:
        result_path_write(args.result, {"status": "partial" if "rate limited" in str(error).lower() else "error", "message": str(error)})
        raise SystemExit(str(error))


if __name__ == "__main__":
    main()
