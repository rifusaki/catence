from fastapi.testclient import TestClient

from catence_console import app


def test_dashboard_proxy_route_is_reachable_before_the_console_spa_and_requires_login():
    response = TestClient(app.chainlit_server).get("/api/v1/dashboard?athleteId=alex")

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthorized"
