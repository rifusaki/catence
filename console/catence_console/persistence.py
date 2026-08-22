"""Local SQLite persistence for Catence Console chat threads and tool context."""

from __future__ import annotations

import json
import logging
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


# Chainlit persists every key returned by ``Step.to_dict``. Keep this list
# separate from the initial CREATE TABLE statement so an existing local
# database can be upgraded without discarding a user's saved conversations.
_STEP_COLUMN_MIGRATIONS = {
    "defaultOpen": "BOOLEAN NOT NULL DEFAULT 0",
    "autoCollapse": "BOOLEAN NOT NULL DEFAULT 0",
}

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class SavedToolCall:
    """One durable tool invocation that can be shown to a later model turn."""

    call_id: str
    name: str
    arguments: dict[str, Any]
    result: dict[str, Any] | None
    is_error: bool
    created_at: str


@dataclass(frozen=True)
class SavedConsolePreferences:
    """The local Console user's durable non-secret model preferences."""

    model_choice: str
    reasoning_effort: str
    tool_rounds: int
    tool_result_characters: int
    athlete_id: str | None = None


def _database_path(data_directory: Path) -> Path:
    return data_directory / "console" / "chat-history.sqlite3"


class ToolCallStore:
    """A compact, queryable tool-call ledger alongside Chainlit's step history.

    Chainlit stores visual tool steps, but its resumed ``chat_context`` contains
    only user and assistant messages. This ledger makes the prior calls
    available to the next model turn without eagerly adding every old result to
    the provider prompt.
    """

    def __init__(self, data_directory: Path):
        self.database_path = _database_path(data_directory)

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path, timeout=5)
        connection.execute("PRAGMA busy_timeout = 5000")
        return connection

    def record(
        self,
        *,
        thread_id: str,
        call_id: str,
        name: str,
        arguments: dict[str, Any],
        result: dict[str, Any],
    ) -> None:
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        created_at = datetime.now(UTC).isoformat()
        try:
            with self._connect() as connection:
                connection.execute(
                    """
                    INSERT INTO tool_calls (
                        thread_id, call_id, name, arguments, result, is_error, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(thread_id, call_id) DO UPDATE SET
                        name = excluded.name,
                        arguments = excluded.arguments,
                        result = excluded.result,
                        is_error = excluded.is_error
                    """,
                    (
                        thread_id,
                        call_id,
                        name,
                        json.dumps(arguments, ensure_ascii=False, sort_keys=True, default=str),
                        json.dumps(result, ensure_ascii=False, default=str),
                        bool(result.get("isError")),
                        created_at,
                    ),
                )
        except sqlite3.Error:
            logger.exception("Could not persist Console tool call %s for thread %s", name, thread_id)

    def list(self, thread_id: str, *, limit: int = 24) -> list[SavedToolCall]:
        """Return the newest saved calls in chronological order."""

        if limit < 1:
            return []
        try:
            with self._connect() as connection:
                rows = connection.execute(
                    """
                    SELECT call_id, name, arguments, result, is_error, created_at
                    FROM tool_calls
                    WHERE thread_id = ?
                    ORDER BY created_at DESC, rowid DESC
                    LIMIT ?
                    """,
                    (thread_id, limit),
                ).fetchall()
        except sqlite3.Error:
            logger.exception("Could not load Console tool calls for thread %s", thread_id)
            return []
        return [
            SavedToolCall(
                call_id=row[0],
                name=row[1],
                arguments=_json_object(row[2]),
                result=_json_object_or_none(row[3]),
                is_error=bool(row[4]),
                created_at=row[5],
            )
            for row in reversed(rows)
        ]

    def result(self, thread_id: str, call_id: str) -> dict[str, Any] | None:
        try:
            with self._connect() as connection:
                row = connection.execute(
                    """
                    SELECT result FROM tool_calls
                    WHERE thread_id = ? AND call_id = ?
                    """,
                    (thread_id, call_id),
                ).fetchone()
        except sqlite3.Error:
            logger.exception("Could not load saved result %s for thread %s", call_id, thread_id)
            return None
        return _json_object_or_none(row[0]) if row else None

    def delete_thread(self, thread_id: str) -> None:
        try:
            with self._connect() as connection:
                connection.execute("DELETE FROM tool_calls WHERE thread_id = ?", (thread_id,))
        except sqlite3.Error:
            logger.exception("Could not delete saved tool calls for thread %s", thread_id)


