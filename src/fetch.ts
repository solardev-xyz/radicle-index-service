/**
 * Crawl expansion: seed not-yet-stored repos discovered via gossip, most
 * seeded first, bounded per cycle and by a disk floor. Failures back off
 * (unreachable repos are common — seeders may simply be offline).
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { statfs } from "node:fs/promises";
import { dirname } from "node:path";
import type { RecordCache } from "./cache.ts";
import type { NetworkRepo } from "./discover.ts";
import { execRad } from "./rad.ts";

export interface CrawlState {
  /** rid → { failures, nextTryAt } */
  failed: Record<string, { failures: number; nextTryAt: number }>;
  /** sha256 over the shard bytes of the last published snapshot. */
  lastPublishedHash?: string;
}

export async function loadState(stateFile: string): Promise<CrawlState> {
  try {
    return JSON.parse(await readFile(stateFile, "utf8")) as CrawlState;
  } catch {
    return { failed: {} };
  }
}

export async function saveState(
  stateFile: string,
  state: CrawlState,
): Promise<void> {
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(stateFile, JSON.stringify(state));
}

export async function freeDiskGb(path: string): Promise<number> {
  const stats = await statfs(path);
  return (stats.bavail * stats.bsize) / 1e9;
}

/**
 * The crawl queue, in priority order (freshness beats breadth):
 *  1. evicted repos whose refs moved since extraction — their index
 *     records are stale;
 *  2. never-indexed repos — breadth;
 *  3. evicted repos whose record outlived the refresh window — safety net
 *     for announcements the node pruned or missed.
 * Gossip order (most-seeded first) is preserved within each group.
 */
export function selectFetchCandidates(
  gossip: NetworkRepo[],
  stored: Set<string>,
  cache: RecordCache,
  announcements: Map<string, number>,
  now: number,
  refreshMs: number,
): string[] {
  const stale: string[] = [];
  const fresh: string[] = [];
  const expired: string[] = [];
  for (const { rid } of gossip) {
    if (stored.has(rid)) continue;
    const cached = cache[rid];
    if (!cached) fresh.push(rid);
    else if ((announcements.get(rid) ?? 0) > cached.announceTs) stale.push(rid);
    else if (now - cached.extractedAt >= refreshMs) expired.push(rid);
  }
  return [...stale, ...fresh, ...expired];
}

const BACKOFF_BASE_MS = 60 * 60 * 1000; // 1h, doubling per failure, capped at a week

export interface FetchResult {
  fetched: string[];
  failed: string[];
  skippedDiskFloor: boolean;
}

/**
 * Seed up to `limit` candidate RIDs (already filtered to not-stored ones).
 */
export async function fetchNewRepos(
  radBin: string,
  radHome: string,
  candidates: string[],
  state: CrawlState,
  {
    limit,
    diskFloorGb,
    budgetMs = Infinity,
    now = Date.now(),
  }: { limit: number; diskFloorGb: number; budgetMs?: number; now?: number },
): Promise<FetchResult> {
  const result: FetchResult = {
    fetched: [],
    failed: [],
    skippedDiskFloor: false,
  };
  if (limit <= 0) return result;
  const deadline = Date.now() + budgetMs;

  for (const rid of candidates) {
    if (result.fetched.length >= limit) break;
    if (Date.now() > deadline) {
      console.log("[fetch] time budget exhausted — continuing next cycle");
      break;
    }

    const failure = state.failed[rid];
    if (failure && failure.nextTryAt > now) continue;

    if ((await freeDiskGb(radHome)) < diskFloorGb) {
      console.warn(
        `[fetch] disk floor reached (<${diskFloorGb} GB free) — pausing crawl`,
      );
      result.skippedDiskFloor = true;
      break;
    }

    try {
      console.log(`[fetch] seeding ${rid}`);
      await execRad(radBin, radHome, ["seed", rid, "--scope", "all"], 45_000);
      result.fetched.push(rid);
      delete state.failed[rid];
    } catch (err) {
      const failures = (failure?.failures ?? 0) + 1;
      const backoff = Math.min(
        BACKOFF_BASE_MS * 2 ** (failures - 1),
        7 * 24 * 3600 * 1000,
      );
      state.failed[rid] = { failures, nextTryAt: now + backoff };
      result.failed.push(rid);
      console.warn(
        `[fetch] ${rid} failed (${failures}x): ${(err as Error).message?.split("\n")[0]}`,
      );
    }
  }
  return result;
}
