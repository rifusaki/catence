from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def safe_segment(value: str) -> str:
    return "".join(character if character.isalnum() or character in "._-" else "_" for character in value)[:160] or "unknown"


@dataclass
class StravaStagingWriter:
    """Archives the exact HTTP payload before emitting its normalizable envelope."""

    data_dir: Path
    output: Path

    def __post_init__(self) -> None:
        self.output.parent.mkdir(parents=True, exist_ok=True)
        self.output.touch(exist_ok=True)

    def emit(self, record: dict[str, Any]) -> None:
        record["schemaVersion"] = 1
        record["provider"] = "strava"
        with self.output.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(record, separators=(",", ":"), default=str))
            stream.write("\n")

    def manifest(self, run_id: str, from_date: str) -> None:
        self.emit({"kind": "run_manifest", "runId": run_id, "fromDate": from_date, "createdAt": utc_now()})

    def archive_json(self, endpoint: str, remote_id: str | None, payload: Any, scope: dict[str, Any] | None = None) -> str:
        contents = (json.dumps(payload, indent=2, sort_keys=True, default=str) + "\n").encode("utf-8")
        digest = hashlib.sha256(contents).hexdigest()
        relative = Path("raw") / "strava" / safe_segment(endpoint) / safe_segment(remote_id or "collection") / f"{digest}.json"
        destination = self.data_dir / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        if not destination.exists():
            temporary = destination.with_suffix(".json.tmp")
            temporary.write_bytes(contents)
            os.replace(temporary, destination)
        self.emit({
            "kind": "raw_object", "endpoint": endpoint, "remoteId": remote_id,
            "fetchedAt": utc_now(), "contentHash": digest, "contentType": "application/json",
            "relativePath": str(relative), "scope": scope or {},
        })
        return digest

    def source_entity(
        self, entity_type: str, remote_id: str, payload: dict[str, Any], raw_hash: str | None,
        parent_remote_id: str | None = None, occurred_on: str | None = None,
    ) -> None:
        self.emit({
            "kind": "source_entity", "entityType": entity_type, "remoteId": str(remote_id),
            "parentRemoteId": parent_remote_id, "occurredOn": occurred_on,
            "sourceUpdatedAt": payload.get("updated_at") if isinstance(payload.get("updated_at"), str) else None,
            "rawObjectHash": raw_hash, "payload": payload, "extension": {},
        })

    def error(self, endpoint: str, message: str, remote_id: str | None = None, retryable: bool = True) -> None:
        self.emit({
            "kind": "extraction_error", "endpoint": endpoint, "remoteId": remote_id,
            "message": message, "retryable": retryable,
        })
