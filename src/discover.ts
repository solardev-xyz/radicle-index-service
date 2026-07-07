/**
 * RID discovery.
 *
 * Two sources, both local:
 *  - the node's gossip routing table (node.db) — the network-wide repo
 *    inventory the node has passively learned (RID → seeder count)
 *  - the local httpd — repos actually stored on this node (indexable now)
 */

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const RID_RE = /^rad:z[1-9A-HJ-NP-Za-km-z]{20,60}$/;

export interface NetworkRepo {
  rid: string;
  seeders: number;
}

/** All RIDs known via gossip, most-seeded first (a natural crawl priority). */
export function discoverFromGossip(radHome: string): NetworkRepo[] {
  const db = new DatabaseSync(join(radHome, 'node', 'node.db'), { readOnly: true });
  try {
    const rows = db
      .prepare('SELECT repo, COUNT(*) AS seeders FROM routing GROUP BY repo ORDER BY seeders DESC')
      .all() as Array<{ repo: string; seeders: number }>;
    return rows
      .map((row) => ({ rid: String(row.repo), seeders: Number(row.seeders) }))
      .filter((row) => RID_RE.test(row.rid));
  } finally {
    db.close();
  }
}

/** Aliases the node has learned from gossip announcements: nid → alias. */
export function discoverAliases(radHome: string): Map<string, string> {
  const db = new DatabaseSync(join(radHome, 'node', 'node.db'), { readOnly: true });
  try {
    const rows = db
      .prepare("SELECT id, alias FROM nodes WHERE alias IS NOT NULL AND alias != ''")
      .all() as Array<{ id: string; alias: string }>;
    return new Map(rows.map((row) => [String(row.id), String(row.alias)]));
  } finally {
    db.close();
  }
}

/** RIDs stored locally (fully indexable), via the local httpd. */
export async function discoverStored(httpdUrl: string): Promise<string[]> {
  const rids: string[] = [];
  for (let page = 0; ; page++) {
    const res = await fetch(`${httpdUrl}/api/v1/repos?show=all&perPage=100&page=${page}`);
    if (!res.ok) throw new Error(`httpd repo listing failed: ${res.status}`);
    const repos = (await res.json()) as Array<{ rid: string }>;
    rids.push(...repos.map((r) => r.rid).filter((rid) => RID_RE.test(rid)));
    if (repos.length < 100) break;
  }
  return rids;
}
