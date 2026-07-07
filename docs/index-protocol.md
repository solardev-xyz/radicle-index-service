# Radicle Index Protocol — `radicle-index/1`

A convention for publishing a **view of the Radicle network** as static,
client-queryable artifacts on Swarm. Anyone can run an indexer; clients
(canopy) choose which indexer feeds they trust — the swarmit curator model
applied to code-forge discovery.

**Trust rule:** the index decides what you *see*; your node decides what's
*true*. An index can omit or go stale, but it cannot forge — clients treat
it as discovery hints and fetch all real content (code, issues, delegates)
from their own Radicle node, which verifies cryptographically.

## Publication

- The indexer owns a Swarm **feed** at topic `radicle-index/v1`, signed by
  its feed key. Clients configure the feed-manifest reference
  (`bzz://<feedManifest>/…` always resolves to the newest snapshot).
- Each snapshot is one immutable Swarm collection; the feed points at it.
- The postage batch MUST be mutable (feed SOC rewrites).

## Snapshot layout

```
manifest.json    # this contract; signed
repos.json       # shard(s) listed in manifest.shards.repos
users.json       # shard(s) listed in manifest.shards.users
```

### manifest.json

```jsonc
{
  "schema": "radicle-index/1",
  "generatedAt": 1783416203649,          // unix ms
  "indexer": {
    "signer": "0xc135…",                 // address clients pin
    "name": "freedom-radicle-index"
  },
  "network": {
    "knownRepos": 6528,                  // gossip inventory size
    "indexedRepos": 8,                   // fully indexed in this snapshot
    "users": 166
  },
  "shards": { "repos": ["repos.json"], "users": ["users.json"] },
  "sig": "0x…"                           // EIP-191 over manifest with sig=""
}
```

Readers verify `sig` with `verifyMessage(JSON.stringify({...manifest,
sig: ''}), sig) === indexer.signer`. Readers MUST iterate `shards.*` rather
than assuming single files — future versions shard without a schema bump.

### repos.json — array sorted by lastActivity desc

```jsonc
{
  "rid": "rad:z3gq…",
  "name": "heartwood",
  "description": "…",
  "defaultBranch": "master",
  "head": "ee171…",                       // 40-hex or null
  "delegates": ["did:key:z6Mk…"],
  "threshold": 1,
  "seeders": 22,                          // gossip seeder count (0 unknown)
  "issues": { "open": 28, "closed": 54 },
  "patches": { "open": 15, "draft": 2, "merged": 220, "archived": 30 },
  "lastActivity": 1783300000000           // newest COB, unix ms (0 none)
}
```

### users.json — array sorted by activity desc

```jsonc
{
  "did": "did:key:z6Mk…",
  "alias": "cloudhead",                   // gossip/COB resolved, or null
  "maintains": ["rad:z3gq…"],             // delegate of
  "issues": 73,                           // authored, across indexed repos
  "patches": 227
}
```

## Semantics

- Counts and activity cover **indexed repos only** — an index is explicit
  about its coverage via `network.indexedRepos` vs `network.knownRepos`.
- `knownRepos` comes from the indexer node's gossip routing table: the
  repos the network *announces*, indexable as the crawl expands.
- Clients MAY union multiple indexes; on conflict for the same `rid`, the
  newer `generatedAt` wins.

## Versioning

`schema` is bumped only for breaking changes. Additive fields may appear
at any time; readers MUST ignore unknown fields.
