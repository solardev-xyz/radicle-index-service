import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canReuse,
  fromScan,
  toScan,
  loadRecordCache,
  saveRecordCache,
} from "../src/cache.ts";
import type { RepoScan } from "../src/extract.ts";

const scan: RepoScan = {
  record: {
    rid: "rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5",
    name: "heartwood",
    description: "",
    defaultBranch: "master",
    head: null,
    delegates: [],
    threshold: 1,
    seeders: 1,
    issues: { open: 0, closed: 0 },
    patches: { open: 0, draft: 0, merged: 0, archived: 0 },
    lastActivity: 0,
  },
  authors: new Map([["did:key:zA", { alias: "a", issues: 2, patches: 1 }]]),
};

const HOUR = 3600 * 1000;

test("canReuse: fresh cache with no newer announcement", () => {
  const cached = fromScan(scan, 1000, 5000);
  assert.equal(canReuse(cached, 1000, 6000, 24 * HOUR), true); // same announcement
  assert.equal(canReuse(cached, 900, 6000, 24 * HOUR), true); // older announcement
  assert.equal(canReuse(cached, 2000, 6000, 24 * HOUR), false); // refs moved
  assert.equal(canReuse(cached, 1000, 5000 + 25 * HOUR, 24 * HOUR), false); // sweep due
  assert.equal(canReuse(undefined, 0, 0, 24 * HOUR), false); // no cache
});

test("cache round-trips through disk, preserving the authors map", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "cache-")), "records.json");
  await saveRecordCache(file, { [scan.record.rid]: fromScan(scan, 7, 8) });
  const loaded = await loadRecordCache(file);
  const restored = toScan(loaded[scan.record.rid]);
  assert.equal(restored.record.name, "heartwood");
  assert.deepEqual(restored.authors.get("did:key:zA"), {
    alias: "a",
    issues: 2,
    patches: 1,
  });
});
