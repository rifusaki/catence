from __future__ import annotations

import argparse
import asyncio
import os
import signal
from datetime import date
from pathlib import Path

from python.catence.providers.garmin.progress import ProgressReporter
from python.catence.providers.trainingpeaks.staging import StagingWriter
from python.catence.providers.trainingpeaks.worker import TrainingPeaksStagingWorker, WorkerInterrupted


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Stage strictly read-only TrainingPeaks data for Catence.")
    parser.add_argument("--from", dest="from_date", required=True, type=date.fromisoformat)
    parser.add_argument("--to", dest="to_date", type=date.fromisoformat, help="Override the default today+14d planned-workout window end.")
    parser.add_argument("--data-dir", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--run-id", required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    cookie = os.environ.get("TP_AUTH_COOKIE")
    if not cookie:
        raise SystemExit("TP_AUTH_COOKIE is required.")

    from tp_mcp.client import TPClient

    writer = StagingWriter(args.data_dir, args.output)
    writer.manifest(args.run_id, args.from_date.isoformat())
    reporter = ProgressReporter(args.run_id, provider="trainingpeaks")
    client = TPClient()
    worker = TrainingPeaksStagingWorker(client, writer, progress=reporter, today=date.today())
    interrupt_signal: int | None = None

    def _request_interrupt(signum: int, _frame: object) -> None:
        nonlocal interrupt_signal
        interrupt_signal = signum
        worker.request_interrupt()

    signal.signal(signal.SIGINT, _request_interrupt)
    signal.signal(signal.SIGTERM, _request_interrupt)
    try:
        async def run() -> None:
            async with client:
                await worker.sync(args.from_date, args.to_date)

        asyncio.run(run())
    except WorkerInterrupted:
        reporter.finish("interrupted")
        raise SystemExit(130 if interrupt_signal == signal.SIGINT else 143)
    reporter.finish("completed")


if __name__ == "__main__":
    main()
