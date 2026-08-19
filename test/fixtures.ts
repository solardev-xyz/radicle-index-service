import type { RepoScan } from "../src/extract.ts";

/** Minimal RepoScan for a RID — the one place tests declare the shape. */
export const scanFor = (
  rid: string,
  authors: RepoScan["authors"] = new Map(),
): RepoScan => ({
  record: {
    rid,
    name: rid,
    description: "",
    defaultBranch: "main",
    head: null,
    delegates: [],
    threshold: 1,
    seeders: 1,
    issues: { open: 0, closed: 0 },
    patches: { open: 0, draft: 0, merged: 0, archived: 0 },
    lastActivity: 0,
  },
  authors,
});
