import asyncio

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
