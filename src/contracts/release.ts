/**
 * Stable runtime contract used by independently distributed Catence clients.
 * Keep these values synchronized with release/manifest.json; release checks
 * deliberately reject drift before a package can be published.
 */
export const CATENCE_RUNTIME_VERSION = '0.2.0-beta.25';
export const CATENCE_PROTOCOL_VERSION = 1;

export type CatenceRuntimeCapabilities = {
  mcp: true;
  dashboardApi: 1;
  demoStore: true;
};

export type CatenceRuntimeHealth = {
  status: 'ok';
  service: 'catence';
  runtimeVersion: string;
  protocolVersion: number;
  capabilities: CatenceRuntimeCapabilities;
};

export function catenceRuntimeHealth(): CatenceRuntimeHealth {
  return {
    status: 'ok',
    service: 'catence',
    runtimeVersion: CATENCE_RUNTIME_VERSION,
    protocolVersion: CATENCE_PROTOCOL_VERSION,
    capabilities: { mcp: true, dashboardApi: 1, demoStore: true },
  };
}
