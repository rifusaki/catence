from __future__ import annotations

import hashlib
import json
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import pyarrow as pa
import pyarrow.parquet as pq


SAMPLE_COLUMNS = [
    "activity_source_id", "timestamp_utc", "elapsed_s", "distance_m", "latitude", "longitude",
    "altitude_m", "heart_rate_bpm", "power_w", "cadence_rpm", "speed_mps", "temperature_c", "grade_pct",
    "left_right_balance_pct", "left_torque_effectiveness_pct", "right_torque_effectiveness_pct",
    "left_pedal_smoothness_pct", "right_pedal_smoothness_pct",
    "left_power_phase_start_deg", "left_power_phase_end_deg", "right_power_phase_start_deg", "right_power_phase_end_deg",
    "left_power_phase_peak_start_deg", "left_power_phase_peak_end_deg", "right_power_phase_peak_start_deg", "right_power_phase_peak_end_deg",
    "left_platform_center_offset_mm", "right_platform_center_offset_mm", "extras_json",
]

POWER_BEST_DURATIONS = (1, 5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600, 5400, 7200)

FIELD_MAP = {
    "directTimestamp": "timestamp_utc", "timestamp": "timestamp_utc", "sumElapsedDuration": "elapsed_s", "elapsedDuration": "elapsed_s",
    "sumDistance": "distance_m", "distance": "distance_m", "latitude": "latitude", "directLatitude": "latitude", "longitude": "longitude", "directLongitude": "longitude",
    "altitude": "altitude_m", "directAltitude": "altitude_m", "directUncorrectedElevation": "altitude_m", "directElevation": "altitude_m",
    "directHeartRate": "heart_rate_bpm", "heartRate": "heart_rate_bpm",
    "directPower": "power_w", "power": "power_w", "directCadence": "cadence_rpm", "directBikeCadence": "cadence_rpm", "cadence": "cadence_rpm",
    "directSpeed": "speed_mps", "speed": "speed_mps", "directTemperature": "temperature_c", "directAirTemperature": "temperature_c", "temperature": "temperature_c",
    "grade": "grade_pct",
    "leftRightBalance": "left_right_balance_pct", "left_right_balance": "left_right_balance_pct",
    "leftTorqueEffectiveness": "left_torque_effectiveness_pct", "left_torque_effectiveness": "left_torque_effectiveness_pct",
    "rightTorqueEffectiveness": "right_torque_effectiveness_pct", "right_torque_effectiveness": "right_torque_effectiveness_pct",
    "leftPedalSmoothness": "left_pedal_smoothness_pct", "left_pedal_smoothness": "left_pedal_smoothness_pct",
    "rightPedalSmoothness": "right_pedal_smoothness_pct", "right_pedal_smoothness": "right_pedal_smoothness_pct",
    "leftPlatformCenterOffset": "left_platform_center_offset_mm", "left_pco": "left_platform_center_offset_mm",
    "rightPlatformCenterOffset": "right_platform_center_offset_mm", "right_pco": "right_platform_center_offset_mm",
}

PAIR_FIELD_MAP = {
    "leftPowerPhase": ("left_power_phase_start_deg", "left_power_phase_end_deg"),
    "left_power_phase": ("left_power_phase_start_deg", "left_power_phase_end_deg"),
    "rightPowerPhase": ("right_power_phase_start_deg", "right_power_phase_end_deg"),
    "right_power_phase": ("right_power_phase_start_deg", "right_power_phase_end_deg"),
    "leftPowerPhasePeak": ("left_power_phase_peak_start_deg", "left_power_phase_peak_end_deg"),
    "left_power_phase_peak": ("left_power_phase_peak_start_deg", "left_power_phase_peak_end_deg"),
    "rightPowerPhasePeak": ("right_power_phase_peak_start_deg", "right_power_phase_peak_end_deg"),
    "right_power_phase_peak": ("right_power_phase_peak_start_deg", "right_power_phase_peak_end_deg"),
}


def _number(value: Any) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _timestamp(value: Any) -> str | None:
    if not isinstance(value, (int, float)):
        return None
    seconds = float(value)
    if seconds > 10_000_000_000:
        seconds /= 1000
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat().replace("+00:00", "Z")


def activity_power_bests(samples: Iterable[dict[str, Any]]) -> dict[int, float]:
    """Return rolling power bests without bridging invalid or long sample gaps."""
    points: list[tuple[float, float]] = []
    for sample in samples:
        raw_time, raw_power = sample.get("timestamp_utc"), _number(sample.get("power_w"))
        if not isinstance(raw_time, str) or raw_power is None:
            continue
        try:
            points.append((datetime.fromisoformat(raw_time.replace("Z", "+00:00")).timestamp(), raw_power))
        except ValueError:
            continue
    points.sort()
    bests: dict[int, float] = {}
    segment: list[tuple[float, float]] = []

    def evaluate(rows: list[tuple[float, float]]) -> None:
        for duration in POWER_BEST_DURATIONS:
            start = 0
            total = 0.0
            for end, (current_time, current_power) in enumerate(rows):
                total += current_power
                while start < end and current_time - rows[start + 1][0] >= duration:
                    total -= rows[start][1]
                    start += 1
                if current_time - rows[start][0] >= duration and end >= start:
                    mean = total / (end - start + 1)
                    bests[duration] = max(bests.get(duration, float("-inf")), mean)

    for point in points:
        if segment and point[0] - segment[-1][0] > 5:
            evaluate(segment)
            segment = []
        segment.append(point)
    evaluate(segment)
    return bests


