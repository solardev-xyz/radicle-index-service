/**
 * Crawl expansion: seed not-yet-stored repos discovered via gossip, most
 * seeded first, bounded per cycle and by a disk floor. Failures back off
 * (unreachable repos are common — seeders may simply be offline).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { statfs } from "node:fs/promises";
import { dirname } from "node:path";

const execFileAsync = promisify(execFile);

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
    now = Date.now(),
  }: { limit: number; diskFloorGb: number; now?: number },
): Promise<FetchResult> {
  const result: FetchResult = {
    fetched: [],
    failed: [],
    skippedDiskFloor: false,
  };
  if (limit <= 0) return result;

  for (const rid of candidates) {
    if (result.fetched.length >= limit) break;

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
      await execFileAsync(radBin, ["seed", rid, "--scope", "all"], {
        env: { ...process.env, RAD_HOME: radHome, RAD_PASSPHRASE: "" },
        timeout: 120_000,
      });
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
