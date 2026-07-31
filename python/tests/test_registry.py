from python.catence.providers.garmin.registry import GARMIN_READ_METHODS, assert_read_only_registry


def test_registry_is_read_only_and_covers_core_families() -> None:
    assert_read_only_registry()
    methods = {method for group in GARMIN_READ_METHODS.values() for method in group}
    assert "download_activity" in methods
    assert "get_nutrition_daily_food_log" in methods
    assert "get_activity_details" in methods
