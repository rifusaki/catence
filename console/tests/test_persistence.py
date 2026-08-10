import asyncio
import sqlite3

from chainlit.types import Pagination, ThreadFilter
from chainlit.user import User

from catence_console.persistence import local_data_layer


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
