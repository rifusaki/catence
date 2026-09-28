"""Progress reporting for Garmin sync runs.

Emits single-line JSON progress records (kind: 'progress') on stdout so the
Node management layer can persist heartbeats without parsing the staging
JSONL consumed by the importer. Captures run on several threads once sync
concurrency is enabled, so every state mutation happens under a lock while
the actual emit stays outside it.

The reporter also accumulates per-stage wall-clock timings; the CLI prints
them to stderr as a single `stage_timings` record so each sync run carries
its own phase profile.
"""

from __future__ import annotations

import json
import threading
import time
from datetime import datetime, timezone
from typing import Any, Callable


class ProgressReporter:
    """Throttled, thread-safe progress publisher writing NDJSON records to stdout."""

    def __init__(
        self,
        run_id: str,
        provider: str = "garmin",
        emit: Callable[[str], None] = lambda line: print(line, flush=True),
        interval_seconds: float = 2.0,
    ) -> None:
        self.run_id = run_id
        self.provider = provider
        self.emit = emit
        self.interval_seconds = interval_seconds
        self._lock = threading.Lock()
        self._started = time.monotonic()
        self._last_emitted = 0.0
        self._stage_started = self._started
        self.stage = "starting"
        self.current_step: str | None = None
        self.completed_units = 0
        self.total_units: int | None = None
        self.stage_timings: dict[str, float] = {}

    def set_stage(self, stage: str) -> None:
        """Switch phases, resetting phase-local counters and forcing a publish."""
        with self._lock:
            if stage == self.stage:
                return
            self._close_stage_locked()
            self.stage = stage
            self.current_step = None
            self.completed_units = 0
            self.total_units = None
        self.publish(force=True)

    def advance(self, completed: int | None = None, total: int | None = None, step: str | None = None) -> None:
        with self._lock:
            if completed is not None:
                self.completed_units = completed
            if total is not None:
                self.total_units = total
            if step is not None:
                self.current_step = step
        self.publish()

    def add_completed(self, amount: int = 1) -> None:
        """Increment the completed-unit counter without replacing it."""
        with self._lock:
            self.completed_units += amount
        self.publish()

    def publish(self, force: bool = False) -> None:
        now = time.monotonic()
        with self._lock:
            if not force and now - self._last_emitted < self.interval_seconds:
                return
            self._last_emitted = now
            elapsed = now - self._started
            percent = 0.0
            eta: float | None = None
            if self.total_units and self.total_units > 0:
                percent = min(100.0, max(0.0, self.completed_units / self.total_units * 100.0))
                if 0 < self.completed_units < self.total_units:
                    rate = elapsed / self.completed_units
                    eta = rate * (self.total_units - self.completed_units)
            record: dict[str, Any] = {
                "kind": "progress",
                "runId": self.run_id,
                "provider": self.provider,
                "stage": self.stage,
                "currentStep": self.current_step,
                "completedUnits": self.completed_units,
                "totalUnits": self.total_units,
                "percentComplete": round(percent, 2),
                "elapsedSeconds": round(elapsed, 1),
                "estimatedRemainingSeconds": round(eta, 1) if eta is not None else None,
                "heartbeatAt": datetime.now(timezone.utc).isoformat(),
            }
        # Emitting outside the lock keeps a slow pipe from stalling captures.
        self.emit(json.dumps(record, separators=(",", ":")))

    def stage_summary(self) -> dict[str, float]:
        """Per-stage elapsed seconds, including the still-open stage."""
        with self._lock:
            summary = dict(self.stage_timings)
            summary[self.stage] = summary.get(self.stage, 0.0) + (time.monotonic() - self._stage_started)
        return summary

    def finish(self, stage: str = "completed") -> None:
        with self._lock:
            self._close_stage_locked()
            self.stage = stage
            self._stage_started = time.monotonic()
        self.publish(force=True)

    def _close_stage_locked(self) -> None:
        self.stage_timings[self.stage] = self.stage_timings.get(self.stage, 0.0) + (time.monotonic() - self._stage_started)
        self._stage_started = time.monotonic()
