/**
 * Snapshot assembly: the static, client-queryable artifacts canopy fetches
 * from Swarm. See docs/index-protocol.md for the schema contract.
 *
 * v1 keeps sharding trivial (one repos shard, one users shard) — at ~7k
 * network repos both stay in the low megabytes. The manifest carries the
 * shard list so future sharding is a additive change for readers.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Wallet } from 'ethers';
import type { RepoRecord, UserRecord } from './extract.ts';

export const SCHEMA = 'radicle-index/1';

export interface IndexManifest {
  schema: typeof SCHEMA;
  generatedAt: number;
  indexer: {
    /** Feed owner / manifest signer address — what clients pin. */
    signer: string;
    name: string;
  };
  network: {
    /** RIDs known via gossip (the network inventory). */
    knownRepos: number;
    /** Repos stored + fully indexed in this snapshot. */
    indexedRepos: number;
    users: number;
  };
  shards: {
    repos: string[];
    users: string[];
  };
  /** EIP-191 signature over canonicalManifestForSigning(); '' until signed. */
  sig: string;
}

/** Canonical bytes for signing: the manifest JSON with `sig` emptied. */
export function canonicalManifestForSigning(manifest: IndexManifest): string {
  return JSON.stringify({ ...manifest, sig: '' });
}

export async function signManifest(
  manifest: IndexManifest,
  signerKey: string
): Promise<IndexManifest> {
  const wallet = new Wallet(signerKey);
  const sig = await wallet.signMessage(canonicalManifestForSigning(manifest));
  return { ...manifest, sig };
}

export interface SnapshotInput {
  repos: RepoRecord[];
  users: UserRecord[];
  knownRepos: number;
  signer: string;
  indexerName: string;
  now?: number;
}

/** Write the snapshot artifacts to outDir; returns the unsigned manifest. */
export async function writeSnapshot(outDir: string, input: SnapshotInput): Promise<IndexManifest> {
  await mkdir(outDir, { recursive: true });

  const repos = [...input.repos].sort((a, b) => b.lastActivity - a.lastActivity);
  await writeFile(join(outDir, 'repos.json'), JSON.stringify(repos));
  await writeFile(join(outDir, 'users.json'), JSON.stringify(input.users));

  const manifest: IndexManifest = {
    schema: SCHEMA,
    generatedAt: input.now ?? Date.now(),
    indexer: { signer: input.signer, name: input.indexerName },
    network: {
      knownRepos: input.knownRepos,
      indexedRepos: repos.length,
      users: input.users.length,
    },
    shards: { repos: ['repos.json'], users: ['users.json'] },
    sig: '',
  };
  return manifest;
}

/** Persist the (signed) manifest alongside the shards. */
export async function writeManifest(outDir: string, manifest: IndexManifest): Promise<void> {
  await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}
