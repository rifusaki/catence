/**
 * Internal runtime facade.
 *
 * Transports (CLI, MCP, and HTTP) import only from this module. The concrete
 * ETL, storage, analysis, and provider implementation remains free to evolve
 * behind this boundary and can later move into private workspace packages
 * without changing the public product adapters.
 */
export type { CatencePaths } from '../contracts/runtime.js';
export {
  channelForVersion,
  compareReleaseVersions,
  fetchNpmDistTags,
  fetchPypiReleases,
  hasCommand,
  isGlobalNpmInstall,
  latestRelease,
  npmGlobalPrefix,
  parseReleaseVersion,
  planSelfUpdate,
  readInstalledConsoleVersion,
  runSelfUpdateCommand,
} from '../core/runtime/self-update.js';
export type { SelfUpdatePlan, UpdateChannel } from '../core/runtime/self-update.js';
export { CATENCE_PROTOCOL_VERSION, CATENCE_RUNTIME_VERSION, catenceRuntimeHealth } from '../contracts/release.js';

export { configuredMcpRateLimit, loadCatenceConfig, resolvePaths } from '../core/runtime/configuration.js';
export {
  addAthlete,
  athleteStorePaths,
  defaultAthlete,
  defaultCatalogHome,
  initializeCatalog,
  loadCatalog,
  resolveAthlete,
  resolveCatalogPaths,
} from '../core/runtime/catalog.js';
export type { Athlete, CatalogPaths, CatenceCatalog } from '../core/runtime/catalog.js';
export { athleteProviderEnvironment, providerSecretPath, readAthleteSecrets, setAthleteSecret } from '../core/runtime/secrets.js';
export type { AthleteSecrets, SecretProvider } from '../core/runtime/secrets.js';
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
  importStagedFile,
  linkActivity,
  rebuildRetrievalIndex,
  reimportNutrition,
  resolveExtractionErrors,
  retryDataSync,
  syncData,
  syncProgress,
  unlinkActivity,
} from '../elt/application/management.js';
export type { ProviderChoice } from '../elt/application/management.js';
export {
  DETACHED_SYNC_PROVIDERS,
  DetachedSyncBusyError,
  startDetachedSync,
} from '../elt/application/detached-sync.js';
export type { DetachedSyncHandle, DetachedSyncProvider, DetachedSyncRequest, DetachedSyncSpawner } from '../elt/application/detached-sync.js';
export {
  buildOpenCodeGoConsoleProfiles,
  classifyOpenCodeGoModel,
  fetchOpenCodeGoModelIds,
  mergeOpenCodeGoConsoleProfiles,
  OPENCODE_GO_API_BASE_ENV,
  OPENCODE_GO_API_KEY_ENV,
  OPENCODE_GO_DEFAULT_BASE_URL,
  OPENCODE_GO_MESSAGES_API_BASE_ENV,
} from '../core/runtime/opencode-go.js';
export type { OpenCodeGoConsoleProfiles, OpenCodeGoMergeResult, OpenCodeGoRoute } from '../core/runtime/opencode-go.js';
export type { InterruptedRuns, SyncProgressSnapshot, SyncProgressState } from '../contracts/progress.js';
export { openReadOnlyRepository, ReadOnlyDatabaseError } from '../elt/storage/database.js';
export { DataWriteBusyError } from '../elt/storage/write-lock.js';
export {
  hydrateStravaActivity,
  hydrateStravaSegmentHistory,
  StravaEnrichmentError,
  StravaRateLimitError,
} from '../elt/ingestion/providers/strava/service.js';
