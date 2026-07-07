import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverFromGossip, discoverAliases } from '../src/discover.ts';

function makeRadHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'radhome-'));
  mkdirSync(join(home, 'node'), { recursive: true });
  const db = new DatabaseSync(join(home, 'node', 'node.db'));
  db.exec(`
    CREATE TABLE routing (repo TEXT, node TEXT);
    CREATE TABLE nodes (id TEXT, alias TEXT);
    INSERT INTO routing VALUES
      ('rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5', 'n1'),
      ('rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5', 'n2'),
      ('rad:z4V1sjrXqjvFdnCUbxPFqd5p4DtH5', 'n1'),
      ('not-a-rid', 'n1');
    INSERT INTO nodes VALUES ('z6MkA', 'alice'), ('z6MkB', ''), ('z6MkC', NULL);
  `);
  db.close();
  return home;
}

test('discoverFromGossip counts seeders, filters invalid RIDs, sorts desc', () => {
  const repos = discoverFromGossip(makeRadHome());
  assert.deepEqual(repos, [
    { rid: 'rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5', seeders: 2 },
    { rid: 'rad:z4V1sjrXqjvFdnCUbxPFqd5p4DtH5', seeders: 1 },
  ]);
});

test('discoverAliases skips empty and null aliases', () => {
  const aliases = discoverAliases(makeRadHome());
  assert.deepEqual([...aliases.entries()], [['z6MkA', 'alice']]);
});
