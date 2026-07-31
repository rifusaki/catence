from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from . import STAGING_SCHEMA_VERSION


class StagingRecord(BaseModel):
    """Shared JSONL envelope; Node performs the final discriminated validation."""

    model_config = ConfigDict(extra="allow")
    kind: Literal["run_manifest", "raw_object", "source_entity", "stream_manifest", "activity_sync_state", "extraction_error"]
    schemaVersion: Literal[STAGING_SCHEMA_VERSION] = STAGING_SCHEMA_VERSION
    provider: Literal["garmin"] = "garmin"
    payload: dict[str, Any] | None = None


def validate_record(record: dict[str, Any]) -> dict[str, Any]:
    return StagingRecord.model_validate(record).model_dump(exclude_none=False) | {
        key: value for key, value in record.items() if key not in {"kind", "schemaVersion", "provider", "payload"}
    }
