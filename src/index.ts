/**
 * radicle-index-service — daemon entry point.
 *
 * Cycle: discover (gossip + stored) → fetch new repos (bounded) → extract
 * all stored repos → snapshot → sign → upload to Swarm → update feed.
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
import { fetchNewRepos, loadState, saveState } from "./fetch.ts";
import {
  loadRecordCache,
  saveRecordCache,
  canReuse,
  toScan,
  fromScan,
} from "./cache.ts";
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

  // Expand the crawl.
  const state = await loadState(config.stateFile);
  const candidates = gossip
    .map((repo) => repo.rid)
    .filter((rid) => !stored.has(rid));
  const fetched = await fetchNewRepos(
    config.radBin,
    config.radHome,
    candidates,
    state,
    {
      limit: config.fetchPerCycle,
      diskFloorGb: config.diskFloorGb,
    },
  );
  await saveState(config.stateFile, state);
  if (fetched.fetched.length) {
    console.log(`[fetch] seeded ${fetched.fetched.length} new repos`);
    for (const rid of await discoverStored(config.httpdUrl)) stored.add(rid);
  }

  // Extract incrementally: only repos whose refs moved since last time
  // (per gossip announcements), everything else from the record cache.
  const announcements = discoverRefsAnnouncements(config.radHome);
  const cache = await loadRecordCache(config.cacheFile);
  const fullSweepMs = config.fullSweepHours * 3600 * 1000;
  const now = Date.now();
  const scans: RepoScan[] = [];
  let reused = 0;
  for (const rid of stored) {
    const announceTs = announcements.get(rid) ?? 0;
    const cached = cache[rid];
    if (canReuse(cached, announceTs, now, fullSweepMs)) {
      scans.push(toScan(cached));
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
    } catch (err) {
      console.warn(`[extract] ${rid}: ${(err as Error).message}`);
    }
  }
  await saveRecordCache(config.cacheFile, cache);
  console.log(
    `[extract] ${scans.length}/${stored.size} repos (${scans.length - reused} extracted, ${reused} from cache)`,
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
    return;
  }

  // Publish.
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
