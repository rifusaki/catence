import { z } from 'zod';

export const PROVIDERS = ['intervals', 'garmin', 'strava'] as const;
export type Provider = (typeof PROVIDERS)[number];
export const STAGING_SCHEMA_VERSION = 1;

export const rawObjectSchema = z.object({
  kind: z.literal('raw_object'), schemaVersion: z.literal(STAGING_SCHEMA_VERSION), provider: z.enum(PROVIDERS),
  endpoint: z.string().min(1), remoteId: z.string().nullable(), fetchedAt: z.string().datetime(),
  contentHash: z.string().length(64), contentType: z.string().min(1), relativePath: z.string().min(1),
  scope: z.record(z.string(), z.unknown()).default({}),
});
export const runManifestSchema = z.object({
  kind: z.literal('run_manifest'), schemaVersion: z.literal(STAGING_SCHEMA_VERSION), provider: z.enum(PROVIDERS),
  runId: z.string().uuid(), fromDate: z.string().date(), createdAt: z.string().datetime(),
});
export const sourceEntitySchema = z.object({
  kind: z.literal('source_entity'), schemaVersion: z.literal(STAGING_SCHEMA_VERSION), provider: z.enum(PROVIDERS),
  entityType: z.string().min(1), remoteId: z.string().min(1), parentRemoteId: z.string().nullable().default(null),
  occurredOn: z.string().nullable().default(null), sourceUpdatedAt: z.string().nullable().default(null),
  rawObjectHash: z.string().length(64).nullable().default(null), payload: z.record(z.string(), z.unknown()),
  extension: z.record(z.string(), z.unknown()).default({}),
});
export const streamManifestSchema = z.object({
  kind: z.literal('stream_manifest'), schemaVersion: z.literal(STAGING_SCHEMA_VERSION), provider: z.enum(PROVIDERS),
  activityRemoteId: z.string().min(1), relativePath: z.string().min(1), contentHash: z.string().length(64),
  rowCount: z.number().int().nonnegative(), startAt: z.string().nullable(), endAt: z.string().nullable(),
  columns: z.array(z.string()), rawObjectHash: z.string().length(64).nullable().default(null),
});
export const activitySyncStateSchema = z.object({
  kind: z.literal('activity_sync_state'), schemaVersion: z.literal(STAGING_SCHEMA_VERSION), provider: z.enum(PROVIDERS),
  activityRemoteId: z.string().min(1), summaryHash: z.string().length(64), detailsFetched: z.boolean(),
});
export const extractionErrorSchema = z.object({
  kind: z.literal('extraction_error'), schemaVersion: z.literal(STAGING_SCHEMA_VERSION), provider: z.enum(PROVIDERS),
  endpoint: z.string().min(1), remoteId: z.string().nullable(), message: z.string().min(1), retryable: z.boolean().default(true),
});
export const stagingRecordSchema = z.discriminatedUnion('kind', [runManifestSchema, rawObjectSchema, sourceEntitySchema, streamManifestSchema, activitySyncStateSchema, extractionErrorSchema]);
export type StagingRecord = z.infer<typeof stagingRecordSchema>;
export type SourceEntity = z.infer<typeof sourceEntitySchema>;
export type EndpointSpec = {
  readonly provider: Provider;
  readonly name: string;
  readonly scope: 'singleton' | 'date_range' | 'activity' | 'collection' | 'child';
  readonly entityType: string;
  readonly readOnly: true;
  readonly pagination: 'none' | 'offset' | 'provider';
};
