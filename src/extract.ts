/**
 * Per-repo metadata extraction from the local radicle-httpd — the same JSON
 * surface canopy reads, reduced to index records.
 */

export interface RepoRecord {
  rid: string;
  name: string;
  description: string;
  defaultBranch: string;
  head: string | null;
  delegates: string[];
  threshold: number;
  /** Network seeder count from gossip (0 when unknown). */
  seeders: number;
  issues: { open: number; closed: number };
  patches: { open: number; draft: number; merged: number; archived: number };
  /** Unix ms of the newest COB activity we saw (0 when none). */
  lastActivity: number;
}

export interface UserRecord {
  did: string;
  alias: string | null;
  maintains: string[];
  issues: number;
  patches: number;
}

interface CobItem {
  author?: { id?: string; alias?: string };
  discussion?: Array<{ timestamp?: number }>;
  revisions?: Array<{ timestamp?: number }>;
}

const PER_PAGE = 500;

async function fetchAll(httpdUrl: string, rid: string, path: string): Promise<CobItem[]> {
  const out: CobItem[] = [];
  for (let page = 0; ; page++) {
    const res = await fetch(
      `${httpdUrl}/api/v1/repos/${rid}/${path}&perPage=${PER_PAGE}&page=${page}`
    );
    if (!res.ok) return out;
    const items = (await res.json()) as CobItem[];
    out.push(...items);
    if (items.length < PER_PAGE) break;
  }
  return out;
}

const timestampOf = (item: CobItem): number => {
  const ts = item.discussion?.[0]?.timestamp ?? item.revisions?.[0]?.timestamp ?? 0;
  return ts > 1e12 ? ts : ts * 1000;
};

export interface RepoScan {
  record: RepoRecord;
  /** did → {alias?, issues, patches} contributions found in this repo. */
  authors: Map<string, { alias: string | null; issues: number; patches: number }>;
}

/** Extract one stored repo. Throws when the repo isn't available. */
export async function extractRepo(
  httpdUrl: string,
  rid: string,
  seeders: number
): Promise<RepoScan> {
  const res = await fetch(`${httpdUrl}/api/v1/repos/${rid}`);
  if (!res.ok) throw new Error(`repo ${rid}: ${res.status}`);
  const raw = (await res.json()) as {
    rid: string;
    payloads?: Record<string, { data?: Record<string, unknown>; meta?: { head?: string } }>;
    delegates?: Array<string | { id: string }>;
    threshold?: number;
  };
  const project = raw.payloads?.['xyz.radicle.project'] ?? {};
  const data = (project.data ?? {}) as Record<string, unknown>;

  const [issuesOpen, issuesClosed, patchesOpen, patchesDraft, patchesMerged, patchesArchived] =
    await Promise.all([
      fetchAll(httpdUrl, rid, 'issues?status=open'),
      fetchAll(httpdUrl, rid, 'issues?status=closed'),
      fetchAll(httpdUrl, rid, 'patches?status=open'),
      fetchAll(httpdUrl, rid, 'patches?status=draft'),
      fetchAll(httpdUrl, rid, 'patches?status=merged'),
      fetchAll(httpdUrl, rid, 'patches?status=archived'),
    ]);

  const authors = new Map<string, { alias: string | null; issues: number; patches: number }>();
  const tally = (items: CobItem[], kind: 'issues' | 'patches') => {
    for (const item of items) {
      const did = item.author?.id;
      if (!did) continue;
      const entry = authors.get(did) ?? { alias: null, issues: 0, patches: 0 };
      entry[kind]++;
      if (item.author?.alias) entry.alias = item.author.alias;
      authors.set(did, entry);
    }
  };
  tally([...issuesOpen, ...issuesClosed], 'issues');
  tally([...patchesOpen, ...patchesDraft, ...patchesMerged, ...patchesArchived], 'patches');

  const allCobs = [
    ...issuesOpen,
    ...issuesClosed,
    ...patchesOpen,
    ...patchesDraft,
    ...patchesMerged,
    ...patchesArchived,
  ];
  const lastActivity = allCobs.reduce((max, item) => Math.max(max, timestampOf(item)), 0);

  return {
    record: {
      rid: raw.rid,
      name: String(data.name ?? raw.rid),
      description: String(data.description ?? ''),
      defaultBranch: String(data.defaultBranch ?? 'main'),
      head: project.meta?.head ?? null,
      delegates: (raw.delegates ?? []).map((d) => (typeof d === 'string' ? d : d.id)),
      threshold: raw.threshold ?? 1,
      seeders,
      issues: { open: issuesOpen.length, closed: issuesClosed.length },
      patches: {
        open: patchesOpen.length,
        draft: patchesDraft.length,
        merged: patchesMerged.length,
        archived: patchesArchived.length,
      },
      lastActivity,
    },
    authors,
  };
}

/** Fold per-repo scans into the global user table. */
export function buildUsers(scans: RepoScan[], gossipAliases: Map<string, string>): UserRecord[] {
  const users = new Map<string, UserRecord>();
  const ensure = (did: string): UserRecord => {
    let user = users.get(did);
    if (!user) {
      const nid = did.replace(/^did:key:/, '');
      user = { did, alias: gossipAliases.get(nid) ?? null, maintains: [], issues: 0, patches: 0 };
      users.set(did, user);
    }
    return user;
  };

  for (const scan of scans) {
    for (const did of scan.record.delegates) {
      ensure(did).maintains.push(scan.record.rid);
    }
    for (const [did, contrib] of scan.authors) {
      const user = ensure(did);
      user.issues += contrib.issues;
      user.patches += contrib.patches;
      if (contrib.alias && !user.alias) user.alias = contrib.alias;
    }
  }

  return [...users.values()].sort(
    (a, b) => b.maintains.length + b.issues + b.patches - (a.maintains.length + a.issues + a.patches)
  );
}
