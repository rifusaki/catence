"""Explicit allowlist for Garmin reads; mutation methods are deliberately absent."""

GARMIN_READ_METHODS = {
    "profile": ("get_user_profile", "get_userprofile_settings"),
    "devices": ("get_devices", "get_device_last_used", "get_device_alarms"),
    "health_daily": (
        "get_stats", "get_user_summary", "get_steps_data", "get_heart_rates",
        "get_sleep_data", "get_stress_data", "get_all_day_stress", "get_body_battery_events",
        "get_respiration_data", "get_spo2_data", "get_hrv_data", "get_training_readiness",
        "get_morning_training_readiness", "get_training_status", "get_fitnessage_data",
        "get_max_metrics", "get_hydration_data", "get_menstrual_data_for_date",
        "get_nutrition_daily_food_log", "get_nutrition_daily_meals", "get_nutrition_daily_settings",
    ),
    "health_range": (
        "get_daily_steps", "get_body_battery", "get_blood_pressure", "get_weigh_ins",
        "get_progress_summary_between_dates", "get_menstrual_calendar_data",
    ),
    "training_singletons": (
        "get_lactate_threshold", "get_heart_rate_zones", "get_power_zones", "get_cycling_ftp",
        "get_personal_record", "get_earned_badges", "get_available_badges", "get_in_progress_badges",
        "get_training_plans", "get_pregnancy_summary", "get_golf_user_stats", "get_golf_club_stats",
    ),
    "activities": (
        "get_activities_by_date", "get_activity", "get_activity_details", "get_activity_splits",
        "get_activity_typed_splits", "get_activity_split_summaries", "get_activity_weather",
        "get_activity_hr_in_timezones", "get_activity_power_in_timezones", "get_activity_exercise_sets",
        "get_activity_gear", "download_activity",
    ),
    "workouts": ("get_workouts", "get_scheduled_workouts"),
    "goals": ("get_goals",),
    "gear": ("get_gear",),
    "golf": ("get_golf_summary",),
}

MUTATION_PREFIXES = ("add_", "create_", "delete_", "import_", "set_", "update_", "upload_", "push_", "request_")


def assert_read_only_registry() -> None:
    """Fail closed if a future registry edit accidentally exposes a mutation."""
    for methods in GARMIN_READ_METHODS.values():
        for method in methods:
            if method.startswith(MUTATION_PREFIXES):
                raise RuntimeError(f"Unsafe Garmin method in read registry: {method}")
