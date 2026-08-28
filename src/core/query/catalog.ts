export type DatasetName =
  | 'activities'
  | 'canonical_activities'
  | 'canonical_activity_facts'
  | 'activity_sources'
  | 'activity_summaries'
  | 'activity_intervals'
  | 'swim_lengths'
  | 'swim_sets'
  | 'activity_quality_flags'
  | 'daily_metrics'
  | 'daily_health'
  | 'training_metrics'
  | 'training_metric_observations'
  | 'wellness_samples'
  | 'health_sessions'
  | 'power_bests'
  | 'activity_decoupling'
  | 'nutrition_days'
  | 'nutrition_items'
  | 'events'
  | 'workouts'
  | 'workout_documents'
  | 'training_plans'
  | 'routes'
  | 'gear'
  | 'devices'
  | 'goals'
  | 'achievements'
  | 'messages'
  | 'source_entities'
  | 'activity_samples'
  | 'activity_links'
  | 'activity_segments'
  | 'segments'
  | 'segment_effort_history'
  | 'strava_gear';

export type CatalogColumn = {
  name: string;
  type: string;
  unit?: string;
  description?: string;
  filterable?: boolean;
  groupable?: boolean;
  metric?: boolean;
};

export type DatasetDefinition = {
  name: DatasetName;
  relation?: string;
  description: string;
  dateColumn?: string;
  provenanceColumns: string[];
  columns: CatalogColumn[];
  permittedGroupings: string[];
  samplesOnly?: boolean;
};

const column = (name: string, type: string, options: Omit<CatalogColumn, 'name' | 'type'> = {}): CatalogColumn => ({ name, type, ...options });

