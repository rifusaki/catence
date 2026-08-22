"""Read-modify-write access to ``<CATENCE_HOME>/config.json`` for the Console UI.

The Console's in-app model management edits only the ``console`` section.
Every other top-level section (runtime rate limits, provider budgets, and
anything added by newer runtimes) is preserved untouched, the candidate file
is validated with the same strict parser used at startup before anything is
replaced, and the replacement itself is atomic. Secrets remain forbidden: the
parser accepts environment-variable *names* only.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable

from .config import ConsoleConfiguration, ConsoleConfigurationError, parse_console_configuration


def read_config_root(data_directory: Path) -> dict[str, Any]:
    """Return the decoded config.json root; an absent file reads as empty."""

    path = data_directory / "config.json"
    try:
        root = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except json.JSONDecodeError as error:
        raise ConsoleConfigurationError(f"Invalid JSON in {path}: {error.msg}") from error
    if not isinstance(root, dict):
        raise ConsoleConfigurationError("Catence config must be a JSON object.")
    return root


def write_console_section(
    data_directory: Path,
    mutate: Callable[[dict[str, Any]], None],
) -> ConsoleConfiguration:
    """Apply ``mutate`` to a deep copy of the console section and persist it.

    The mutation runs on the raw JSON mapping so unrelated console fields are
    preserved verbatim. The mutated document is parsed with
    :func:`parse_console_configuration` first; a validation error aborts the
    write and leaves the existing file on disk unchanged.
    """

    path = data_directory / "config.json"
    root = read_config_root(data_directory)
    console = root.get("console")
    console = console if isinstance(console, dict) else {}
    candidate_console = json.loads(json.dumps(console))
    mutate(candidate_console)
    candidate_root = {**root, "console": candidate_console}
    configuration = parse_console_configuration(candidate_root)

    data_directory.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_suffix(".json.tmp")
    temporary_path.write_text(json.dumps(candidate_root, indent=2) + "\n", encoding="utf-8")
    temporary_path.replace(path)
    return configuration
