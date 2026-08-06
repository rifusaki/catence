import type { EndpointSpec } from '../../../contracts/staging.js';

type RegistryEntry = readonly [name: string, scope: EndpointSpec['scope'], entityType: string];

function registry(provider: EndpointSpec['provider'], entries: readonly RegistryEntry[]): readonly EndpointSpec[] {
  return entries.map(([name, scope, entityType]) => ({ provider, name, scope, entityType, readOnly: true, pagination: scope === 'date_range' ? 'provider' : 'none' }));
}

/**
 * The only provider operations an extractor may execute. Entries intentionally
 * describe data families, not mutations: extraction code rejects every route
 * outside this registry.
 */
export const intervalsReadRegistry = registry('intervals', [
  ['athlete', 'singleton', 'athlete'], ['profile', 'singleton', 'profile'], ['connections', 'singleton', 'connection'],
  ['sport_settings', 'collection', 'sport_setting'], ['activities', 'date_range', 'activity'], ['wellness', 'date_range', 'wellness'],
  ['events', 'date_range', 'event'], ['workouts', 'collection', 'workout'], ['folders', 'collection', 'folder'], ['gear', 'collection', 'gear'],
  ['routes', 'collection', 'route'], ['custom_items', 'collection', 'custom_item'], ['fitness', 'date_range', 'fitness_summary'],
  ['activity_summary', 'date_range', 'fitness_summary'], ['power_curves', 'date_range', 'power_curve'], ['pace_curves', 'date_range', 'pace_curve'],
  ['hr_curves', 'date_range', 'hr_curve'], ['activity_power_curves', 'date_range', 'activity_power_curve'],
  ['activity_hr_curves', 'date_range', 'activity_hr_curve'], ['weather_config', 'singleton', 'weather_config'], ['weather_forecast', 'singleton', 'weather_forecast'],
  ['chats', 'collection', 'chat'], ['activity_tags', 'collection', 'activity_tag'], ['event_tags', 'collection', 'event_tag'], ['workout_tags', 'collection', 'workout_tag'],
] as const);

/**
 * Intervals is an analysis companion to Garmin: its activity-list payload
 * supplies the separately named training calculations without duplicating
 * Garmin's activity detail, files, streams, or account data.
 */
export const intervalsSecondaryReadRegistry = intervalsReadRegistry.filter((endpoint) => endpoint.name === 'athlete' || endpoint.name === 'activities');

export const intervalsActivityReadEndpoints = [
  'activity', 'streams', 'intervals', 'map', 'weather', 'weather_summary', 'best_efforts', 'power_curve', 'pace_curve', 'hr_curve',
  'power_vs_hr', 'hr_load_model', 'segments', 'messages', 'original_file', 'fit_file', 'gpx_file',
] as const;

/** Read-only methods exposed by python-garminconnect, grouped for manifest tests and worker dispatch. */
export const garminReadRegistry = registry('garmin', [
  ['user_profile', 'singleton', 'profile'], ['userprofile_settings', 'singleton', 'profile_setting'], ['devices', 'collection', 'device'],
  ['device_settings', 'child', 'device_setting'], ['device_solar', 'date_range', 'device_solar'], ['device_alarms', 'collection', 'device_alarm'],
  ['stats', 'date_range', 'daily_stats'], ['user_summary', 'date_range', 'daily_health'], ['steps', 'date_range', 'steps'],
  ['heart_rates', 'date_range', 'heart_rate_day'], ['sleep', 'date_range', 'sleep'], ['stress', 'date_range', 'stress'], ['body_battery', 'date_range', 'body_battery'],
  ['respiration', 'date_range', 'respiration'], ['spo2', 'date_range', 'spo2'], ['hrv', 'date_range', 'hrv'], ['training_readiness', 'date_range', 'training_readiness'],
  ['training_status', 'date_range', 'training_status'], ['max_metrics', 'date_range', 'max_metric'], ['lactate_threshold', 'singleton', 'lactate_threshold'],
  ['endurance_score', 'date_range', 'endurance_score'], ['running_tolerance', 'date_range', 'running_tolerance'], ['race_predictions', 'date_range', 'race_prediction'],
  ['body_composition', 'date_range', 'body_composition'], ['weigh_ins', 'date_range', 'weigh_in'], ['blood_pressure', 'date_range', 'blood_pressure'],
  ['hydration', 'date_range', 'hydration'], ['nutrition_food_log', 'date_range', 'nutrition_log'], ['nutrition_meals', 'date_range', 'nutrition_log'], ['nutrition_settings', 'date_range', 'nutrition_setting'],
  ['menstrual', 'date_range', 'menstrual'], ['pregnancy_summary', 'singleton', 'pregnancy_summary'], ['activities', 'date_range', 'activity'],
  ['activity_details', 'activity', 'activity_detail'], ['activity_splits', 'activity', 'activity_interval'], ['activity_typed_splits', 'activity', 'activity_interval'],
  ['activity_split_summaries', 'activity', 'activity_interval'], ['activity_weather', 'activity', 'activity_weather'], ['activity_hr_zones', 'activity', 'activity_zone'],
  ['activity_power_zones', 'activity', 'activity_zone'], ['activity_exercise_sets', 'activity', 'activity_exercise_set'], ['activity_gear', 'activity', 'activity_gear'],
  ['activity_original', 'activity', 'activity_file'], ['activity_tcx', 'activity', 'activity_file'], ['activity_gpx', 'activity', 'activity_file'], ['activity_kml', 'activity', 'activity_file'],
  ['activity_csv', 'activity', 'activity_file'], ['workouts', 'collection', 'workout'], ['scheduled_workouts', 'date_range', 'scheduled_workout'],
  ['training_plans', 'collection', 'training_plan'], ['goals', 'collection', 'goal'], ['personal_records', 'singleton', 'personal_record'],
  ['earned_badges', 'collection', 'badge'], ['available_badges', 'collection', 'badge'], ['challenges', 'collection', 'challenge'],
  ['gear', 'collection', 'gear'], ['golf_summary', 'collection', 'golf_scorecard'], ['golf_user_stats', 'singleton', 'golf_user_stat'],
] as const);

export const stravaReadRegistry = registry('strava', [
  ['athlete', 'singleton', 'athlete'], ['gear', 'child', 'gear'],
  ['activity_candidates', 'date_range', 'activity'], ['activity_detail', 'activity', 'activity'],
  ['segment', 'child', 'segment'], ['segment_efforts', 'child', 'segment_effort'],
] as const);

export const allReadOnlyEndpoints = [...intervalsReadRegistry, ...garminReadRegistry, ...stravaReadRegistry] as const;

export function assertReadOnlyRegistry(): void {
  for (const endpoint of allReadOnlyEndpoints) {
    if (endpoint.readOnly !== true) throw new Error(`Unsafe endpoint registered: ${endpoint.provider}/${endpoint.name}`);
  }
}
