// End-to-end: run the real CLI as a subprocess, the way a person would. Covers the wiring the unit
// tests cannot: config file -> loadConfig -> backend factory -> engine -> startup verification.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { defaultConfig } from '../src/config/config.ts';
import { PostgresBackend } from '../src/ledger/postgres.ts';

const dir = mkdtempSync(join(tmpdir(), 'heist-sim-'));
after(() => rmSync(dir, { recursive: true, force: true }));

// Same real-or-skip rule as the conformance suite (tests/conformance.test.ts): no mock postgres.
const CANDIDATE_PG_URL = process.env['TEST_DATABASE_URL'] ?? 'postgres://localhost/heist_engine_test';
let PG_URL: string | undefined;
try {
  const probe = new PostgresBackend(CANDIDATE_PG_URL);
  await probe.init();
  await probe.close();
  PG_URL = CANDIDATE_PG_URL;
} catch {
  PG_URL = undefined;
}

function sim(args: string[], input: string): { code: number | null; out: string } {
  const run = spawnSync(process.execPath, ['src/cli/sim.ts', ...args], { input, encoding: 'utf8' });
  return { code: run.status, out: `${run.stdout}${run.stderr}` };
}

function configFile(name: string, value: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value), 'utf8');
  return path;
}

describe('sim — config wiring', () => {
  test('with no flags it loads the checked-in config and a fresh world works end to end', () => {
    const { code, out } = sim([], 'seed\nfund hospital 100\nbuy alice hospital_full_heal\nverify\nexit\n');
    assert.equal(code, 0, out);
    assert.match(out, /backend memory/);
    assert.match(out, /Account opened\. 500 HD welcome grant/);
    assert.match(out, /Paid 200 HD to Pillbox Medical/);
    assert.match(out, /chain OK/);
  });

  test('--config really is read: a custom welcome grant and entity list show up', () => {
    const path = configFile('custom.json', {
      ...defaultConfig(),
      welcomeGrant: '123',
      entities: [...defaultConfig().entities, { id: 'pawn-shop', name: 'Fast Cash Pawn' }],
    });
    const { code, out } = sim([`--config=${path}`], 'join zed\nwallets\nexit\n');
    assert.equal(code, 0, out);
    assert.match(out, new RegExp(`welcome grant 123 HD, ${defaultConfig().entities.length + 1} entities`));
    assert.match(out, /Account opened\. 123 HD welcome grant/);
    assert.match(out, /pawn-shop\s+entity/);
  });

  test('a config that fails validation stops startup with exit 1 and says why', () => {
    const bad = configFile('bad.json', { ...defaultConfig(), welcomeGrant: '0' });
    const { code, out } = sim([`--config=${bad}`], 'exit\n');
    assert.equal(code, 1, out);
    assert.match(out, /startup failed: .*welcomeGrant must be greater than zero/);
  });

  test('a config naming a backend that does not exist yet is refused', () => {
    const path = configFile('bsc.json', { ...defaultConfig(), backend: 'solana' });
    const { code, out } = sim([`--config=${path}`], 'exit\n');
    assert.equal(code, 1, out);
    assert.match(out, /startup failed: backend "solana" is not implemented/);
  });

  test('postgres without a databaseUrl is refused at config load, before the backend is ever built', () => {
    const path = configFile('pg.json', { ...defaultConfig(), backend: 'postgres' });
    const { code, out } = sim([`--config=${path}`], 'exit\n');
    assert.equal(code, 1, out);
    assert.match(out, /startup failed: .*backend "postgres" requires databaseUrl/);
  });

  test('--backend=postgres --database-url= actually works end to end, against a real Postgres', { skip: !PG_URL }, () => {
    const { code, out } = sim(
      [`--backend=postgres`, `--database-url=${PG_URL}`],
      'seed\nfund hospital 100\nbuy alice hospital_full_heal\nverify\nexit\n',
    );
    assert.equal(code, 0, out);
    assert.match(out, /backend postgres/);
    assert.match(out, /Account opened\. 500 HD welcome grant/);
    assert.match(out, /Paid 200 HD to Pillbox Medical/);
    assert.match(out, /chain OK/);
  });

  test('a missing config file is a clear startup error, not a stack trace', () => {
    const { code, out } = sim([`--config=${join(dir, 'nope.json')}`], 'exit\n');
    assert.equal(code, 1, out);
    assert.match(out, /startup failed: Cannot read config/);
    assert.doesNotMatch(out, /\n\s+at /);
  });
});

describe('sim — startup verification', () => {
  test('a sqlite ledger persists across runs, and tampering with a row stops the next start', () => {
    const db = join(dir, 'world.sqlite');
    const first = sim([`--backend=sqlite`, `--db=${db}`], 'seed\nrent alice bike 10\nexit\n');
    assert.equal(first.code, 0, first.out);

    const second = sim([`--backend=sqlite`, `--db=${db}`], 'bal alice\nverify\nexit\n');
    assert.equal(second.code, 0, second.out);
    assert.match(second.out, /alice: 490 HD/);
    assert.match(second.out, /chain OK/);

    // Edit a row the way someone with file access would.
    const conn = new DatabaseSync(db);
    conn.exec('DROP TRIGGER transactions_no_update');
    conn.exec("UPDATE transactions SET amount = '1' WHERE kind = 'mint' AND seq = (SELECT MIN(seq) FROM transactions WHERE kind = 'mint')");
    conn.close();

    const third = sim([`--backend=sqlite`, `--db=${db}`], 'join mallory\nexit\n');
    assert.equal(third.code, 1, third.out);
    assert.match(third.out, /startup refused: the ledger failed verification/);
    assert.match(third.out, /BROKEN/);
    assert.doesNotMatch(third.out, /Account opened/, 'nothing may be written to a ledger that failed');
  });

  test('deleting the newest transaction is caught by the saved checkpoint on the next start', () => {
    const db = join(dir, 'chopped.sqlite');
    assert.equal(sim([`--backend=sqlite`, `--db=${db}`], 'seed\nexit\n').code, 0);

    const conn = new DatabaseSync(db);
    conn.exec('DROP TRIGGER transactions_no_delete; DROP TRIGGER nonces_no_delete; DROP TRIGGER memo_keys_no_delete');
    conn.exec('PRAGMA foreign_keys = OFF');
    conn.exec("DELETE FROM nonces WHERE tx_id = (SELECT id FROM transactions ORDER BY seq DESC LIMIT 1)");
    conn.exec("DELETE FROM memo_keys WHERE tx_id = (SELECT id FROM transactions ORDER BY seq DESC LIMIT 1)");
    conn.exec('DELETE FROM transactions WHERE seq = (SELECT MAX(seq) FROM transactions)');
    conn.close();

    const next = sim([`--backend=sqlite`, `--db=${db}`], 'exit\n');
    assert.equal(next.code, 1, next.out);
    assert.match(next.out, /saved checkpoint says the ledger was truncated/);
  });
});