class ConsolePreferencesStore:
    """Store one local, user-scoped Console preference set in chat history."""

    def __init__(self, data_directory: Path):
        self.database_path = _database_path(data_directory)

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path, timeout=5)
        connection.execute("PRAGMA busy_timeout = 5000")
        return connection

    def load(self, user_identifier: str) -> SavedConsolePreferences | None:
        try:
            with self._connect() as connection:
                row = connection.execute(
                    """
                    SELECT model_choice, reasoning_effort, tool_rounds, tool_result_characters, athlete_id
                    FROM console_preferences WHERE user_identifier = ?
                    """,
                    (user_identifier,),
                ).fetchone()
        except sqlite3.Error:
            logger.exception("Could not load Console preferences for %s", user_identifier)
            return None
        if not row:
            return None
        return SavedConsolePreferences(
            model_choice=row[0],
            reasoning_effort=row[1],
            tool_rounds=row[2],
            tool_result_characters=row[3],
            athlete_id=row[4],
        )

    def save(self, user_identifier: str, preferences: SavedConsolePreferences) -> None:
        try:
            with self._connect() as connection:
                connection.execute(
                    """
                    INSERT INTO console_preferences (
                        user_identifier, model_choice, reasoning_effort, tool_rounds,
                        tool_result_characters, athlete_id, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(user_identifier) DO UPDATE SET
                        model_choice = excluded.model_choice,
                        reasoning_effort = excluded.reasoning_effort,
                        tool_rounds = excluded.tool_rounds,
                        tool_result_characters = excluded.tool_result_characters,
                        athlete_id = excluded.athlete_id,
                        updated_at = excluded.updated_at
                    """,
                    (
                        user_identifier,
                        preferences.model_choice,
                        preferences.reasoning_effort,
                        preferences.tool_rounds,
                        preferences.tool_result_characters,
                        preferences.athlete_id,
                        datetime.now(UTC).isoformat(),
                    ),
                )
        except sqlite3.Error:
            logger.exception("Could not save Console preferences for %s", user_identifier)

    def delete(self, user_identifier: str) -> None:
        try:
            with self._connect() as connection:
                connection.execute(
                    "DELETE FROM console_preferences WHERE user_identifier = ?",
                    (user_identifier,),
                )
        except sqlite3.Error:
            logger.exception("Could not reset Console preferences for %s", user_identifier)


class DisabledModelsStore:
    """Store which configured profile models the local user disabled.

    Disabled models live here instead of ``config.json`` because both the
    runtime and Console validate that file strictly; per-user UI state belongs
    in this database, not in shared configuration.
    """

    def __init__(self, data_directory: Path):
        self.database_path = _database_path(data_directory)

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path, timeout=5)
        connection.execute("PRAGMA busy_timeout = 5000")
        return connection

    def list(self) -> set[tuple[str, str]]:
        try:
            with self._connect() as connection:
                rows = connection.execute("SELECT profile_id, model_id FROM disabled_models").fetchall()
        except sqlite3.Error:
            logger.exception("Could not load disabled Console models")
            return set()
        return {(row[0], row[1]) for row in rows}

    def add(self, profile_id: str, model_id: str) -> None:
        try:
            with self._connect() as connection:
                connection.execute(
                    """
                    INSERT INTO disabled_models (profile_id, model_id, updated_at)
                    VALUES (?, ?, ?)
                    ON CONFLICT(profile_id, model_id) DO NOTHING
                    """,
                    (profile_id, model_id, datetime.now(UTC).isoformat()),
                )
        except sqlite3.Error:
            logger.exception("Could not disable Console model %s:%s", profile_id, model_id)

    def remove(self, profile_id: str, model_id: str) -> None:
        try:
            with self._connect() as connection:
                connection.execute(
                    "DELETE FROM disabled_models WHERE profile_id = ? AND model_id = ?",
                    (profile_id, model_id),
                )
        except sqlite3.Error:
            logger.exception("Could not enable Console model %s:%s", profile_id, model_id)


def _json_object(value: str | None) -> dict[str, Any]:
    parsed = _json_object_or_none(value)
    return parsed if parsed is not None else {}


