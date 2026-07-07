/**
 * Record cache — incremental extraction's memory.
 *
 * Extraction is the expensive step (6 COB listings per repo), so each
 * repo's extracted scan is cached with the refs-announcement timestamp it
 * was extracted at. A repo is re-extracted only when gossip says its refs
 * moved, or when the full-sweep interval elapses (safety net for changes
 * the node absorbed while offline).
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { RepoScan } from "./extract.ts";

export interface CachedScan {
  record: RepoScan["record"];
  /** Map serialized as entries. */
  authors: Array<
    [string, { alias: string | null; issues: number; patches: number }]
  >;
  announceTs: number;
  extractedAt: number;
}

export type RecordCache = Record<string, CachedScan>;

export async function loadRecordCache(file: string): Promise<RecordCache> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as RecordCache;
  } catch {
    return {};
  }
}

export async function saveRecordCache(
  file: string,
  cache: RecordCache,
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(cache));
}

export function toScan(cached: CachedScan): RepoScan {
  return { record: cached.record, authors: new Map(cached.authors) };
}

export function fromScan(
  scan: RepoScan,
  announceTs: number,
  now: number,
): CachedScan {
  return {
    record: scan.record,
    authors: [...scan.authors.entries()],
    announceTs,
    extractedAt: now,
  };
}

/**
 * Reuse the cached scan when gossip hasn't announced newer refs and the
 * full-sweep deadline hasn't passed.
 */
export function canReuse(
  cached: CachedScan | undefined,
  announceTs: number,
  now: number,
  fullSweepMs: number,
): cached is CachedScan {
  if (!cached) return false;
  if (announceTs > cached.announceTs) return false;
  return now - cached.extractedAt < fullSweepMs;
}
