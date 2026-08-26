"""Generation progress sidecar for Catence Console chat turns.

Mirrors the detached-sync progress pattern (``catence/.../progress-sidecar``):
the in-process agent turn writes a small JSON heartbeat per tool round so a
reconnecting client can tell whether the agent is *still thinking* or *stuck*,
and can recover the in-progress turn instead of staring at a stalled thread.

Both the Console (writer) and the Catence backend (reader) resolve the same
location via ``$CATENCE_HOME`` (exported by ``catence-console serve``).
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

GenerationStage = Literal["running", "completed", "failed", "interrupted", "timed_out"]

TERMINAL_STAGES: set[str] = {"completed", "failed", "interrupted", "timed_out"}
STALE_MS = 5 * 60 * 1000  # 5 minutes without a heartbeat => "stuck"


def _home() -> Path:
    default = Path.home() / ".catence"
    raw = os.environ.get("CATENCE_HOME")
    return Path(raw).expanduser().resolve() if raw else default


def _sidecar_path(thread_id: str) -> Path:
    safe = "".join(c for c in thread_id if c.isalnum() or c in "-_.")
    if not safe:
        safe = "unknown"
    return _home() / "generation" / f"{safe}.generation.json"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def write_generation_sidecar(
    thread_id: str,
    *,
    stage: GenerationStage,
    tool_call_count: int = 0,
    last_tool: str | None = None,
    started_at: str | None = None,
) -> None:
    """Atomically write the generation heartbeat for ``thread_id``."""

    path = _sidecar_path(thread_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    now = _now_iso()
    payload: dict[str, Any] = {
        "threadId": thread_id,
        "stage": stage,
        "heartbeatAt": now,
        "updatedAt": now,
        "toolCallCount": tool_call_count,
        "lastTool": last_tool,
    }
    if started_at:
        payload["startedAt"] = started_at
    elif path.exists():
        # Preserve the original start time across heartbeats.
        try:
            previous = json.loads(path.read_text())
            if previous.get("startedAt"):
                payload["startedAt"] = previous["startedAt"]
        except Exception:
            pass

    tmp = path.with_suffix(".generation.json.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False))
    tmp.replace(path)


def clear_generation_sidecar(thread_id: str) -> None:
    try:
        _sidecar_path(thread_id).unlink(missing_ok=True)
    except Exception:
        pass


def start_generation_sidecar(thread_id: str | None) -> None:
    """Mark a turn as running (records its start time)."""

    if thread_id:
        write_generation_sidecar(
            thread_id, stage="running", tool_call_count=0, started_at=_now_iso()
        )


def update_generation_sidecar(
    thread_id: str | None, *, tool_call_count: int, last_tool: str | None
) -> None:
    """Heartbeat after each tool round so a reconnect can see progress."""

    if thread_id:
        write_generation_sidecar(
            thread_id,
            stage="running",
            tool_call_count=tool_call_count,
            last_tool=last_tool,
        )


def finish_generation_sidecar(
    thread_id: str | None,
    *,
    stage: GenerationStage,
    tool_call_count: int = 0,
    last_tool: str | None = None,
) -> None:
    """Record a terminal stage and remove the sidecar."""

    if thread_id:
        write_generation_sidecar(
            thread_id,
            stage=stage,
            tool_call_count=tool_call_count,
            last_tool=last_tool,
        )
        clear_generation_sidecar(thread_id)


def read_generation_sidecar(thread_id: str) -> dict[str, Any] | None:
    """Read + classify the generation sidecar.

    Returns ``None`` when no sidecar exists, or a dict with ``running`` /
    ``stale`` computed from the heartbeat.
    """

    path = _sidecar_path(thread_id)
    if not path.exists():
        return None

    try:
        data = json.loads(path.read_text())
    except Exception:
        return None

    stage = data.get("stage")
    if stage in TERMINAL_STAGES:
        return {
            **data,
            "running": False,
            "stale": False,
        }

    heartbeat = data.get("heartbeatAt")
    if not heartbeat:
        return {**data, "running": True, "stale": True}

    try:
        hb = datetime.fromisoformat(heartbeat)
        if hb.tzinfo is None:
            hb = hb.replace(tzinfo=timezone.utc)
        age_ms = (datetime.now(timezone.utc) - hb).total_seconds() * 1000
    except Exception:
        age_ms = float("inf")

    return {**data, "running": True, "stale": age_ms > STALE_MS}
