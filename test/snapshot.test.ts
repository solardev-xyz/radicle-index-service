import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyMessage } from "ethers";
import {
  writeSnapshot,
  writeManifest,
  signManifest,
  canonicalManifestForSigning,
  SCHEMA,
} from "../src/snapshot.ts";

const KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const SIGNER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

const repo = {
  rid: "rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5",
  name: "heartwood",
  description: "d",
  defaultBranch: "master",
  head: "a".repeat(40),
  delegates: ["did:key:z6MkA"],
  threshold: 1,
  seeders: 5,
  issues: { open: 1, closed: 2 },
  patches: { open: 0, draft: 0, merged: 3, archived: 0 },
  lastActivity: 111,
};

test("writeSnapshot emits shards and a schema-correct manifest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "idx-"));
  const manifest = await writeSnapshot(dir, {
    repos: [repo, { ...repo, rid: "rad:zother", lastActivity: 999 }],
    users: [
      {
        did: "did:key:z6MkA",
        alias: null,
        maintains: [repo.rid],
        issues: 0,
        patches: 0,
      },
    ],
    knownRepos: 6528,
    signer: SIGNER,
    indexerName: "test",
    now: 42,
  });

  assert.equal(manifest.schema, SCHEMA);
  assert.equal(manifest.generatedAt, 42);
  assert.equal(manifest.network.indexedRepos, 2);
  assert.equal(manifest.network.knownRepos, 6528);
  assert.deepEqual(manifest.shards.repos, ["repos.json"]);

  const repos = JSON.parse(await readFile(join(dir, "repos.json"), "utf8"));
  assert.equal(repos[0].rid, "rad:zother"); // sorted by lastActivity desc
});

test("signManifest produces a verifiable EIP-191 signature", async () => {
  const dir = mkdtempSync(join(tmpdir(), "idx-"));
  const unsigned = await writeSnapshot(dir, {
    repos: [repo],
    users: [],
    knownRepos: 1,
    signer: SIGNER,
    indexerName: "test",
    now: 42,
  });
  const signed = await signManifest(unsigned, KEY);
  assert.notEqual(signed.sig, "");
  assert.equal(
    verifyMessage(canonicalManifestForSigning(signed), signed.sig),
    SIGNER,
  );
  await writeManifest(dir, signed);
  const onDisk = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
  assert.equal(onDisk.sig, signed.sig);
});
