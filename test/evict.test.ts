import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evictRepos, pruneTmpDirs } from "../src/evict.ts";
import { foldEvictedRecords, fromScan } from "../src/cache.ts";
import { selectFetchCandidates } from "../src/fetch.ts";
import { scanFor } from "./fixtures.ts";

const DAY = 24 * 3600 * 1000;

test("selectFetchCandidates: stale evicted, then new, then expired", () => {
  const gossip = [
    { rid: "rad:zStored", seeders: 9 },
    { rid: "rad:zStale", seeders: 8 },
    { rid: "rad:zNewBig", seeders: 7 },
    { rid: "rad:zCurrent", seeders: 6 },
    { rid: "rad:zExpired", seeders: 5 },
    { rid: "rad:zNewSmall", seeders: 4 },
  ];
  const now = 100 * DAY;
  const cache = {
    "rad:zStale": fromScan(scanFor("rad:zStale"), 1000, now - DAY),
    "rad:zCurrent": fromScan(scanFor("rad:zCurrent"), 1000, now - DAY),
    "rad:zExpired": fromScan(scanFor("rad:zExpired"), 1000, now - 8 * DAY),
  };
  const announcements = new Map([
    ["rad:zStale", 2000],
    ["rad:zCurrent", 500],
  ]);
  const candidates = selectFetchCandidates(
    gossip,
    new Set(["rad:zStored"]),
    cache,
    announcements,
    now,
    7 * DAY,
  );
  assert.deepEqual(candidates, [
    "rad:zStale", // refs moved since extraction
    "rad:zNewBig", // never indexed, gossip order kept
    "rad:zNewSmall",
    "rad:zExpired", // record outlived the refresh window
  ]);
});

test("foldEvictedRecords: keeps gossip-known records, prunes gone ones", () => {
  const cache = {
    "rad:zStored": fromScan(scanFor("rad:zStored"), 1, 2),
    "rad:zEvicted": fromScan(scanFor("rad:zEvicted"), 1, 2),
    "rad:zGone": fromScan(scanFor("rad:zGone"), 1, 2),
  };
  const { scans, pruned } = foldEvictedRecords(
    cache,
    new Set(["rad:zStored"]),
    new Set(["rad:zStored", "rad:zEvicted"]),
  );
  assert.deepEqual(
    scans.map((scan) => scan.record.rid),
    ["rad:zEvicted"], // stored one is extracted separately, gone one pruned
  );
  assert.equal(pruned, 1);
  assert.deepEqual(Object.keys(cache).sort(), ["rad:zEvicted", "rad:zStored"]);
});

test("evictRepos: unseeds and removes the storage directory", async () => {
  const radHome = mkdtempSync(join(tmpdir(), "evict-"));
  const repoDir = join(radHome, "storage", "zRepo123");
  mkdirSync(repoDir, { recursive: true });
  const result = await evictRepos("true", radHome, ["rad:zRepo123"]);
  assert.deepEqual(result, { evicted: ["rad:zRepo123"], failed: [] });
  assert.equal(existsSync(repoDir), false);
});

test("evictRepos: keeps storage when unseed fails", async () => {
  const radHome = mkdtempSync(join(tmpdir(), "evict-"));
  const repoDir = join(radHome, "storage", "zRepo123");
  mkdirSync(repoDir, { recursive: true });
  const result = await evictRepos("false", radHome, ["rad:zRepo123"]);
  assert.deepEqual(result, { evicted: [], failed: ["rad:zRepo123"] });
  assert.equal(existsSync(repoDir), true);
});

test("pruneTmpDirs: removes only stale .tmp entries", async () => {
  const radHome = mkdtempSync(join(tmpdir(), "evict-"));
  const storage = join(radHome, "storage");
  const stale = join(storage, "zOld.tmp");
  const young = join(storage, "zNew.tmp");
  const repo = join(storage, "zRepo");
  for (const dir of [stale, young, repo]) mkdirSync(dir, { recursive: true });
  const past = new Date(Date.now() - 2 * DAY);
  utimesSync(stale, past, past);
  const removed = await pruneTmpDirs(radHome, DAY);
  assert.deepEqual(removed, ["zOld.tmp"]);
  assert.equal(existsSync(young), true);
  assert.equal(existsSync(repo), true);
});
