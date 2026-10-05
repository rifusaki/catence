import json
from datetime import datetime, timedelta, timezone

from catence_console.generation_sidecar import clear_orphaned_generation_sidecars


def test_clear_orphaned_sidecars_removes_terminal_temp_and_stale_files(tmp_path, monkeypatch):
    monkeypatch.setenv("CATENCE_HOME", str(tmp_path))
    directory = tmp_path / "generation"
    directory.mkdir()
    now = datetime.now(timezone.utc)
    fresh = (now - timedelta(seconds=10)).isoformat()
    stale = (now - timedelta(minutes=30)).isoformat()
    # A killed process leaves stage "running" but its heartbeat ages out.
    (directory / "stale.generation.json").write_text(json.dumps({"stage": "running", "heartbeatAt": stale}))
    # A second live Console sharing the home must survive the cleanup.
    (directory / "fresh.generation.json").write_text(json.dumps({"stage": "running", "heartbeatAt": fresh}))
    (directory / "done.generation.json").write_text(json.dumps({"stage": "completed", "heartbeatAt": stale}))
    (directory / "partial.generation.json.tmp").write_text("{}")

    removed = clear_orphaned_generation_sidecars()

    assert removed == 3
    assert not (directory / "stale.generation.json").exists()
    assert (directory / "fresh.generation.json").exists()
    assert not (directory / "done.generation.json").exists()
    assert not (directory / "partial.generation.json.tmp").exists()


def test_clear_orphaned_sidecars_ignores_a_home_without_generation_directory(tmp_path, monkeypatch):
    monkeypatch.setenv("CATENCE_HOME", str(tmp_path))

    assert clear_orphaned_generation_sidecars() == 0