export const DATASET_CATALOG: Record<Exclude<DatasetName, 'training_metrics'>, DatasetDefinition> = {
  activities: {
    name: 'activities', relation: 'activities', description: 'Logical activities linked by provider IDs, unique high-confidence fuzzy evidence, or an explicit manual correction.', dateColumn: 'started_at_utc', provenanceColumns: ['activity_id', 'link_state'], permittedGroupings: ['sport', 'link_state'],
    columns: [column('activity_id', 'VARCHAR', { filterable: true, groupable: true }), column('started_at_utc', 'TIMESTAMPTZ', { filterable: true }), column('started_at_local', 'VARCHAR'), column('timezone', 'VARCHAR'), column('sport', 'VARCHAR', { filterable: true, groupable: true }), column('name', 'VARCHAR', { filterable: true }), column('link_state', 'VARCHAR', { filterable: true, groupable: true })],
  },
  canonical_activities: {
    name: 'canonical_activities', relation: 'canonical_activity_training', description: 'One training interpretation per linked activity; Garmin is canonical when present, while Intervals analysis values remain separately provenance-tagged. A NULL avg_power here does not mean no power was recorded: running/cycling power lives in power_best_facts (Garmin FIT-derived). Use power_coverage_report or read_series on activity_samples rather than inferring absence. derived_avg_power_w is the FIT-derived mean per activity (avg of power_best_facts best_power_w) when summary avg_power is sparse; prefer coalesce(avg_power, derived_avg_power_w) for coverage-aware aggregates. NULL avg_power here does not mean no power; running/cycling power is in power_best_facts (FIT-derived). Use power_coverage_report / read_series.', dateColumn: 'started_at_utc', provenanceColumns: ['activity_id', 'activity_source_id', 'provider'], permittedGroupings: ['provider', 'sport'],
    columns: [column('activity_id', 'VARCHAR', { filterable: true, groupable: true }), column('activity_source_id', 'VARCHAR', { filterable: true }), column('provider', 'VARCHAR', { filterable: true, groupable: true }), column('started_at_utc', 'TIMESTAMPTZ', { filterable: true }), column('sport', 'VARCHAR', { filterable: true, groupable: true }), column('name', 'VARCHAR'), column('distance_m', 'DOUBLE', { unit: 'm', metric: true }), column('moving_s', 'DOUBLE', { unit: 's', metric: true }), column('elapsed_s', 'DOUBLE', { unit: 's', metric: true }), column('elevation_gain_m', 'DOUBLE', { unit: 'm', metric: true }), column('calories', 'DOUBLE', { unit: 'kcal', metric: true }), column('avg_hr', 'DOUBLE', { unit: 'bpm', metric: true }), column('max_hr', 'DOUBLE', { unit: 'bpm', metric: true }), column('avg_power', 'DOUBLE', { unit: 'W', metric: true }), column('derived_avg_power_w', 'DOUBLE', { unit: 'W', metric: true, description: 'FIT-derived mean power per activity (avg of power_best_facts best_power_w); complement for sparse avg_power.' }), column('weighted_power', 'DOUBLE', { unit: 'W', metric: true }), column('training_load', 'DOUBLE', { metric: true }), column('rpe', 'DOUBLE', { metric: true }), column('feel', 'DOUBLE', { metric: true })],
  },
  canonical_activity_facts: {
    name: 'canonical_activity_facts', relation: 'canonical_activity_facts', description: 'Field-level canonical activity values. Garmin is preferred when available; the original Garmin and Intervals values, selected source, disagreement, and quality flags remain visible.', dateColumn: 'started_at_utc', provenanceColumns: ['activity_id', 'garmin_activity_source_id', 'intervals_activity_source_id', 'distance_source', 'quality_flags'], permittedGroupings: ['sport', 'link_state', 'distance_source'],
    columns: [column('activity_id', 'VARCHAR', { filterable: true, groupable: true }), column('started_at_utc', 'TIMESTAMPTZ', { filterable: true }), column('sport', 'VARCHAR', { filterable: true, groupable: true }), column('name', 'VARCHAR'), column('link_state', 'VARCHAR', { filterable: true, groupable: true }), column('garmin_activity_source_id', 'VARCHAR', { filterable: true }), column('intervals_activity_source_id', 'VARCHAR', { filterable: true }), column('garmin_distance_m', 'DOUBLE', { unit: 'm', metric: true }), column('intervals_distance_m', 'DOUBLE', { unit: 'm', metric: true }), column('resolved_distance_m', 'DOUBLE', { unit: 'm', metric: true }), column('distance_source', 'VARCHAR', { filterable: true, groupable: true }), column('garmin_moving_s', 'DOUBLE', { unit: 's', metric: true }), column('intervals_moving_s', 'DOUBLE', { unit: 's', metric: true }), column('resolved_moving_s', 'DOUBLE', { unit: 's', metric: true }), column('moving_s_source', 'VARCHAR', { filterable: true, groupable: true }), column('garmin_elapsed_s', 'DOUBLE', { unit: 's', metric: true }), column('intervals_elapsed_s', 'DOUBLE', { unit: 's', metric: true }), column('resolved_elapsed_s', 'DOUBLE', { unit: 's', metric: true }), column('elapsed_s_source', 'VARCHAR', { filterable: true, groupable: true }), column('garmin_avg_hr', 'DOUBLE', { unit: 'bpm', metric: true }), column('intervals_avg_hr', 'DOUBLE', { unit: 'bpm', metric: true }), column('resolved_avg_hr', 'DOUBLE', { unit: 'bpm', metric: true }), column('avg_hr_source', 'VARCHAR', { filterable: true, groupable: true }), column('provider_distance_difference_m', 'DOUBLE', { unit: 'm', metric: true }), column('quality_flags', 'JSON')],
  },
  activity_sources: {
    name: 'activity_sources', relation: 'activity_sources', description: 'Provider-specific activity identities and source artifact references.', provenanceColumns: ['provider', 'remote_activity_id', 'raw_object_hash'], permittedGroupings: ['provider'],
    columns: [column('activity_source_id', 'VARCHAR', { filterable: true, groupable: true }), column('activity_id', 'VARCHAR', { filterable: true, groupable: true }), column('provider', 'VARCHAR', { filterable: true, groupable: true }), column('remote_activity_id', 'VARCHAR', { filterable: true }), column('external_id', 'VARCHAR', { filterable: true }), column('raw_object_hash', 'VARCHAR')],
  },
  activity_summaries: {
    name: 'activity_summaries', relation: 'activity_summary_facts', description: 'Provider activity summary metrics with activity and timestamp provenance. A NULL avg_power does not mean no power; FIT-derived power is in power_best_facts. Prefer power_coverage_report or read_series over inferring absence. NULL avg_power here does not mean no power; running/cycling power is in power_best_facts (FIT-derived). Use power_coverage_report / read_series.', dateColumn: 'started_at_utc', provenanceColumns: ['activity_source_id', 'activity_id', 'provider', 'raw_object_hash'], permittedGroupings: ['provider', 'sport'],
    columns: [column('activity_source_id', 'VARCHAR', { filterable: true, groupable: true }), column('activity_id', 'VARCHAR', { filterable: true, groupable: true }), column('provider', 'VARCHAR', { filterable: true, groupable: true }), column('started_at_utc', 'TIMESTAMPTZ', { filterable: true }), column('sport', 'VARCHAR', { filterable: true, groupable: true }), column('name', 'VARCHAR', { filterable: true }), column('distance_m', 'DOUBLE', { unit: 'm', metric: true }), column('moving_s', 'DOUBLE', { unit: 's', metric: true }), column('elapsed_s', 'DOUBLE', { unit: 's', metric: true }), column('elevation_gain_m', 'DOUBLE', { unit: 'm', metric: true }), column('calories', 'DOUBLE', { unit: 'kcal', metric: true }), column('avg_hr', 'DOUBLE', { unit: 'bpm', metric: true }), column('max_hr', 'DOUBLE', { unit: 'bpm', metric: true }), column('avg_power', 'DOUBLE', { unit: 'W', metric: true }), column('weighted_power', 'DOUBLE', { unit: 'W', metric: true }), column('avg_cadence', 'DOUBLE', { unit: 'rpm', metric: true }), column('training_load', 'DOUBLE', { metric: true }), column('rpe', 'DOUBLE', { metric: true }), column('feel', 'DOUBLE', { metric: true })],
  },
  activity_intervals: {
    name: 'activity_intervals', relation: 'activity_interval_facts', description: 'Structured intervals attached to an activity source.', dateColumn: 'started_at_utc', provenanceColumns: ['activity_source_id', 'activity_id', 'provider'], permittedGroupings: ['provider', 'sport', 'label'],
    columns: [column('activity_source_id', 'VARCHAR', { filterable: true, groupable: true }), column('activity_id', 'VARCHAR', { filterable: true, groupable: true }), column('provider', 'VARCHAR', { filterable: true, groupable: true }), column('started_at_utc', 'TIMESTAMPTZ', { filterable: true }), column('sport', 'VARCHAR', { filterable: true, groupable: true }), column('interval_key', 'VARCHAR', { filterable: true }), column('label', 'VARCHAR', { filterable: true, groupable: true }), column('source_type', 'VARCHAR', { filterable: true, groupable: true }), column('start_s', 'DOUBLE', { unit: 's', metric: true }), column('end_s', 'DOUBLE', { unit: 's', metric: true }), column('duration_s', 'DOUBLE', { unit: 's', metric: true }), column('moving_s', 'DOUBLE', { unit: 's', metric: true }), column('distance_m', 'DOUBLE', { unit: 'm', metric: true }), column('avg_power', 'DOUBLE', { unit: 'W', metric: true }), column('avg_hr', 'DOUBLE', { unit: 'bpm', metric: true }), column('avg_pace', 'DOUBLE', { metric: true }), column('intensity', 'DOUBLE', { metric: true })],
  },
  swim_lengths: {
    name: 'swim_lengths', relation: 'swim_length_facts', description: 'Explicit provider-supplied swim-length facts. An empty result means lengths were not supplied; Catence does not infer them from activity samples.', dateColumn: 'started_at_utc', provenanceColumns: ['activity_source_id', 'source', 'confidence', 'raw_object_hash'], permittedGroupings: ['provider', 'sport', 'source', 'confidence', 'is_rest'],
    columns: [column('activity_source_id', 'VARCHAR', { filterable: true, groupable: true }), column('activity_id', 'VARCHAR', { filterable: true, groupable: true }), column('provider', 'VARCHAR', { filterable: true, groupable: true }), column('started_at_utc', 'TIMESTAMPTZ', { filterable: true }), column('sport', 'VARCHAR', { filterable: true, groupable: true }), column('source', 'VARCHAR', { filterable: true, groupable: true }), column('confidence', 'VARCHAR', { filterable: true, groupable: true }), column('length_index', 'INTEGER', { filterable: true, groupable: true }), column('lap_index', 'INTEGER', { filterable: true, groupable: true }), column('pool_length_m', 'DOUBLE', { unit: 'm', metric: true }), column('start_time', 'TIMESTAMPTZ', { filterable: true }), column('duration_s', 'DOUBLE', { unit: 's', metric: true }), column('active_duration_s', 'DOUBLE', { unit: 's', metric: true }), column('distance_m', 'DOUBLE', { unit: 'm', metric: true }), column('stroke_count', 'DOUBLE', { unit: 'count', metric: true }), column('stroke_rate', 'DOUBLE', { unit: 'strokes/min', metric: true }), column('swolf', 'DOUBLE', { metric: true }), column('avg_hr', 'DOUBLE', { unit: 'bpm', metric: true }), column('max_hr', 'DOUBLE', { unit: 'bpm', metric: true }), column('is_rest', 'BOOLEAN', { filterable: true, groupable: true }), column('raw_object_hash', 'VARCHAR')],
  },
  swim_sets: {
    name: 'swim_sets', relation: 'swim_set_facts', description: 'Provider swim groupings. source_type distinguishes Garmin detected/manual groupings from Intervals.icu auto-detected blocks; labels and unprovided durations remain explicit.', dateColumn: 'started_at_utc', provenanceColumns: ['activity_source_id', 'source_type', 'raw_object_hash'], permittedGroupings: ['provider', 'sport', 'source_type', 'label'],
    columns: [column('activity_source_id', 'VARCHAR', { filterable: true, groupable: true }), column('activity_id', 'VARCHAR', { filterable: true, groupable: true }), column('provider', 'VARCHAR', { filterable: true, groupable: true }), column('started_at_utc', 'TIMESTAMPTZ', { filterable: true }), column('sport', 'VARCHAR', { filterable: true, groupable: true }), column('source_type', 'VARCHAR', { filterable: true, groupable: true }), column('set_index', 'INTEGER', { filterable: true, groupable: true }), column('label', 'VARCHAR', { filterable: true, groupable: true }), column('reps', 'INTEGER', { metric: true }), column('rep_distance_m', 'DOUBLE', { unit: 'm', metric: true }), column('total_distance_m', 'DOUBLE', { unit: 'm', metric: true }), column('work_s', 'DOUBLE', { unit: 's', metric: true }), column('rest_s', 'DOUBLE', { unit: 's', metric: true }), column('avg_pace', 'DOUBLE', { metric: true }), column('avg_hr', 'DOUBLE', { unit: 'bpm', metric: true }), column('max_hr', 'DOUBLE', { unit: 'bpm', metric: true }), column('stroke_rate', 'DOUBLE', { unit: 'strokes/min', metric: true }), column('raw_object_hash', 'VARCHAR')],
  },
  activity_quality_flags: {
    name: 'activity_quality_flags', relation: 'activity_quality_flag_facts', description: 'Ingestion-time quality and completeness flags. They flag caveats without deleting or overwriting provider source values.', dateColumn: 'started_at_utc', provenanceColumns: ['activity_source_id', 'flag_code', 'raw_object_hash'], permittedGroupings: ['provider', 'sport', 'flag_code', 'severity'],
    columns: [column('activity_source_id', 'VARCHAR', { filterable: true, groupable: true }), column('activity_id', 'VARCHAR', { filterable: true, groupable: true }), column('provider', 'VARCHAR', { filterable: true, groupable: true }), column('started_at_utc', 'TIMESTAMPTZ', { filterable: true }), column('sport', 'VARCHAR', { filterable: true, groupable: true }), column('flag_code', 'VARCHAR', { filterable: true, groupable: true }), column('severity', 'VARCHAR', { filterable: true, groupable: true }), column('details_json', 'JSON'), column('raw_object_hash', 'VARCHAR')],
  },
  daily_metrics: {
    name: 'daily_metrics', relation: 'daily_metrics', description: 'Long-form provider daily facts. Metric names and units are explicit.', dateColumn: 'metric_date', provenanceColumns: ['provider', 'raw_object_hash'], permittedGroupings: ['provider', 'metric_name'],
    columns: [column('provider', 'VARCHAR', { filterable: true, groupable: true }), column('metric_date', 'DATE', { filterable: true, groupable: true }), column('metric_name', 'VARCHAR', { filterable: true, groupable: true }), column('value_number', 'DOUBLE', { metric: true }), column('value_text', 'VARCHAR'), column('unit', 'VARCHAR', { filterable: true, groupable: true }), column('raw_object_hash', 'VARCHAR')],
  },
  daily_health: {
    name: 'daily_health', relation: 'daily_health', description: 'One canonical daily-health record per date. Garmin wins whenever it has facts for that date; Intervals or another provider is a whole-day fallback. Use daily_metrics to compare source observations.', dateColumn: 'metric_date', provenanceColumns: ['provider'], permittedGroupings: ['provider'],
    columns: [column('provider', 'VARCHAR', { filterable: true, groupable: true }), column('metric_date', 'DATE', { filterable: true, groupable: true }), column('resting_hr_bpm', 'DOUBLE', { unit: 'bpm', metric: true }), column('hrv_ms', 'DOUBLE', { unit: 'ms', metric: true }), column('sleep_seconds', 'DOUBLE', { unit: 's', metric: true }), column('sleep_score', 'DOUBLE', { metric: true }), column('stress', 'DOUBLE', { metric: true }), column('body_battery', 'DOUBLE', { metric: true }), column('readiness', 'DOUBLE', { metric: true }), column('spo2_pct', 'DOUBLE', { unit: '%', metric: true }), column('weight_kg', 'DOUBLE', { unit: 'kg', metric: true }), column('steps', 'DOUBLE', { unit: 'count', metric: true })],
  },
  training_metric_observations: {
    name: 'training_metric_observations', relation: 'training_metric_observations', description: 'Provider training-metric observations. Garmin retains cycling FTP history/settings/activity values and its latest running lactate-threshold power, pace, and heart-rate settings with provenance. Garmin may label its running VO₂max estimate as generic.', dateColumn: 'observed_at', provenanceColumns: ['provider', 'source_type', 'source_remote_id', 'activity_source_id', 'raw_object_hash'], permittedGroupings: ['provider', 'metric_name', 'sport', 'source_type'],
    columns: [column('observation_id', 'VARCHAR', { filterable: true, groupable: true }), column('provider', 'VARCHAR', { filterable: true, groupable: true }), column('metric_name', 'VARCHAR', { filterable: true, groupable: true }), column('sport', 'VARCHAR', { filterable: true, groupable: true }), column('observed_at', 'TIMESTAMPTZ', { filterable: true }), column('value_number', 'DOUBLE', { metric: true }), column('value_text', 'VARCHAR', { filterable: true, groupable: true }), column('unit', 'VARCHAR', { filterable: true, groupable: true }), column('device_id', 'VARCHAR', { filterable: true, groupable: true }), column('dimensions_json', 'JSON'), column('source_type', 'VARCHAR', { filterable: true, groupable: true }), column('source_remote_id', 'VARCHAR', { filterable: true }), column('activity_source_id', 'VARCHAR', { filterable: true }), column('raw_object_hash', 'VARCHAR')],
  },
  wellness_samples: {
    name: 'wellness_samples', relation: 'wellness_samples', description: 'Timestamped Garmin health-series samples for heart rate, HRV, stress, and Body Battery.', dateColumn: 'observed_at', provenanceColumns: ['provider', 'source_type', 'source_remote_id', 'raw_object_hash'], permittedGroupings: ['provider', 'metric_name', 'source_type'],
    columns: [column('sample_id', 'VARCHAR', { filterable: true }), column('provider', 'VARCHAR', { filterable: true, groupable: true }), column('metric_name', 'VARCHAR', { filterable: true, groupable: true }), column('observed_at', 'TIMESTAMPTZ', { filterable: true }), column('value_number', 'DOUBLE', { metric: true }), column('unit', 'VARCHAR', { filterable: true, groupable: true }), column('source_type', 'VARCHAR', { filterable: true, groupable: true }), column('source_remote_id', 'VARCHAR', { filterable: true }), column('raw_object_hash', 'VARCHAR')],
  },
  health_sessions: {
    name: 'health_sessions', relation: 'health_sessions', description: 'Garmin sleep, nap, daily-event, and Body Battery event records with their source payload retained.', dateColumn: 'occurred_on', provenanceColumns: ['provider', 'source_type', 'source_remote_id', 'raw_object_hash'], permittedGroupings: ['provider', 'session_type', 'source_type'],
    columns: [column('session_id', 'VARCHAR', { filterable: true }), column('provider', 'VARCHAR', { filterable: true, groupable: true }), column('session_type', 'VARCHAR', { filterable: true, groupable: true }), column('occurred_on', 'DATE', { filterable: true, groupable: true }), column('started_at', 'TIMESTAMPTZ', { filterable: true }), column('ended_at', 'TIMESTAMPTZ', { filterable: true }), column('source_type', 'VARCHAR', { filterable: true, groupable: true }), column('source_remote_id', 'VARCHAR', { filterable: true }), column('payload_json', 'JSON'), column('raw_object_hash', 'VARCHAR')],
  },
  power_bests: {
    name: 'power_bests', relation: 'power_best_facts', description: 'Power-duration bests derived from Garmin FIT streams; they are labelled derived while retaining the Garmin activity provenance.', dateColumn: 'started_at_utc', provenanceColumns: ['provider', 'activity_source_id', 'source_type', 'raw_object_hash'], permittedGroupings: ['provider', 'sport', 'duration_s', 'source_type'],
    columns: [column('provider', 'VARCHAR', { filterable: true, groupable: true }), column('activity_source_id', 'VARCHAR', { filterable: true, groupable: true }), column('activity_id', 'VARCHAR', { filterable: true, groupable: true }), column('started_at_utc', 'TIMESTAMPTZ', { filterable: true }), column('sport', 'VARCHAR', { filterable: true, groupable: true }), column('duration_s', 'INTEGER', { filterable: true, groupable: true }), column('best_power_w', 'DOUBLE', { unit: 'W', metric: true }), column('source_type', 'VARCHAR', { filterable: true, groupable: true }), column('raw_object_hash', 'VARCHAR')],
  },
  activity_decoupling: {
    name: 'activity_decoupling', relation: 'activity_decoupling_facts', description: 'Persisted per-activity aerobic decoupling (Pa:Hr, pct) and grade-adjusted pace (s/km) with provenance. source_type provider means the provider payload supplied the value (authoritative); derived values are tagged locally. Values never overwrite provider output. Not a physiological performance model.', dateColumn: 'started_at_utc', provenanceColumns: ['provider', 'activity_source_id', 'raw_object_hash'], permittedGroupings: ['provider', 'sport', 'metric', 'source_type'],
    columns: [column('provider', 'VARCHAR', { filterable: true, groupable: true }), column('activity_source_id', 'VARCHAR', { filterable: true, groupable: true }), column('sport', 'VARCHAR', { filterable: true, groupable: true }), column('started_at_utc', 'TIMESTAMPTZ', { filterable: true }), column('metric', 'VARCHAR', { filterable: true, groupable: true }), column('value_number', 'DOUBLE', { metric: true }), column('unit', 'VARCHAR', { filterable: true, groupable: true }), column('source_type', 'VARCHAR', { filterable: true, groupable: true }), column('raw_object_hash', 'VARCHAR')],
  },
  nutrition_days: {
    name: 'nutrition_days', relation: 'nutrition_days', description: 'Daily nutrition totals, never a replacement for the item-level food log.', dateColumn: 'nutrition_date', provenanceColumns: ['provider', 'raw_object_hash'], permittedGroupings: ['provider'],
    columns: [column('provider', 'VARCHAR', { filterable: true, groupable: true }), column('nutrition_date', 'DATE', { filterable: true, groupable: true }), column('energy_kcal', 'DOUBLE', { unit: 'kcal', metric: true }), column('carbohydrates_g', 'DOUBLE', { unit: 'g', metric: true }), column('protein_g', 'DOUBLE', { unit: 'g', metric: true }), column('fat_g', 'DOUBLE', { unit: 'g', metric: true }), column('hydration_ml', 'DOUBLE', { unit: 'ml', metric: true }), column('raw_object_hash', 'VARCHAR')],
  },
  nutrition_items: {
    name: 'nutrition_items', relation: 'nutrition_items', description: 'Meal and food-item detail retained from the provider.', dateColumn: 'nutrition_date', provenanceColumns: ['provider', 'remote_item_id', 'raw_object_hash'], permittedGroupings: ['provider', 'meal', 'food_name'],
    columns: [column('provider', 'VARCHAR', { filterable: true, groupable: true }), column('remote_item_id', 'VARCHAR', { filterable: true }), column('nutrition_date', 'DATE', { filterable: true, groupable: true }), column('meal', 'VARCHAR', { filterable: true, groupable: true }), column('consumed_at', 'TIMESTAMPTZ', { filterable: true }), column('food_name', 'VARCHAR', { filterable: true, groupable: true }), column('quantity', 'DOUBLE', { metric: true }), column('energy_kcal', 'DOUBLE', { unit: 'kcal', metric: true }), column('carbohydrates_g', 'DOUBLE', { unit: 'g', metric: true }), column('protein_g', 'DOUBLE', { unit: 'g', metric: true }), column('fat_g', 'DOUBLE', { unit: 'g', metric: true }), column('raw_object_hash', 'VARCHAR')],
  },
  events: domain('events', 'event_id', 'Planned and completed calendar events.', 'occurred_on'),
  workouts: domain('workouts', 'workout_id', 'Provider workouts and scheduled workouts.', 'occurred_on'),
  workout_documents: {
    name: 'workout_documents', relation: 'workout_documents', description: 'Structured workout documents.', provenanceColumns: ['provider', 'workout_id'], permittedGroupings: ['provider'],
    columns: [column('provider', 'VARCHAR', { filterable: true, groupable: true }), column('workout_id', 'VARCHAR', { filterable: true, groupable: true }), column('workout_doc', 'JSON'), column('payload_json', 'JSON')],
  },
  training_plans: domain('training_plans', 'training_plan_id', 'Training plans and plan hierarchy.', 'occurred_on'),
  routes: domain('routes', 'route_id', 'Saved routes.'),
  gear: domain('gear', 'gear_id', 'Equipment and gear records.'),
  devices: domain('devices', 'device_id', 'Device metadata and ownership details.'),
  goals: domain('goals', 'goal_id', 'Goals and challenges.'),
  achievements: domain('achievements', 'achievement_id', 'Badges and personal records.'),
  messages: domain('messages', 'message_id', 'Provider chat/messages.', 'occurred_on'),
  source_entities: {
    name: 'source_entities', relation: 'source_entities', description: 'All raw-normalized source entities, including fields not modelled elsewhere.', dateColumn: 'occurred_on', provenanceColumns: ['provider', 'entity_type', 'remote_id', 'raw_object_hash'], permittedGroupings: ['provider', 'entity_type'],
    columns: [column('provider', 'VARCHAR', { filterable: true, groupable: true }), column('entity_type', 'VARCHAR', { filterable: true, groupable: true }), column('remote_id', 'VARCHAR', { filterable: true }), column('parent_remote_id', 'VARCHAR', { filterable: true }), column('occurred_on', 'DATE', { filterable: true, groupable: true }), column('source_updated_at', 'TIMESTAMPTZ', { filterable: true }), column('raw_object_hash', 'VARCHAR'), column('payload_json', 'JSON'), column('extension_json', 'JSON')],
  },
  activity_links: {
    name: 'activity_links', relation: 'activity_links', description: 'Auditable source-to-logical activity links and their evidence.', provenanceColumns: ['activity_source_id', 'method', 'evidence_json'], permittedGroupings: ['method'],
    columns: [column('activity_source_id', 'VARCHAR', { filterable: true, groupable: true }), column('activity_id', 'VARCHAR', { filterable: true, groupable: true }), column('method', 'VARCHAR', { filterable: true, groupable: true }), column('confidence', 'DOUBLE', { metric: true }), column('evidence_json', 'JSON'), column('linked_at', 'TIMESTAMPTZ', { filterable: true })],
  },
  activity_segments: {
    name: 'activity_segments', relation: 'activity_segments', description: 'Strava segment efforts embedded in a hydrated activity; absent values are not inferred.', dateColumn: 'started_at', provenanceColumns: ['activity_source_id', 'effort_id', 'segment_id', 'raw_object_hash'], permittedGroupings: ['segment_id'],
    columns: [column('activity_source_id', 'VARCHAR', { filterable: true, groupable: true }), column('effort_id', 'VARCHAR', { filterable: true, groupable: true }), column('segment_id', 'VARCHAR', { filterable: true, groupable: true }), column('elapsed_s', 'DOUBLE', { unit: 's', metric: true }), column('moving_s', 'DOUBLE', { unit: 's', metric: true }), column('distance_m', 'DOUBLE', { unit: 'm', metric: true }), column('average_watts', 'DOUBLE', { unit: 'W', metric: true }), column('average_hr', 'DOUBLE', { unit: 'bpm', metric: true }), column('max_hr', 'DOUBLE', { unit: 'bpm', metric: true }), column('average_cadence', 'DOUBLE', { unit: 'rpm', metric: true }), column('pr_rank', 'INTEGER', { metric: true }), column('kom_rank', 'INTEGER', { metric: true }), column('started_at', 'TIMESTAMPTZ', { filterable: true }), column('raw_object_hash', 'VARCHAR')],
  },
  segments: {
    name: 'segments', relation: 'strava_segments', description: 'Hydrated Strava segment facts. Verification is unavailable from the public API and is never inferred.', provenanceColumns: ['segment_id', 'raw_object_hash'], permittedGroupings: ['activity_type', 'climb_category', 'starred', 'private'],
    columns: [column('segment_id', 'VARCHAR', { filterable: true, groupable: true }), column('name', 'VARCHAR', { filterable: true, groupable: true }), column('activity_type', 'VARCHAR', { filterable: true, groupable: true }), column('distance_m', 'DOUBLE', { unit: 'm', metric: true }), column('average_grade_pct', 'DOUBLE', { unit: '%', metric: true }), column('maximum_grade_pct', 'DOUBLE', { unit: '%', metric: true }), column('climb_category', 'INTEGER', { filterable: true, groupable: true }), column('total_elevation_gain_m', 'DOUBLE', { unit: 'm', metric: true }), column('private', 'BOOLEAN', { filterable: true, groupable: true }), column('hazardous', 'BOOLEAN', { filterable: true, groupable: true }), column('starred', 'BOOLEAN', { filterable: true, groupable: true }), column('raw_object_hash', 'VARCHAR')],
  },
  segment_effort_history: {
    name: 'segment_effort_history', relation: 'segment_effort_history', description: 'Authenticated athlete historic Strava segment efforts, hydrated only on demand.', dateColumn: 'started_at', provenanceColumns: ['effort_id', 'segment_id', 'raw_object_hash'], permittedGroupings: ['segment_id', 'climb_category'],
    columns: [column('effort_id', 'VARCHAR', { filterable: true, groupable: true }), column('segment_id', 'VARCHAR', { filterable: true, groupable: true }), column('strava_activity_id', 'VARCHAR', { filterable: true }), column('segment_name', 'VARCHAR', { filterable: true, groupable: true }), column('average_grade_pct', 'DOUBLE', { unit: '%', metric: true }), column('climb_category', 'INTEGER', { filterable: true, groupable: true }), column('elapsed_s', 'DOUBLE', { unit: 's', metric: true }), column('moving_s', 'DOUBLE', { unit: 's', metric: true }), column('distance_m', 'DOUBLE', { unit: 'm', metric: true }), column('average_speed_mps', 'DOUBLE', { unit: 'm/s', metric: true }), column('average_watts', 'DOUBLE', { unit: 'W', metric: true }), column('average_hr', 'DOUBLE', { unit: 'bpm', metric: true }), column('average_cadence', 'DOUBLE', { unit: 'rpm', metric: true }), column('pr_rank', 'INTEGER', { metric: true }), column('kom_rank', 'INTEGER', { metric: true }), column('started_at', 'TIMESTAMPTZ', { filterable: true }), column('raw_object_hash', 'VARCHAR')],
  },
  strava_gear: {
    name: 'strava_gear', relation: 'strava_gear', description: 'Current Strava bikes and shoes, refreshed from the authenticated athlete profile.', provenanceColumns: ['gear_id', 'raw_object_hash'], permittedGroupings: ['provider'],
    columns: [column('provider', 'VARCHAR', { filterable: true, groupable: true }), column('gear_id', 'VARCHAR', { filterable: true, groupable: true }), column('payload_json', 'JSON'), column('extension_json', 'JSON'), column('raw_object_hash', 'VARCHAR')],
  },
  activity_samples: {
    name: 'activity_samples', description: 'Registered normalized activity samples from immutable Parquet; callers cannot supply file paths.', dateColumn: 'timestamp_utc', provenanceColumns: ['provider', 'activity_source_id', 'content_hash'], permittedGroupings: ['provider', 'activity_source_id'], samplesOnly: true,
    columns: [column('provider', 'VARCHAR', { filterable: true, groupable: true }), column('content_hash', 'VARCHAR', { filterable: true, groupable: true }), column('activity_source_id', 'VARCHAR', { filterable: true, groupable: true }), column('timestamp_utc', 'TIMESTAMPTZ', { filterable: true }), column('elapsed_s', 'DOUBLE', { unit: 's', metric: true }), column('distance_m', 'DOUBLE', { unit: 'm', metric: true }), column('latitude', 'DOUBLE', { unit: 'degrees', metric: true }), column('longitude', 'DOUBLE', { unit: 'degrees', metric: true }), column('altitude_m', 'DOUBLE', { unit: 'm', metric: true }), column('heart_rate_bpm', 'DOUBLE', { unit: 'bpm', metric: true }), column('power_w', 'DOUBLE', { unit: 'W', metric: true }), column('cadence_rpm', 'DOUBLE', { unit: 'rpm', metric: true }), column('speed_mps', 'DOUBLE', { unit: 'm/s', metric: true }), column('temperature_c', 'DOUBLE', { unit: 'C', metric: true }), column('grade_pct', 'DOUBLE', { unit: '%', metric: true }), column('left_right_balance_pct', 'DOUBLE', { unit: '%', metric: true }), column('left_torque_effectiveness_pct', 'DOUBLE', { unit: '%', metric: true }), column('right_torque_effectiveness_pct', 'DOUBLE', { unit: '%', metric: true }), column('left_pedal_smoothness_pct', 'DOUBLE', { unit: '%', metric: true }), column('right_pedal_smoothness_pct', 'DOUBLE', { unit: '%', metric: true }), column('left_power_phase_start_deg', 'DOUBLE', { unit: 'degrees', metric: true }), column('left_power_phase_end_deg', 'DOUBLE', { unit: 'degrees', metric: true }), column('right_power_phase_start_deg', 'DOUBLE', { unit: 'degrees', metric: true }), column('right_power_phase_end_deg', 'DOUBLE', { unit: 'degrees', metric: true }), column('left_power_phase_peak_start_deg', 'DOUBLE', { unit: 'degrees', metric: true }), column('left_power_phase_peak_end_deg', 'DOUBLE', { unit: 'degrees', metric: true }), column('right_power_phase_peak_start_deg', 'DOUBLE', { unit: 'degrees', metric: true }), column('right_power_phase_peak_end_deg', 'DOUBLE', { unit: 'degrees', metric: true }), column('left_platform_center_offset_mm', 'DOUBLE', { unit: 'mm', metric: true }), column('right_platform_center_offset_mm', 'DOUBLE', { unit: 'mm', metric: true }), column('extras_json', 'JSON')],
  },
};

