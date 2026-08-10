"""Local SQLite persistence for Catence Console chat threads."""

from __future__ import annotations

import sqlite3
from pathlib import Path


# Chainlit persists every key returned by ``Step.to_dict``. Keep this list
# separate from the initial CREATE TABLE statement so an existing local
# database can be upgraded without discarding a user's saved conversations.
_STEP_COLUMN_MIGRATIONS = {
    "defaultOpen": "BOOLEAN NOT NULL DEFAULT 0",
    "autoCollapse": "BOOLEAN NOT NULL DEFAULT 0",
}


def _database_path(data_directory: Path) -> Path:
    return data_directory / "console" / "chat-history.sqlite3"


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


def local_data_layer(data_directory: Path):
    """Return Chainlit's SQLAlchemy layer backed by the Console's local SQLite file."""

    from chainlit.data.sql_alchemy import SQLAlchemyDataLayer

    database_path = _database_path(data_directory)
    _initialize_schema(database_path)
    return SQLAlchemyDataLayer(f"sqlite+aiosqlite:///{database_path}")
