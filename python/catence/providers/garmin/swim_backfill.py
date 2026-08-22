from __future__ import annotations

import argparse
import json
from pathlib import Path

from .staging import StagingWriter
from .streams import fit_archive_to_swim_lengths

SWIM_SPORTS = ("lap_swimming", "swimming", "open_water_swimming", "openwaterswimming")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Backfill swim lengths from already-archived Garmin activity FIT files.")
    parser.add_argument("--data-dir", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument(
        "--activities",
        type=Path,
        help=(
            "JSON list of {remote_activity_id, started_on} rows produced by the TypeScript side. "
            "Preferred over reading DuckDB because the parent process may hold the write lock."
        ),
    )
    return parser.parse_args()


def load_swim_activities(activities_file: Path | None, database_path: Path) -> list[tuple[str, str | None]]:
    if activities_file is not None:
        payload = json.loads(activities_file.read_text())
        return [(str(row["remote_activity_id"]), row.get("started_on")) for row in payload]
    import duckdb

    con = duckdb.connect(str(database_path), read_only=True)
    rows = con.execute(
        """
        SELECT source.remote_activity_id, cast(activity.started_at_utc AS VARCHAR) AS started_at_utc
        FROM activity_sources AS source
        JOIN activities AS activity USING (activity_id)
        WHERE source.provider = 'garmin'
          AND lower(coalesce(activity.sport, '')) IN ({placeholders})
        ORDER BY activity.started_at_utc
        """.format(placeholders=", ".join(f"'{sport}'" for sport in SWIM_SPORTS)),
    ).fetchall()
    con.close()
    return [(str(remote_id), started_at_utc) for remote_id, started_at_utc in rows]


def main() -> None:
    args = parse_args()
    database_path = args.data_dir / "catence.duckdb"
    if args.activities is None and not database_path.exists():
        raise SystemExit(f"Catalog database not found: {database_path}")
    rows = load_swim_activities(args.activities, database_path)

    writer = StagingWriter(args.data_dir, args.output)
    staged = 0
    for remote_id, started_at_utc in rows:
        activity_id = str(remote_id)
        zip_dir = args.data_dir / "raw" / "garmin" / "activity_original" / activity_id
        if not zip_dir.is_dir():
            continue
        zips = sorted(zip_dir.glob("*.zip"))
        if not zips:
            continue
        archive = zips[-1]
        lengths = fit_archive_to_swim_lengths(f"garmin:{activity_id}", archive)
        if not lengths:
            continue
        writer.source_entity(
            "activity_swim_lengths",
            f"{activity_id}:fit",
            {"lengths": lengths},
            archive.stem,
            parent_remote_id=activity_id,
            occurred_on=str(started_at_utc)[:10] if started_at_utc else None,
        )
        staged += 1
    print(f"Staged swim lengths for {staged} activities; output: {args.output}")


if __name__ == "__main__":
    main()
