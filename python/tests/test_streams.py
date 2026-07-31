from python.catence.providers.garmin.streams import activity_details_to_samples


def test_activity_details_maps_positional_metrics_and_retains_extras() -> None:
    details = {
        "metricDescriptors": [
            {"metricsIndex": 0, "key": "directTimestamp"},
            {"metricsIndex": 1, "key": "directPower"},
            {"metricsIndex": 2, "key": "directHeartRate"},
            {"metricsIndex": 3, "key": "verticalRatio"},
        ],
        "activityDetailMetrics": [[1_753_872_000_000, 245, 152, 7.8]],
    }
    samples = activity_details_to_samples("garmin:42", details)
    assert samples[0]["activity_source_id"] == "garmin:42"
    assert samples[0]["power_w"] == 245
    assert samples[0]["heart_rate_bpm"] == 152
    assert '"verticalRatio":7.8' in samples[0]["extras_json"]
