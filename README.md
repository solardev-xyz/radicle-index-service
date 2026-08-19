# radicle-index-service

Indexes the Radicle network from a local node's view and publishes a
signed, user-selectable index to Swarm — the global-discovery layer for
[canopy](https://github.com/solardev-xyz/canopy). Anyone can run one;
clients choose which indexer feeds they trust.

**The index decides what you see; your node decides what's true.** See
[docs/index-protocol.md](docs/index-protocol.md) for the schema and trust
model.

## How it works

Each cycle:
1. **Discover** — RID inventory from the local radicle-node's gossip
   routing table (thousands of repos learned passively), aliases from node
   announcements.
2. **Extract** — repo metadata + issue/patch counts + per-DID contribution
   tallies from the local radicle-httpd. Incremental: repos re-extract only
   when gossip announces newer refs; everything else comes from the record
   cache — including repos already evicted from storage.
3. **Publish** — write shards + EIP-191-signed manifest, upload as a Swarm
   collection, point the `radicle-index/v1` feed at it. Clients fetch
   `bzz://<feedManifest>/manifest.json`.
4. **Evict** — remove extracted repos from node storage (`rad unseed` +
   delete). Storage is a working set, not an archive: a repo only needs to
   be on disk long enough to index it, and its record survives in the
   cache until the network forgets the repo. Bounded (`EVICT_PER_CYCLE`,
   default 300) and paced — an unbounded backlog delete can starve the
   whole host. Kill switch: `EVICT_AFTER_EXTRACT=false`.
5. **Crawl** — fetch repos whose refs moved since extraction, then
   never-indexed repos (most-seeded first), then records older than
   `REFRESH_DAYS`; bounded per cycle (`FETCH_PER_CYCLE`) and by a disk
   floor (`DISK_FLOOR_GB`); unreachable repos back off exponentially.

## Run locally

Requires a radicle-node + httpd (e.g. canopy's `npm run dev:node`) and,
for publishing, a Bee node with a **mutable** postage batch.

```bash
npm install
RAD_HOME=…/canopy/.dev/rad RADICLE_HTTPD_URL=http://127.0.0.1:8788 npm run dry   # no Swarm
FEED_SIGNER_KEY=0x… BEE_API_URL=http://127.0.0.1:1633 npm run once               # one publish
npm start                                                                        # daemon
```

Config is env-only — see `src/config.ts` for the full list and defaults.

## Deploy

`Dockerfile` bundles radicle-node + radicle-httpd + the worker
(`bin/entrypoint.sh`); mount a volume at `/data` for the node identity and
storage. Ops notes live in the swarmit-coolify repo. Operational rules
learned the hard way:

- the postage batch **must** be mutable (feed SOC rewrites),
- the feed signer key is the identity clients pin — durable, backed up,
  never funded.