def _json_object_or_none(value: str | None) -> dict[str, Any] | None:
    if value is None:
        return None
    try:
        parsed = json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _initialize_schema(database_path: Path) -> None:
    """Create and safely upgrade the Chainlit schema used by local chats."""

    database_path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(database_path) as connection:
        connection.executescript(
            """
            PRAGMA foreign_keys = ON;
            CREATE TABLE IF NOT EXISTS users (
                "id" TEXT PRIMARY KEY,
                "identifier" TEXT NOT NULL UNIQUE,
                "metadata" TEXT NOT NULL,
                "createdAt" TEXT
            );
            CREATE TABLE IF NOT EXISTS threads (
                "id" TEXT PRIMARY KEY,
                "createdAt" TEXT,
                "name" TEXT,
                "userId" TEXT,
                "userIdentifier" TEXT,
                "tags" TEXT,
                "metadata" TEXT NOT NULL DEFAULT '{}'
            );
            CREATE TABLE IF NOT EXISTS steps (
                "id" TEXT PRIMARY KEY,
                "name" TEXT NOT NULL,
                "type" TEXT NOT NULL,
                "threadId" TEXT NOT NULL,
                "parentId" TEXT,
                "disableFeedback" BOOLEAN,
                "streaming" BOOLEAN NOT NULL DEFAULT 0,
                "waitForAnswer" BOOLEAN,
                "isError" BOOLEAN,
                "metadata" TEXT,
                "tags" TEXT,
                "input" TEXT,
                "output" TEXT,
                "createdAt" TEXT,
                "start" TEXT,
                "end" TEXT,
                "generation" TEXT,
                "showInput" TEXT,
                "defaultOpen" BOOLEAN NOT NULL DEFAULT 0,
                "autoCollapse" BOOLEAN NOT NULL DEFAULT 0,
                "language" TEXT,
                "indent" INTEGER
            );
            CREATE TABLE IF NOT EXISTS elements (
                "id" TEXT PRIMARY KEY,
                "threadId" TEXT,
                "type" TEXT,
                "url" TEXT,
                "chainlitKey" TEXT,
                "name" TEXT NOT NULL,
                "display" TEXT,
                "objectKey" TEXT,
                "size" TEXT,
                "page" INTEGER,
                "language" TEXT,
                "forId" TEXT,
                "mime" TEXT,
                "autoPlay" BOOLEAN,
                "playerConfig" TEXT,
                "props" TEXT
            );
            CREATE TABLE IF NOT EXISTS feedbacks (
                "id" TEXT PRIMARY KEY,
                "forId" TEXT NOT NULL,
                "threadId" TEXT NOT NULL,
                "value" INTEGER NOT NULL,
                "comment" TEXT
            );
            CREATE TABLE IF NOT EXISTS tool_calls (
                "thread_id" TEXT NOT NULL,
                "call_id" TEXT NOT NULL,
                "name" TEXT NOT NULL,
                "arguments" TEXT NOT NULL,
                "result" TEXT,
                "is_error" BOOLEAN NOT NULL DEFAULT 0,
                "created_at" TEXT NOT NULL,
                PRIMARY KEY ("thread_id", "call_id")
            );
            CREATE INDEX IF NOT EXISTS tool_calls_thread_created_idx
              ON tool_calls (thread_id, created_at DESC);
            CREATE TABLE IF NOT EXISTS console_preferences (
                "user_identifier" TEXT PRIMARY KEY,
                "model_choice" TEXT NOT NULL,
                "reasoning_effort" TEXT NOT NULL,
                "tool_rounds" INTEGER NOT NULL,
                "tool_result_characters" INTEGER NOT NULL,
                "athlete_id" TEXT,
                "updated_at" TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS disabled_models (
                "profile_id" TEXT NOT NULL,
                "model_id" TEXT NOT NULL,
                "updated_at" TEXT NOT NULL,
                PRIMARY KEY ("profile_id", "model_id")
            );
            """
        )

        # ``CREATE TABLE IF NOT EXISTS`` intentionally leaves an existing
        # database unchanged. Earlier Console builds created ``steps`` before
        # Chainlit started persisting these display-state fields, which made
        # every subsequent step insert fail. Add columns in place instead of
        # asking the user to delete chat-history.sqlite3 and lose their chats.
        existing_step_columns = {
            row[1] for row in connection.execute('PRAGMA table_info("steps")')
        }
        for column, definition in _STEP_COLUMN_MIGRATIONS.items():
            if column not in existing_step_columns:
                connection.execute(
                    f'ALTER TABLE "steps" ADD COLUMN "{column}" {definition}'
                )

        existing_preference_columns = {
            row[1] for row in connection.execute('PRAGMA table_info("console_preferences")')
        }
        if "athlete_id" not in existing_preference_columns:
            connection.execute('ALTER TABLE "console_preferences" ADD COLUMN "athlete_id" TEXT')


def local_data_layer(data_directory: Path):
    """Return Chainlit's SQLAlchemy layer backed by the Console's local SQLite file."""

    from chainlit.data.sql_alchemy import SQLAlchemyDataLayer

    database_path = _database_path(data_directory)
    _initialize_schema(database_path)

    class CatenceConsoleDataLayer(SQLAlchemyDataLayer):
        async def delete_thread(self, thread_id: str):
            await super().delete_thread(thread_id)
            ToolCallStore(data_directory).delete_thread(thread_id)

    return CatenceConsoleDataLayer(f"sqlite+aiosqlite:///{database_path}")


def tool_call_store(data_directory: Path) -> ToolCallStore:
    """Return the durable tool-call ledger used by the agent loop."""

    _initialize_schema(_database_path(data_directory))
    return ToolCallStore(data_directory)


def console_preferences_store(data_directory: Path) -> ConsolePreferencesStore:
    """Return the local user-preferences store used by Console settings."""

    _initialize_schema(_database_path(data_directory))
    return ConsolePreferencesStore(data_directory)


def disabled_models_store(data_directory: Path) -> DisabledModelsStore:
    """Return the disabled-models store used by in-app model management."""

    _initialize_schema(_database_path(data_directory))
    return DisabledModelsStore(data_directory)
