/**
 * Swarm publishing over bee-js — the adblock-service pattern: a feed owned
 * by the signer key whose entries point at the latest snapshot collection.
 * The stable client entry point is the feed manifest reference
 * (bzz://<feedManifest>/manifest.json resolves to the newest snapshot).
 */

import { Bee, PrivateKey, Topic } from "@ethersphere/bee-js";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export const FEED_TOPIC = "radicle-index/v1";

export interface SwarmPublisher {
  owner: string;
  /** Stable feed manifest reference — the address clients configure. */
  feedManifest(): Promise<string>;
  /** Upload the snapshot dir as a collection; returns its reference. */
  uploadSnapshot(dir: string): Promise<string>;
  /** Point the feed at a new snapshot reference. */
  updateFeed(snapshotRef: string): Promise<void>;
  /** TTL of the batch in seconds, or null when unknown. */
  batchTtl(): Promise<number | null>;
}

function toHex(value: unknown): string {
  const maybe = value as { toHex?: () => string };
  return typeof maybe?.toHex === "function" ? maybe.toHex() : String(value);
}

async function selectBatch(bee: Bee): Promise<string | null> {
  const batches = await bee.getPostageBatches();
  let best: string | null = null;
  let bestTtl = -1;
  for (const batch of batches) {
    if (!batch.usable) continue;
    const ttl =
      batch.duration && typeof batch.duration.toSeconds === "function"
        ? batch.duration.toSeconds()
        : 0;
    if (ttl > bestTtl) {
      best = toHex(batch.batchID);
      bestTtl = ttl;
    }
  }
  return best;
}

export async function createPublisher(
  beeUrl: string,
  signerKey: string,
  configuredBatch: string | null,
): Promise<SwarmPublisher> {
  const bee = new Bee(beeUrl);
  const signer = new PrivateKey(signerKey);
  const owner = signer.publicKey().address();
  const topic = Topic.fromString(FEED_TOPIC);
  const writer = bee.makeFeedWriter(topic, signer);

  const batchId = configuredBatch ?? (await selectBatch(bee));
  if (!batchId) {
    throw new Error(
      "No usable postage batch on the bee node — buy one (mutable!) first.",
    );
  }

  return {
    owner: owner.toString(),

    async feedManifest() {
      const ref = await bee.createFeedManifest(batchId, topic, owner);
      return toHex(ref);
    },

    async uploadSnapshot(dir: string) {
      const names = await readdir(dir);
      const files = await Promise.all(
        names.map(async (name) => {
          const data = await readFile(join(dir, name));
          return new File([data], name, { type: "application/json" });
        }),
      );
      const result = await bee.uploadFiles(batchId, files, {
        indexDocument: "manifest.json",
        pin: true,
      });
      return toHex(result.reference);
    },

    async updateFeed(snapshotRef: string) {
      await writer.uploadReference(batchId, snapshotRef);
    },

    async batchTtl() {
      try {
        const batch = await bee.getPostageBatch(batchId);
        return batch.duration && typeof batch.duration.toSeconds === "function"
          ? batch.duration.toSeconds()
          : null;
      } catch {
        return null;
      }
    },
  };
}
