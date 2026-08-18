"""Progress reporting for Garmin sync runs.

Emits single-line JSON progress records (kind: 'progress') on stdout so the
Node management layer can persist heartbeats without parsing the staging
JSONL consumed by the importer.
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from typing import Any, Callable


class ProgressReporter:
    """Throttled progress publisher writing NDJSON records to stdout."""

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
        self._started = time.monotonic()
        self._last_emitted = 0.0
        self.stage = "starting"
        self.current_step: str | None = None
        self.completed_units = 0
        self.total_units: int | None = None

    def set_stage(self, stage: str) -> None:
        """Switch phases, resetting phase-local counters and forcing a publish."""
        if stage != self.stage:
            self.stage = stage
            self.current_step = None
            self.completed_units = 0
            self.total_units = None
            self.publish(force=True)

    def advance(self, completed: int | None = None, total: int | None = None, step: str | None = None) -> None:
        if completed is not None:
            self.completed_units = completed
        if total is not None:
            self.total_units = total
        if step is not None:
            self.current_step = step
        self.publish()

    def publish(self, force: bool = False) -> None:
        now = time.monotonic()
        if not force and now - self._last_emitted < self.interval_seconds:
            return
        self._last_emitted = now
        elapsed = now - self._started
        percent = 0.0
        eta: float | None = None
        if self.total_units and self.total_units > 0:
            percent = min(100.0, max(0.0, self.completed_units / self.total_units * 100.0))
            if self.completed_units > 0 and self.completed_units < self.total_units:
                rate = elapsed / self.completed_units
                eta = rate * (self.total_units - self.completed_units)
        record = {
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
        self.emit(json.dumps(record, separators=(",", ":")))

    def finish(self, stage: str = "completed") -> None:
        self.stage = stage
        self.publish(force=True)
