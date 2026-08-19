/**
 * Post-extract storage eviction — the indexer needs a repo on disk only
 * long enough to extract it, so storage is a working set, not an archive.
 *
 * rad 1.9.1 has no storage-removal command: `rad unseed` drops the seeding
 * policy (so the node stops re-fetching and serving the repo), then the
 * storage directory is deleted directly. The index record lives on in the
 * record cache; a newer refs announcement re-queues the repo for fetching.
 */

import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { execRad } from "./rad.ts";

/** `rad unseed` accepts many RIDs — chunking keeps the first mass eviction
 * (thousands of repos) to dozens of process spawns instead of one each. */
const UNSEED_CHUNK = 100;

export interface EvictResult {
  evicted: string[];
  failed: string[];
}

/** Unseed each repo and remove it from storage. Failures leave the repo
 * stored (and retried next cycle) — never delete while the policy that
 * would re-fetch it might still be active. */
export async function evictRepos(
  radBin: string,
  radHome: string,
  rids: string[],
): Promise<EvictResult> {
  const result: EvictResult = { evicted: [], failed: [] };
  for (let i = 0; i < rids.length; i += UNSEED_CHUNK) {
    const chunk = rids.slice(i, i + UNSEED_CHUNK);
    let unseeded: string[];
    try {
      await execRad(radBin, radHome, ["unseed", ...chunk], 120_000);
      unseeded = chunk;
    } catch {
      // Retry one by one so a single bad RID doesn't block the chunk.
      unseeded = [];
      for (const rid of chunk) {
        try {
          await execRad(radBin, radHome, ["unseed", rid], 30_000);
          unseeded.push(rid);
        } catch (err) {
          result.failed.push(rid);
          console.warn(
            `[evict] ${rid}: ${(err as Error).message?.split("\n")[0]}`,
          );
        }
      }
    }
    for (const rid of unseeded) {
      await rm(join(radHome, "storage", rid.replace(/^rad:/, "")), {
        recursive: true,
        force: true,
      });
      result.evicted.push(rid);
    }
  }
  return result;
}

/**
 * Remove `storage/<rid>.tmp` leftovers from aborted pack fetches (the node
 * leaves them behind and they eat disk). Only entries older than maxAgeMs —
 * a young .tmp may be an in-flight fetch.
 */
export async function pruneTmpDirs(
  radHome: string,
  maxAgeMs = 24 * 3600 * 1000,
  now = Date.now(),
): Promise<string[]> {
  const storageDir = join(radHome, "storage");
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(storageDir);
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".tmp")) continue;
    const path = join(storageDir, entry);
    try {
      const info = await stat(path);
      if (now - info.mtimeMs < maxAgeMs) continue;
      await rm(path, { recursive: true, force: true });
      removed.push(entry);
    } catch {
      // racing the node — skip
    }
  }
  return removed;
}