def _sample_value(sample: dict[str, Any], extras: dict[str, Any], source_name: str, value: Any) -> None:
    """Map known cycling-dynamics fields without discarding unfamiliar sensors."""
    target = FIELD_MAP.get(source_name)
    if target:
        sample[target] = _number(value)
        extras[source_name] = value
        return
    targets = PAIR_FIELD_MAP.get(source_name)
    if targets and isinstance(value, (list, tuple)) and len(value) >= 2:
        sample[targets[0]], sample[targets[1]] = _number(value[0]), _number(value[1])
        extras[source_name] = value
        return
    extras[source_name] = value


def activity_details_to_samples(activity_source_id: str, details: dict[str, Any]) -> list[dict[str, Any]]:
    """Convert Garmin positional detail metrics into a stable, nullable sample schema."""
    descriptors = details.get("metricDescriptors") or []
    descriptor_names = {
        descriptor.get("metricsIndex"): descriptor.get("key")
        for descriptor in descriptors if isinstance(descriptor, dict) and isinstance(descriptor.get("metricsIndex"), int)
    }
    rows = details.get("activityDetailMetrics") or details.get("metrics") or []
    samples: list[dict[str, Any]] = []
    for row in rows:
        values = row.get("metrics") if isinstance(row, dict) else row
        if not isinstance(values, list):
            continue
        sample: dict[str, Any] = {column: None for column in SAMPLE_COLUMNS}
        sample["activity_source_id"] = activity_source_id
        extras: dict[str, Any] = {}
        for index, value in enumerate(values):
            source_name = descriptor_names.get(index, str(index))
            target = FIELD_MAP.get(source_name)
            if target == "timestamp_utc":
                sample[target] = _timestamp(value)
            else:
                _sample_value(sample, extras, source_name, value)
        sample["extras_json"] = json.dumps(extras, separators=(",", ":"), default=str)
        samples.append(sample)
    return samples


def fit_archive_to_samples(activity_source_id: str, archive: Path) -> list[dict[str, Any]]:
    """Best-effort FIT parsing; malformed/unavailable archives simply yield no samples."""
    try:
        import fitdecode
        with zipfile.ZipFile(archive) as zip_file:
            fit_name = next((name for name in zip_file.namelist() if name.lower().endswith(".fit")), None)
            if not fit_name:
                return []
            with zip_file.open(fit_name) as stream, fitdecode.FitReader(stream) as reader:
                rows: list[dict[str, Any]] = []
                for frame in reader:
                    if not isinstance(frame, fitdecode.records.FitDataMessage) or frame.name != "record":
                        continue
                    fields = {field.name: field.value for field in frame.fields}
                    sample = {column: None for column in SAMPLE_COLUMNS}
                    sample["activity_source_id"] = activity_source_id
                    sample["timestamp_utc"] = fields.get("timestamp").isoformat().replace("+00:00", "Z") if fields.get("timestamp") else None
                    sample["distance_m"] = _number(fields.get("distance"))
                    sample["altitude_m"] = _number(fields.get("enhanced_altitude") or fields.get("altitude"))
                    sample["heart_rate_bpm"] = _number(fields.get("heart_rate"))
                    sample["power_w"] = _number(fields.get("power"))
                    sample["cadence_rpm"] = _number(fields.get("cadence"))
                    sample["speed_mps"] = _number(fields.get("enhanced_speed") or fields.get("speed"))
                    sample["temperature_c"] = _number(fields.get("temperature"))
                    extras: dict[str, Any] = {}
                    for name, value in fields.items():
                        if name in {"timestamp", "distance", "enhanced_altitude", "altitude", "heart_rate", "power", "cadence", "enhanced_speed", "speed", "temperature"}:
                            continue
                        _sample_value(sample, extras, name, value)
                    for name, value in extras.items():
                        fields[name] = value
                    sample["extras_json"] = json.dumps(fields, separators=(",", ":"), default=str)
                    rows.append(sample)
                return rows
    except (ImportError, OSError, ValueError, zipfile.BadZipFile):
        return []


def write_parquet(data_dir: Path, activity_id: str, start_date: str, samples: Iterable[dict[str, Any]]) -> tuple[Path, str, int]:
    records = list(samples)
    year, month = (start_date[:4] or "unknown"), (start_date[5:7] or "unknown")
    destination = data_dir / "lake" / "activity_samples" / "provider=garmin" / f"year={year}" / f"month={month}" / f"activity={activity_id}.parquet"
    destination.parent.mkdir(parents=True, exist_ok=True)
    table = pa.Table.from_pylist(records, schema=pa.schema([(column, pa.string() if column in {"activity_source_id", "timestamp_utc", "extras_json"} else pa.float64()) for column in SAMPLE_COLUMNS]))
    temporary = destination.with_suffix(".tmp")
    pq.write_table(table, temporary, compression="zstd")
    temporary.replace(destination)
    return destination, hashlib.sha256(destination.read_bytes()).hexdigest(), len(records)
