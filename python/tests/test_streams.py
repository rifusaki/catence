from python.catence.providers.garmin.streams import activity_details_to_samples, activity_power_bests


def test_activity_details_maps_positional_metrics_and_retains_extras() -> None:
    details = {
        "metricDescriptors": [
            {"metricsIndex": 0, "key": "directTimestamp"},
            {"metricsIndex": 1, "key": "directPower"},
            {"metricsIndex": 2, "key": "directHeartRate"},
            {"metricsIndex": 3, "key": "directLatitude"},
            {"metricsIndex": 4, "key": "directLongitude"},
            {"metricsIndex": 5, "key": "directUncorrectedElevation"},
            {"metricsIndex": 6, "key": "directElevation"},
            {"metricsIndex": 7, "key": "verticalRatio"},
        ],
        "activityDetailMetrics": [[1_753_872_000_000, 245, 152, 4.7, -74.1, 2_650.5, 2_645.25, 7.8]],
    }
    samples = activity_details_to_samples("garmin:42", details)
    assert samples[0]["activity_source_id"] == "garmin:42"
    assert samples[0]["power_w"] == 245
    assert samples[0]["heart_rate_bpm"] == 152
    assert samples[0]["latitude"] == 4.7
    assert samples[0]["longitude"] == -74.1
    # Garmin sends uncorrected elevation first, then the corrected value.
    assert samples[0]["altitude_m"] == 2_645.25
    assert '"verticalRatio":7.8' in samples[0]["extras_json"]


def test_activity_samples_promote_cycling_dynamics_and_power_bests_respect_gaps() -> None:
    details = {
        "metricDescriptors": [
            {"metricsIndex": 0, "key": "directTimestamp"},
            {"metricsIndex": 1, "key": "leftPowerPhase"},
            {"metricsIndex": 2, "key": "rightPlatformCenterOffset"},
        ],
        "activityDetailMetrics": [[1_753_872_000_000, [20, 120], 4.5]],
    }
    samples = activity_details_to_samples("garmin:42", details)
    assert samples[0]["left_power_phase_start_deg"] == 20
    assert samples[0]["left_power_phase_end_deg"] == 120
    assert samples[0]["right_platform_center_offset_mm"] == 4.5

    bests = activity_power_bests([
        {"timestamp_utc": "2025-01-01T00:00:00Z", "power_w": 200},
        {"timestamp_utc": "2025-01-01T00:00:01Z", "power_w": 220},
        {"timestamp_utc": "2025-01-01T00:00:10Z", "power_w": 500},
    ])
    assert bests[1] == 210
    assert 5 not in bests
