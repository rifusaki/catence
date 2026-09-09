from fastapi.testclient import TestClient

from catence_console import app


def test_dashboard_proxy_route_is_reachable_before_the_console_spa_and_requires_login():
    response = TestClient(app.chainlit_server).get("/api/v1/dashboard?athleteId=alex")

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthorized"


def test_health_proxy_route_is_reachable_before_the_console_spa_and_requires_login():
    # Regression: without this proxy, /api/v1/health fell through to the
    # SPA catch-all (200 HTML) and the Status page fell back to Chainlit's
    # /health {"status":"ok"}, rendering empty Runtime / bare "v".
    response = TestClient(app.chainlit_server).get("/api/v1/health")

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthorized"
