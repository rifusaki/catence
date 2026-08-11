import asyncio
import sqlite3

from chainlit.types import Pagination, ThreadFilter
from chainlit.user import User

from catence_console.persistence import (
    SavedConsolePreferences,
    console_preferences_store,
    local_data_layer,
    tool_call_store,
)


def test_local_data_layer_persists_a_user_owned_thread(tmp_path):
    async def check() -> None:
        data_layer = local_data_layer(tmp_path)
        try:
            user = await data_layer.create_user(User(identifier="catence-local"))
            assert user is not None
            await data_layer.update_thread("thread-1", name="Recovery review", user_id=user.id)
            history = await data_layer.list_threads(
                Pagination(first=10), ThreadFilter(userId=user.id)
            )
            assert [thread["id"] for thread in history.data] == ["thread-1"]
            assert history.data[0]["name"] == "Recovery review"
        finally:
            await data_layer.close()

    asyncio.run(check())


def test_local_data_layer_upgrades_existing_steps_table(tmp_path):
    database_path = tmp_path / "console" / "chat-history.sqlite3"
    database_path.parent.mkdir()
    with sqlite3.connect(database_path) as connection:
        connection.execute(
            '''
            CREATE TABLE steps (
                "id" TEXT PRIMARY KEY,
                "name" TEXT NOT NULL,
                "type" TEXT NOT NULL,
                "threadId" TEXT NOT NULL
            )
            '''
        )

    async def check() -> None:
        data_layer = local_data_layer(tmp_path)
        try:
            result = await data_layer.execute_sql(
                '''
                INSERT INTO steps (
                    "id", "name", "type", "threadId", "defaultOpen", "autoCollapse"
                ) VALUES (
                    :id, :name, :type, :thread_id, :default_open, :auto_collapse
                )
                ''',
                {
                    "id": "step-1",
                    "name": "Persisted step",
                    "type": "assistant_message",
                    "thread_id": "thread-1",
                    "default_open": False,
                    "auto_collapse": False,
                },
            )
            assert result == 1
        finally:
            await data_layer.close()

    asyncio.run(check())


def test_tool_call_store_keeps_thread_scoped_calls_and_deletes_them_with_the_thread(tmp_path):
    store = tool_call_store(tmp_path)
    store.record(
        thread_id="thread-1",
        call_id="call-1",
        name="get_activity_segments",
        arguments={"activityId": "strava:123"},
        result={"content": [{"type": "text", "text": "evidence"}]},
    )

    calls = store.list("thread-1")
    assert len(calls) == 1
    assert calls[0].name == "get_activity_segments"
    assert calls[0].arguments == {"activityId": "strava:123"}
    assert store.result("thread-1", "call-1") == {"content": [{"type": "text", "text": "evidence"}]}

    async def check() -> None:
        data_layer = local_data_layer(tmp_path)
        try:
            await data_layer.update_thread("thread-1")
            await data_layer.delete_thread("thread-1")
        finally:
            await data_layer.close()

    asyncio.run(check())
    assert store.list("thread-1") == []


def test_console_preferences_are_user_scoped_and_removable(tmp_path):
    store = console_preferences_store(tmp_path)
    preferences = SavedConsolePreferences(
        model_choice="azure:terra",
        reasoning_effort="high",
        tool_rounds=12,
        tool_result_characters=48_000,
    )

    store.save("athlete-a", preferences)

    assert store.load("athlete-a") == preferences
    assert store.load("athlete-b") is None
    store.delete("athlete-a")
    assert store.load("athlete-a") is None
