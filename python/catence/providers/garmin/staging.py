from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import STAGING_SCHEMA_VERSION
from .contracts import validate_record


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def safe_segment(value: str) -> str:
    return "".join(char if char.isalnum() or char in "._-" else "_" for char in value)[:160] or "unknown"


@dataclass
class StagingWriter:
    data_dir: Path
    output: Path

    def __post_init__(self) -> None:
        self.output.parent.mkdir(parents=True, exist_ok=True)
        self.output.touch(exist_ok=True)

    def emit(self, record: dict[str, Any]) -> None:
        record["schemaVersion"] = STAGING_SCHEMA_VERSION
        with self.output.open("a", encoding="utf-8") as file:
            file.write(json.dumps(validate_record(record), separators=(",", ":"), default=str))
            file.write("\n")

    def manifest(self, run_id: str, from_date: str) -> None:
        self.emit({
            "kind": "run_manifest", "provider": "garmin", "runId": run_id,
            "fromDate": from_date, "createdAt": utc_now(),
        })

    def archive_json(self, endpoint: str, remote_id: str | None, payload: Any, scope: dict[str, Any] | None = None) -> str:
        contents = (json.dumps(payload, indent=2, sort_keys=True, default=str) + "\n").encode()
        return self._archive(endpoint, remote_id, contents, "json", "application/json", scope)

    def archive_bytes(self, endpoint: str, remote_id: str | None, contents: bytes, extension: str = "bin", scope: dict[str, Any] | None = None) -> str:
        return self._archive(endpoint, remote_id, contents, extension, "application/octet-stream", scope)

    def _archive(self, endpoint: str, remote_id: str | None, contents: bytes, extension: str, content_type: str, scope: dict[str, Any] | None) -> str:
        digest = hashlib.sha256(contents).hexdigest()
        relative = Path("raw") / "garmin" / safe_segment(endpoint) / safe_segment(remote_id or "collection") / f"{digest}.{extension}"
        destination = self.data_dir / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        if not destination.exists():
            temporary = destination.with_suffix(f".{extension}.tmp")
            temporary.write_bytes(contents)
            os.replace(temporary, destination)
        self.emit({
            "kind": "raw_object", "provider": "garmin", "endpoint": endpoint, "remoteId": remote_id,
            "fetchedAt": utc_now(), "contentHash": digest, "contentType": content_type,
            "relativePath": str(relative), "scope": scope or {},
        })
        return digest

    def source_entity(
        self, entity_type: str, remote_id: str, payload: dict[str, Any], raw_hash: str | None,
        parent_remote_id: str | None = None, occurred_on: str | None = None,
    ) -> None:
        self.emit({
            "kind": "source_entity", "provider": "garmin", "entityType": entity_type,
            "remoteId": str(remote_id), "parentRemoteId": parent_remote_id, "occurredOn": occurred_on,
            "sourceUpdatedAt": None, "rawObjectHash": raw_hash, "payload": payload, "extension": {},
        })

    def activity_sync_state(self, activity_id: str, summary_hash: str, details_fetched: bool) -> None:
        self.emit({
            "kind": "activity_sync_state", "provider": "garmin", "activityRemoteId": activity_id,
            "summaryHash": summary_hash, "detailsFetched": details_fetched,
        })

    def error(self, endpoint: str, message: str, remote_id: str | None = None, retryable: bool = True) -> None:
        self.emit({
            "kind": "extraction_error", "provider": "garmin", "endpoint": endpoint,
            "remoteId": remote_id, "message": message, "retryable": retryable,
        })
