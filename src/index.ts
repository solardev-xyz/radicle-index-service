/**
 * radicle-index-service — daemon entry point.
 *
 * Cycle: discover (gossip + stored) → extract stored repos (incremental,
 * evicted repos come from the record cache) → snapshot → sign → upload to
 * Swarm → update feed → evict extracted repos from storage → fetch
 * stale/new repos (bounded).
 *
 * Flags: --once (single cycle), --dry-run (build snapshot, skip Swarm).
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import {
  discoverFromGossip,
  discoverAliases,
  discoverStored,
  discoverRefsAnnouncements,
} from "./discover.ts";
import { extractRepo, buildUsers, type RepoScan } from "./extract.ts";
import {
  fetchNewRepos,
  loadState,
  saveState,
  selectFetchCandidates,
} from "./fetch.ts";
import {
  loadRecordCache,
  saveRecordCache,
  canReuse,
  toScan,
  fromScan,
  foldEvictedRecords,
} from "./cache.ts";
import { evictRepos, pruneTmpDirs } from "./evict.ts";
import { writeSnapshot, writeManifest, signManifest } from "./snapshot.ts";
import { createPublisher, FEED_TOPIC } from "./swarm.ts";
import { Wallet } from "ethers";

const args = new Set(process.argv.slice(2));
const once = args.has("--once");
const dryRun = args.has("--dry-run");

const config = loadConfig();
const INDEXER_NAME = process.env.INDEXER_NAME ?? "radicle-index";

async function cycle(): Promise<void> {
  const startedAt = Date.now();

  // Discover.
  const gossip = discoverFromGossip(config.radHome);
  const seederCounts = new Map(gossip.map((repo) => [repo.rid, repo.seeders]));
  const aliases = discoverAliases(config.radHome);
  const stored = new Set(await discoverStored(config.httpdUrl));
  console.log(
    `[discover] gossip knows ${gossip.length} repos; ${stored.size} stored locally`,
  );

  const state = await loadState(config.stateFile);

  // Extract incrementally: only repos whose refs moved since last time
  // (per gossip announcements), everything else from the record cache.
  const announcements = discoverRefsAnnouncements(config.radHome);
  const cache = await loadRecordCache(config.cacheFile);
  const fullSweepMs = config.fullSweepHours * 3600 * 1000;
  const now = Date.now();
  const scans: RepoScan[] = [];
  // Stored repos whose record made it into this snapshot — the only ones
  // that may safely leave storage afterwards.
  const snapshottedStored: string[] = [];
  let reused = 0;
  for (const rid of stored) {
    const announceTs = announcements.get(rid) ?? 0;
    const cached = cache[rid];
    if (canReuse(cached, announceTs, now, fullSweepMs)) {
      scans.push(toScan(cached));
      snapshottedStored.push(rid);
      reused++;
      continue;
    }
    try {
      const scan = await extractRepo(
        config.httpdUrl,
        rid,
        seederCounts.get(rid) ?? 0,
      );
      cache[rid] = fromScan(scan, announceTs, now);
      scans.push(scan);
      snapshottedStored.push(rid);
    } catch (err) {
      console.warn(`[extract] ${rid}: ${(err as Error).message}`);
    }
  }
  const extracted = scans.length - reused;

  // Repos evicted from storage after earlier extractions stay in the index
  // via their cached records, as long as gossip still knows them.
  const evictedRecords = foldEvictedRecords(cache, stored, seederCounts);
  scans.push(...evictedRecords.scans);
  await saveRecordCache(config.cacheFile, cache);
  console.log(
    `[extract] ${stored.size} stored (${extracted} extracted, ${reused} from cache) + ${evictedRecords.scans.length} evicted records` +
      (evictedRecords.pruned
        ? `; pruned ${evictedRecords.pruned} gone from gossip`
        : ""),
  );

  // Seeder counts change without refs moving — refresh them on cached
  // records so the published numbers stay current.
  for (const scan of scans) {
    scan.record.seeders =
      seederCounts.get(scan.record.rid) ?? scan.record.seeders;
  }

  // Snapshot.
  const signerAddress = config.signerKey
    ? new Wallet(config.signerKey).address
    : "0x" + "0".repeat(40);
  let manifest = await writeSnapshot(config.outDir, {
    repos: scans.map((scan) => scan.record),
    users: buildUsers(scans, aliases),
    knownRepos: gossip.length,
    signer: signerAddress,
    indexerName: INDEXER_NAME,
  });

  if (config.signerKey) {
    manifest = await signManifest(manifest, config.signerKey);
  }
  await writeManifest(config.outDir, manifest);
  console.log(
    `[snapshot] ${manifest.network.indexedRepos} repos, ${manifest.network.users} users → ${config.outDir}`,
  );

  if (dryRun) {
    console.log("[publish] dry run — skipping Swarm");
    return;
  }
  if (!config.signerKey) {
    throw new Error(
      "FEED_SIGNER_KEY is required to publish (use --dry-run without it)",
    );
  }

  // Publish only when the shards actually changed (manifest excluded —
  // its generatedAt moves every cycle by design).
  const shardHash = createHash("sha256");
  for (const shard of [...manifest.shards.repos, ...manifest.shards.users]) {
    shardHash.update(await readFile(join(config.outDir, shard)));
  }
  const contentHash = shardHash.digest("hex");
  if (contentHash === state.lastPublishedHash) {
    console.log("[publish] shards unchanged since last publish — skipping");
  } else {
    const publisher = await createPublisher(
      config.beeUrl,
      config.signerKey,
      config.batchId,
    );
    const snapshotRef = await publisher.uploadSnapshot(config.outDir);
    await publisher.updateFeed(snapshotRef);
    const feedManifest = await publisher.feedManifest();
    console.log(`[publish] snapshot bzz://${snapshotRef}`);
    console.log(
      `[publish] feed    bzz://${feedManifest} (topic "${FEED_TOPIC}", owner ${publisher.owner})`,
    );

    state.lastPublishedHash = contentHash;
    await saveState(config.stateFile, state);

    const ttl = await publisher.batchTtl();
    if (ttl !== null && ttl < 30 * 24 * 3600) {
      console.warn(
        `[stamp] batch TTL below 30d (${Math.round(ttl / 86400)}d) — top up soon`,
      );
    }
  }

  console.log(
    `[publish+extract] done in ${Math.round((Date.now() - startedAt) / 1000)}s — evicting + crawling next`,
  );

  // Evict AFTER publishing: storage is only a working set, and freeing it
  // now makes room for the crawl. Only repos whose records are safely
  // cached are removed; failures stay stored and retry next cycle.
  if (config.evictAfterExtract) {
    // Bounded per cycle: a large backlog (first rollout, or after downtime)
    // is drained over several cycles instead of one host-starving delete.
    const evictNow = snapshottedStored.slice(0, config.evictPerCycle);
    if (evictNow.length) {
      const evicted = await evictRepos(config.radBin, config.radHome, evictNow);
      console.log(
        `[evict] removed ${evicted.evicted.length} repos from storage` +
          (evicted.failed.length ? `, ${evicted.failed.length} failed` : "") +
          (snapshottedStored.length > evictNow.length
            ? `; ${snapshottedStored.length - evictNow.length} deferred to next cycle`
            : ""),
      );
    }
    const tmp = await pruneTmpDirs(config.radHome);
    if (tmp.length) {
      console.log(`[evict] pruned ${tmp.length} stale .tmp fetch leftovers`);
    }
  }

  // Crawl AFTER publishing: freshness of what we have beats breadth of
  // what we might get. Newly seeded repos enter the next snapshot.
  const candidates = selectFetchCandidates(
    gossip,
    stored,
    cache,
    announcements,
    now,
    config.refreshDays * 24 * 3600 * 1000,
  );
  const fetched = await fetchNewRepos(
    config.radBin,
    config.radHome,
    candidates,
    state,
    {
      limit: config.fetchPerCycle,
      diskFloorGb: config.diskFloorGb,
      budgetMs: config.fetchBudgetMinutes * 60 * 1000,
    },
  );
  await saveState(config.stateFile, state);
  if (fetched.fetched.length) {
    console.log(
      `[fetch] seeded ${fetched.fetched.length} new repos for the next snapshot`,
    );
  }

  console.log(
    `[cycle] done in ${Math.round((Date.now() - startedAt) / 1000)}s`,
  );
}

async function main(): Promise<void> {
  do {
    try {
      await cycle();
    } catch (err) {
      console.error(`[cycle] failed: ${(err as Error).message}`);
      if (once) process.exit(1);
    }
    if (!once) {
      await new Promise((resolve) =>
        setTimeout(resolve, config.intervalMinutes * 60 * 1000),
      );
    }
  } while (!once);
}

main();
