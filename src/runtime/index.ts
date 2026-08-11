/**
 * Internal runtime facade.
 *
 * Transports (CLI, MCP, and HTTP) import only from this module. The concrete
 * ETL, storage, analysis, and provider implementation remains free to evolve
 * behind this boundary and can later move into private workspace packages
 * without changing the public product adapters.
 */
export type { CatencePaths } from '../contracts/runtime.js';
export { CATENCE_PROTOCOL_VERSION, CATENCE_RUNTIME_VERSION, catenceRuntimeHealth } from '../contracts/release.js';

export { configuredMcpRateLimit, loadCatenceConfig, resolvePaths } from '../core/runtime/configuration.js';
export { SlidingWindowLimiter } from '../core/runtime/limiter.js';
export { DashboardSnapshotService } from '../core/dashboard/snapshot.js';
export { searchContext } from '../core/retrieval/index.js';
export { AnalyticsService } from '../core/query/analytics.js';
export type { DataFilter } from '../core/query/analytics.js';
export { ActivityDiscoveryService } from '../core/query/activity-discovery.js';
export { DATASET_CATALOG, getDataset, QueryValidationError } from '../core/query/catalog.js';
export { FitnessService } from '../core/query/fitness.js';
export { SwimmingService } from '../core/query/swimming.js';
export { WELLNESS_METRICS, WellnessService } from '../core/query/wellness.js';
export { jsonSafe, ReadOnlyRepository } from '../core/query/repository.js';
export { queryReadOnlyData } from '../core/query/sql-guard.js';

export { createDemoStore, demoStoreMetadata } from '../elt/application/demo.js';
export {
  connectStrava,
  connectStravaWithCallback,
  dataStatus,
  disconnectStravaAccount,
  initializeDataStore,
  linkActivity,
  rebuildRetrievalIndex,
  retryDataSync,
  syncData,
  unlinkActivity,
} from '../elt/application/management.js';
export type { ProviderChoice } from '../elt/application/management.js';
export { openReadOnlyRepository, ReadOnlyDatabaseError } from '../elt/storage/database.js';
export { DataWriteBusyError } from '../elt/storage/write-lock.js';
export {
  hydrateStravaActivity,
  hydrateStravaSegmentHistory,
  StravaEnrichmentError,
  StravaRateLimitError,
} from '../elt/ingestion/providers/strava/service.js';
