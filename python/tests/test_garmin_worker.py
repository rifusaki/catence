from __future__ import annotations

from python.catence.providers.garmin.worker import as_items, remote_id, route_items


def test_route_items_unwraps_saved_route_and_course_listings() -> None:
    assert route_items({"routeList": [{"routeId": 1}]}) == [{"routeId": 1}]
    assert route_items({"courseList": [{"courseId": 2}]}) == [{"courseId": 2}]
    assert route_items({"routes": [{"id": 3}]}) == [{"id": 3}]
    assert route_items([{"id": 4}]) == [{"id": 4}]
    assert as_items({"routeList": [{"routeId": 5}]}) == [{"routeId": 5}]


def test_route_items_rejects_an_unrecognized_wrapper_instead_of_staging_it() -> None:
    assert route_items({"unexpected": [{"id": 1}]}) is None
    assert route_items("not a route listing") is None


def test_remote_id_accepts_garmin_route_and_course_ids() -> None:
    assert remote_id({"routeId": 7}, "fallback") == "7"
    assert remote_id({"courseId": 8}, "fallback") == "8"
