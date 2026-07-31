from __future__ import annotations

import argparse
import getpass
import json
import os
from datetime import date
from pathlib import Path

from .staging import StagingWriter
from .worker import GarminStagingWorker


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Stage strictly read-only Garmin data for Catence.")
    parser.add_argument("--from", dest="from_date", required=True, type=date.fromisoformat)
    parser.add_argument("--daily-from", dest="daily_from_date", type=date.fromisoformat)
    parser.add_argument("--activity-from", dest="activity_from_date", type=date.fromisoformat)
    parser.add_argument("--data-dir", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--to", dest="to_date", type=date.fromisoformat)
    parser.add_argument("--known-activities", type=Path)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    from garminconnect import Garmin

    email = os.environ.get("GARMIN_EMAIL")
    if not email:
        raise SystemExit("GARMIN_EMAIL is required.")
    password = os.environ.get("GARMIN_PASSWORD") or getpass.getpass("Garmin password: ")
    writer = StagingWriter(args.data_dir, args.output)
    writer.manifest(args.run_id, args.from_date.isoformat())
    token_store = args.data_dir / "auth" / "garmin_tokens.json"
    token_store.parent.mkdir(parents=True, exist_ok=True)
    client = Garmin(email, password, prompt_mfa=lambda: input("Garmin MFA code: "))
    client.login(str(token_store))
    known_hashes: dict[str, str] = {}
    if args.known_activities and args.known_activities.exists():
        loaded = json.loads(args.known_activities.read_text(encoding="utf-8"))
        if isinstance(loaded, dict):
            known_hashes = {str(key): str(value) for key, value in loaded.items()}
    GarminStagingWorker(client, writer, args.data_dir, known_hashes).sync(
        args.daily_from_date or args.from_date,
        args.activity_from_date or args.from_date,
        args.to_date,
    )


if __name__ == "__main__":
    main()