function domain(name: DatasetName, id: string, description: string, dateColumn?: string): DatasetDefinition {
  return {
    name, relation: name, description, dateColumn, provenanceColumns: ['provider', id, 'raw_object_hash'], permittedGroupings: ['provider'],
    columns: [column('provider', 'VARCHAR', { filterable: true, groupable: true }), column(id, 'VARCHAR', { filterable: true, groupable: true }), ...(dateColumn ? [column(dateColumn, 'DATE', { filterable: true, groupable: true })] : []), column('payload_json', 'JSON'), column('extension_json', 'JSON'), column('raw_object_hash', 'VARCHAR')],
  };
}

export function getDataset(name: string): DatasetDefinition {
  // training_metrics was the original public catalog name. Keep it as a
  // backwards-compatible input alias, while presenting the actual queryable
  // relation everywhere so describe_dataset and the SQL allow-list agree.
  const normalizedName = name === 'training_metrics' ? 'training_metric_observations' : name;
  const dataset = DATASET_CATALOG[normalizedName as Exclude<DatasetName, 'training_metrics'>];
  if (!dataset) throw new QueryValidationError(`Unknown dataset: ${name}. Use describe_data to see the catalog.`);
  return dataset;
}

export function getColumn(dataset: DatasetDefinition, name: string): CatalogColumn {
  const found = dataset.columns.find((columnDefinition) => columnDefinition.name === name);
  if (!found) throw new QueryValidationError(`${name} is not a cataloged column of ${dataset.name}.`);
  return found;
}

export class QueryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryValidationError';
  }
}
