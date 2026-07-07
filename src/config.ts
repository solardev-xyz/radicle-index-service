/**
 * All configuration via environment, adblock-service style. Everything has a
 * local-dev default except the feed signer key, which must be explicit for
 * any real publish (dry runs don't need it).
 */

export interface Config {
  /** Radicle home of the node this indexer reads (gossip db + storage). */
  radHome: string;
  /** Local radicle-httpd of that node. */
  httpdUrl: string;
  /** rad binary (for seeding newly discovered repos). */
  radBin: string;
  /** Bee node for publishing. */
  beeUrl: string;
  /** Feed owner + manifest signer key (hex). */
  signerKey: string | null;
  /** Postage batch; auto-selected (longest TTL) when omitted. */
  batchId: string | null;
  /** Max repos to fetch from the network per cycle (0 = don't fetch). */
  fetchPerCycle: number;
  /** Stop fetching new repos when free disk falls below this many GB. */
  diskFloorGb: number;
  /** Minutes between cycles in watch mode. */
  intervalMinutes: number;
  /** Where snapshot artifacts are staged before upload. */
  outDir: string;
  /** Where crawl state (failed RIDs, backoff) persists. */
  stateFile: string;
}

export function loadConfig(env = process.env): Config {
  const radHome = env.RAD_HOME ?? `${env.HOME}/.radicle`;
  return {
    radHome,
    httpdUrl: env.RADICLE_HTTPD_URL ?? 'http://127.0.0.1:8780',
    radBin: env.RAD_BIN ?? 'rad',
    beeUrl: env.BEE_API_URL ?? 'http://127.0.0.1:1633',
    signerKey: env.FEED_SIGNER_KEY ?? null,
    batchId: env.STAMP_BATCH_ID ?? null,
    fetchPerCycle: Number(env.FETCH_PER_CYCLE ?? 25),
    diskFloorGb: Number(env.DISK_FLOOR_GB ?? 10),
    intervalMinutes: Number(env.INTERVAL_MINUTES ?? 60),
    outDir: env.OUT_DIR ?? './out',
    stateFile: env.STATE_FILE ?? './out/state.json',
  };
}
