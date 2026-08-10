"""Local SQLite persistence for Catence Console chat threads."""

from __future__ import annotations

import sqlite3
from pathlib import Path


def _database_path(data_directory: Path) -> Path:
    return data_directory / "console" / "chat-history.sqlite3"


def _initialize_schema(database_path: Path) -> None:
    """Create the subset of Chainlit's SQLAlchemy schema needed by local chats."""

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


def local_data_layer(data_directory: Path):
    """Return Chainlit's SQLAlchemy layer backed by the Console's local SQLite file."""

    from chainlit.data.sql_alchemy import SQLAlchemyDataLayer

    database_path = _database_path(data_directory)
    _initialize_schema(database_path)
    return SQLAlchemyDataLayer(f"sqlite+aiosqlite:///{database_path}")
