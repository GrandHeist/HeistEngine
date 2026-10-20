// File-backed SQLite tests. Everything here runs against a real database file and, for the
// tamper tests, edits real rows through a SECOND connection the way someone with file access
// would. The point is not that tampering is impossible (it is not) but that verifyIntegrity
// notices it, and that the schema itself refuses the accidental kind.

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SQLOutputValue } from 'node:sqlite';
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { defaultConfig } from '../src/config/config.ts';
import { Custody } from '../src/engine/custody.ts';
import { EconomyEngine } from '../src/engine/engine.ts';
import { EngineError } from '../src/errors.ts';
import type { Checkpoint, IntegrityReport } from '../src/ledger/backend.ts';
import { canonicalTxPayload, encodeAmount, hashTx, GENESIS_HASH } from '../src/ledger/hashchain.ts';
import { SqliteBackend } from '../src/ledger/sqlite.ts';
import type { Memo, TxKind, Wallet } from '../src/types.ts';

type Row = Record<string, SQLOutputValue>;

const dir = mkdtempSync(join(tmpdir(), 'heist-sqlite-'));
after(() => rmSync(dir, { recursive: true, force: true }));

let counter = 0;
function newPath(): string {
  counter += 1;
  return join(dir, `ledger-${counter}.sqlite`);
}

function key(seed: string): { pubkey: string; address: string } {
  const pubkey = seed.padEnd(64, '0');
  return { pubkey, address: `HD${pubkey.slice(0, 40)}` };
}

interface World {
  backend: SqliteBackend;
  path: string;
  alice: Wallet;
  bob: Wallet;
  treasury: Wallet;
}

/** Five txs (seq 0-4) across three wallets, with nonces, a key and meta in the mix. */
async function populated(path = newPath()): Promise<World> {
  const backend = new SqliteBackend(path);
  await backend.init();
  const alice = await backend.createWallet('alice', key('a1'));
  const bob = await backend.createWallet('bob', key('b2'));
  const treasury = await backend.createWallet('treasury', key('c3'), { isEntity: true });
  await backend.mint(alice.id, 1000n, { intent: 'OpenAccount', nonce: 'm1', key: 'welcome:alice' });
  await backend.transfer(alice.id, bob.id, 300n, { intent: 'Transfer', nonce: 't1' });
  await backend.transfer(bob.id, alice.id, 50n, { intent: 'Transfer', nonce: 't2' });
  await backend.burn(alice.id, 25n, { intent: 'Burn', nonce: 'b1' });
  await backend.transfer(alice.id, treasury.id, 100n, {
    intent: 'RentVehicle',
    nonce: 't3',
    meta: { vehicle: 'bike', minutes: '10' },
  });
  return { backend, path, alice, bob, treasury };
}

/** Open the file as an attacker would: no triggers, no CHECK enforcement, no foreign keys. */
function tamper(path: string, edit: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA ignore_check_constraints = ON');
    db.exec('PRAGMA foreign_keys = OFF');
    const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all();
    for (const t of triggers) db.exec(`DROP TRIGGER ${String(t['name'])}`);
    edit(db);
  } finally {
    db.close();
  }
}

interface RawTx {
  id: string;
  seq: number;
  kind: TxKind;
  from: string | null;
  to: string | null;
  amount: bigint;
  memo: Memo;
  createdAt: string;
}

/**
 * Rewrite history the way a careful attacker would: change some rows, then recompute every
 * prev_hash and hash so the chain is internally consistent again, and (optionally) recompute
 * the balances table to match.
 */
function rewriteChain(path: string, mutate: (txs: RawTx[]) => void, fixBalances: boolean): void {
  tamper(path, (db) => {
    const txs: RawTx[] = db
      .prepare('SELECT * FROM transactions ORDER BY seq')
      .all()
      .map((r: Row) => ({
        id: String(r['id']),
        seq: Number(r['seq']),
        kind: String(r['kind']) as TxKind,
        from: r['from_wallet'] === null ? null : String(r['from_wallet']),
        to: r['to_wallet'] === null ? null : String(r['to_wallet']),
        amount: BigInt(String(r['amount'])),
        memo: JSON.parse(String(r['memo'])) as Memo,
        createdAt: String(r['created_at']),
      }));
    mutate(txs);

    let prevHash = GENESIS_HASH;
    // Every wallet starts at zero, including one whose only tx was just removed.
    const balances = new Map<string, bigint>(
      db.prepare('SELECT wallet_id FROM balances').all().map((r: Row) => [String(r['wallet_id']), 0n]),
    );
    for (const tx of txs) {
      const hash = hashTx(
        canonicalTxPayload({
          kind: tx.kind,
          from: tx.from,
          to: tx.to,
          amount: tx.amount,
          memo: tx.memo,
          prevHash,
          seq: tx.seq,
          createdAt: tx.createdAt,
        }),
      );
      db.prepare(
        'UPDATE transactions SET kind = ?, from_wallet = ?, to_wallet = ?, amount = ?, memo = ?, prev_hash = ?, hash = ? WHERE id = ?',
      ).run(tx.kind, tx.from, tx.to, encodeAmount(tx.amount), JSON.stringify(tx.memo), prevHash, hash, tx.id);
      prevHash = hash;
      if (tx.from !== null) balances.set(tx.from, (balances.get(tx.from) ?? 0n) - tx.amount);
      if (tx.to !== null) balances.set(tx.to, (balances.get(tx.to) ?? 0n) + tx.amount);
    }
    if (fixBalances) {
      for (const [id, amount] of balances) {
        db.prepare('UPDATE balances SET amount = ? WHERE wallet_id = ?').run(
          encodeAmount(amount < 0n ? 0n : amount),
          id,
        );
      }
    }
  });
}

/** JSON.stringify that survives bigint, for assertion messages (they are built eagerly). */
function show(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
}

function expectBroken(report: IntegrityReport, why: string): void {
  assert.equal(report.ok, false, `${why}: verifyIntegrity must not report ok`);
}

function throwsMatching(fn: () => unknown, pattern: RegExp): void {
  assert.throws(fn, (error: unknown) => {
    assert.match(String((error as Error).message), pattern);
    return true;
  });
}

async function checkpointOf(backend: SqliteBackend): Promise<Checkpoint> {
  const cp = await backend.checkpoint();
  assert.ok(cp !== null, 'expected a non-empty chain');
  return cp;
}

describe('SqliteBackend — a healthy file verifies', () => {
  test('the populated ledger is ok, reports its head, and matches its own checkpoint', async () => {
    const { backend } = await populated();
    const cp = await checkpointOf(backend);
    const report = await backend.verifyIntegrity(cp);
    assert.equal(report.ok, true, show(report));
    assert.equal(report.checked, 5);
    assert.deepEqual(report.head, cp);
    assert.equal(cp.seq, 4);
    assert.equal(report.checkpoint, 'ok');
    assert.deepEqual(report.violations, []);
    await backend.close();
  });

  test('an empty ledger has no head and verifies', async () => {
    const backend = new SqliteBackend(newPath());
    await backend.init();
    assert.equal(await backend.checkpoint(), null);
    const report = await backend.verifyIntegrity();
    assert.equal(report.ok, true);
    assert.equal(report.head, null);
    await backend.close();
  });
});

describe('SqliteBackend — the schema refuses the accidental kind', () => {
  test('UPDATE and DELETE on the ledger tables are blocked by triggers', async () => {
    const { backend, path } = await populated();
    const db = new DatabaseSync(path);
    try {
      for (const table of ['transactions', 'nonces', 'memo_keys', 'wallets']) {
        throwsMatching(() => db.exec(`UPDATE ${table} SET rowid = rowid`), /append-only/);
        throwsMatching(() => db.exec(`DELETE FROM ${table}`), /append-only/);
      }
      // ...and the data is all still there.
      assert.equal((await backend.verifyIntegrity()).checked, 5);
    } finally {
      db.close();
      await backend.close();
    }
  });

  test('CHECK constraints reject non-canonical amounts, malformed shapes and NULLs', async () => {
    const { backend, path, alice, bob } = await populated();
    const control = await populated(); // a second file, so the positive control leaves this one clean
    let seq = 100;
    const rowFor = (over: Partial<Record<string, string | number | null>>) => ({
      id: `x-${(seq += 1)}`,
      seq,
      kind: 'transfer',
      from_wallet: alice.id,
      to_wallet: bob.id,
      amount: '5',
      memo: '{"intent":"X"}',
      prev_hash: 'a'.repeat(64),
      hash: 'b'.repeat(64),
      signature: null,
      created_at: 'now',
      ...over,
    });
    const insertInto = (db: DatabaseSync, over: Partial<Record<string, string | number | null>>): void => {
      db.prepare(
        `INSERT INTO transactions (id, seq, kind, from_wallet, to_wallet, amount, memo, prev_hash, hash, signature, created_at)
         VALUES (:id, :seq, :kind, :from_wallet, :to_wallet, :amount, :memo, :prev_hash, :hash, :signature, :created_at)`,
      ).run(rowFor(over));
    };

    // Positive control: the same row shape IS accepted when it is well-formed, so every rejection
    // below is down to the one thing changed.
    const okDb = new DatabaseSync(control.path);
    try {
      assert.doesNotThrow(() =>
        insertInto(okDb, { from_wallet: control.alice.id, to_wallet: control.bob.id }),
      );
    } finally {
      okDb.close();
      await control.backend.close();
    }

    const db = new DatabaseSync(path);
    const rejects = (over: Partial<Record<string, string | number | null>>, why: string): void => {
      assert.throws(() => insertInto(db, over), /CHECK constraint failed|NOT NULL constraint failed/, why);
    };
    try {
      for (const amount of ['0', '-5', '05', '1.5', '1e3', ' 5', '', 'abc']) {
        rejects({ amount }, `amount ${JSON.stringify(amount)}`);
      }
      rejects({ kind: 'mint' }, 'a mint with a source');
      rejects({ kind: 'burn' }, 'a burn with a destination');
      rejects({ to_wallet: alice.id }, 'a transfer to the same wallet');
      rejects({ to_wallet: null }, 'a transfer with no destination');
      rejects({ kind: 'sideways' }, 'an unknown kind');
      rejects({ memo: null }, 'a NULL memo');
      rejects({ hash: 'short' }, 'a malformed hash');
      rejects({ seq: -1 }, 'a negative seq');
      for (const bad of ['-1', '007', '', 'x']) {
        assert.throws(
          () => db.exec(`UPDATE balances SET amount = '${bad}' WHERE wallet_id = '${alice.id}'`),
          /CHECK constraint failed/,
          `balance ${JSON.stringify(bad)}`,
        );
      }
      assert.equal((await backend.verifyIntegrity()).ok, true, 'nothing above touched the ledger');
    } finally {
      db.close();
      await backend.close();
    }
  });

  test('a file database syncs every commit and waits for a busy writer', async () => {
    const { backend } = await populated();
    const conn = (backend as unknown as { db: DatabaseSync }).db;
    const pragma = (name: string): unknown => {
      const row = conn.prepare(`PRAGMA ${name}`).get();
      return row === undefined ? undefined : Object.values(row)[0];
    };
    assert.equal(pragma('synchronous'), 2, 'synchronous must be FULL (2)');
    assert.equal(pragma('busy_timeout'), 5000);
    assert.equal(pragma('foreign_keys'), 1);
    assert.equal(String(pragma('journal_mode')).toLowerCase(), 'wal');
    await backend.close();
  });
});

describe('SqliteBackend — verifyIntegrity notices tampering with real rows', () => {
  test('an edited amount breaks the hash at that row', async () => {
    const { backend, path } = await populated();
    tamper(path, (db) => db.exec("UPDATE transactions SET amount = '999' WHERE seq = 2"));
    const report = await backend.verifyIntegrity();
    expectBroken(report, 'edited amount');
    assert.ok(report.brokenAt.includes(2), `brokenAt ${JSON.stringify(report.brokenAt)}`);
    await backend.close();
  });

  test('an edited memo, kind or timestamp breaks the hash', async () => {
    for (const edit of [
      `UPDATE transactions SET memo = '{"intent":"Forged","nonce":"t1"}' WHERE seq = 1`,
      `UPDATE transactions SET created_at = '2020-01-01T00:00:00.000Z' WHERE seq = 1`,
    ]) {
      const { backend, path } = await populated();
      tamper(path, (db) => db.exec(edit));
      const report = await backend.verifyIntegrity();
      expectBroken(report, edit);
      assert.ok(report.brokenAt.includes(1), edit);
      await backend.close();
    }
  });

  test('balance drift: a stored balance that no longer matches the history', async () => {
    const { backend, path, alice } = await populated();
    tamper(path, (db) =>
      db.exec(`UPDATE balances SET amount = '5000000' WHERE wallet_id = '${alice.id}'`),
    );
    const report = await backend.verifyIntegrity();
    expectBroken(report, 'drifted balance');
    assert.deepEqual(report.balanceMismatches, [alice.id]);
    assert.deepEqual(report.brokenAt, [], 'the chain itself is untouched');
    await backend.close();
  });

  test('a truncated last tx is caught (its money is still in the balances)', async () => {
    const { backend, path } = await populated();
    const cp = await checkpointOf(backend);
    tamper(path, (db) => {
      db.exec("DELETE FROM nonces WHERE nonce = 't3'");
      db.exec('DELETE FROM transactions WHERE seq = 4');
    });
    const withoutCheckpoint = await backend.verifyIntegrity();
    expectBroken(withoutCheckpoint, 'truncation, no checkpoint');
    assert.ok(withoutCheckpoint.balanceMismatches.length > 0);
    const withCheckpoint = await backend.verifyIntegrity(cp);
    assert.equal(withCheckpoint.checkpoint, 'truncated');
    await backend.close();
  });

  test('a thorough truncation (balances fixed too) is invisible without a checkpoint, caught with one', async () => {
    const { backend, path } = await populated();
    const cp = await checkpointOf(backend);
    tamper(path, (db) => {
      db.exec("DELETE FROM nonces WHERE nonce = 't3'");
      db.exec('DELETE FROM transactions WHERE seq = 4');
    });
    // Put the balances back in line with the shortened history.
    rewriteChain(path, () => undefined, true);

    const plain = await backend.verifyIntegrity();
    assert.equal(plain.ok, true, `the hash chain alone cannot see a cut-off tail: ${show(plain)}`);
    assert.equal(plain.checked, 4);

    const checked = await backend.verifyIntegrity(cp);
    assert.equal(checked.checkpoint, 'truncated');
    expectBroken(checked, 'checkpoint');
    await backend.close();
  });

  test('a fully re-hashed rewrite with fixed balances passes the chain but not the checkpoint', async () => {
    const { backend, path } = await populated();
    const cp = await checkpointOf(backend);
    rewriteChain(
      path,
      (txs) => {
        const t = txs.find((x) => x.seq === 3);
        assert.ok(t !== undefined);
        t.amount = 1n; // the burn of 25 becomes a burn of 1
      },
      true,
    );
    assert.equal((await backend.verifyIntegrity()).ok, true, 'internally consistent: chain cannot tell');
    const checked = await backend.verifyIntegrity(cp);
    assert.equal(checked.checkpoint, 'rewritten');
    expectBroken(checked, 'rewritten tail');
    await backend.close();
  });

  test('a re-hashed overdraft is a rule violation even with a consistent chain', async () => {
    const { backend, path } = await populated();
    rewriteChain(
      path,
      (txs) => {
        const t = txs.find((x) => x.seq === 1);
        assert.ok(t !== undefined);
        t.amount = 5000n; // alice only ever held 1000
      },
      true,
    );
    const report = await backend.verifyIntegrity();
    expectBroken(report, 'overdraft');
    assert.ok(report.violations.some((v) => /spends 5000/.test(v.reason)), JSON.stringify(report.violations));
    await backend.close();
  });

  test('rows that break the ledger rules are reported, never thrown', async () => {
    const cases: { sql: string; expect: RegExp }[] = [
      { sql: "UPDATE transactions SET amount = '0' WHERE seq = 1", expect: /below the minimum|amount/ },
      { sql: "UPDATE transactions SET amount = '-50' WHERE seq = 1", expect: /below the minimum|amount/ },
      { sql: "UPDATE transactions SET amount = 'abc' WHERE seq = 1", expect: /canonical amount/ },
      { sql: "UPDATE transactions SET memo = 'not json' WHERE seq = 1", expect: /memo/i },
      { sql: "UPDATE transactions SET kind = 'sideways' WHERE seq = 1", expect: /kind/i },
      { sql: "UPDATE transactions SET from_wallet = 'ghost' WHERE seq = 1", expect: /unknown wallet/ },
      { sql: "UPDATE transactions SET from_wallet = NULL WHERE seq = 1", expect: /transfer needs both/ },
    ];
    for (const { sql, expect } of cases) {
      const { backend, path } = await populated();
      tamper(path, (db) => db.exec(sql));
      let report: IntegrityReport | undefined;
      await assert.doesNotReject(async () => {
        report = await backend.verifyIntegrity();
      }, sql);
      assert.ok(report !== undefined);
      expectBroken(report, sql);
      assert.ok(
        report.violations.some((v) => expect.test(v.reason)),
        `${sql}: violations ${JSON.stringify(report.violations)}`,
      );
      await backend.close();
    }
  });

  test('a mint that names a source wallet is a violation (re-hashed so the chain is clean)', async () => {
    const { backend, path, bob } = await populated();
    rewriteChain(
      path,
      (txs) => {
        const t = txs.find((x) => x.seq === 0);
        assert.ok(t !== undefined);
        t.from = bob.id;
      },
      false,
    );
    const report = await backend.verifyIntegrity();
    expectBroken(report, 'mint with a source');
    assert.ok(report.violations.some((v) => /mint must have no source/.test(v.reason)));
    await backend.close();
  });

  test('a negative stored balance is reported', async () => {
    const { backend, path, bob } = await populated();
    tamper(path, (db) => db.exec(`UPDATE balances SET amount = '-7' WHERE wallet_id = '${bob.id}'`));
    const report = await backend.verifyIntegrity();
    expectBroken(report, 'negative balance');
    assert.ok(report.balanceMismatches.includes(bob.id));
    assert.ok(report.violations.some((v) => /invalid/.test(v.reason)));
    await backend.close();
  });

  test('a deleted nonce or key row (which would re-open a replay) is reported', async () => {
    for (const sql of ["DELETE FROM nonces WHERE nonce = 't1'", "DELETE FROM memo_keys WHERE key = 'welcome:alice'"]) {
      const { backend, path } = await populated();
      tamper(path, (db) => db.exec(sql));
      const report = await backend.verifyIntegrity();
      expectBroken(report, sql);
      assert.ok(report.violations.some((v) => /no matching row/.test(v.reason)), sql);
      await backend.close();
    }
  });

  test('a nonce row that points at no ledger tx is reported', async () => {
    const { backend, path } = await populated();
    tamper(path, (db) =>
      db.exec("INSERT INTO nonces (nonce, tx_id, created_at) VALUES ('ghost', 'no-such-tx', 'now')"),
    );
    const report = await backend.verifyIntegrity();
    expectBroken(report, 'dangling nonce');
    assert.ok(report.violations.some((v) => /points at no ledger tx/.test(v.reason)));
    await backend.close();
  });
});

describe('SqliteBackend — close, reopen, continue', () => {
  test('state, replay guards and the chain all survive a restart, and writing continues the chain', async () => {
    const world = await populated();
    const { path, alice, bob } = world;
    const before = {
      alice: await world.backend.getBalance(alice.id),
      bob: await world.backend.getBalance(bob.id),
      history: (await world.backend.history(alice.id, undefined, 500)).txs,
      head: await checkpointOf(world.backend),
      wallets: await world.backend.listWallets(),
    };
    await world.backend.close();

    const reopened = new SqliteBackend(path);
    await reopened.init();

    assert.deepEqual(await reopened.listWallets(), before.wallets);
    assert.equal(await reopened.getBalance(alice.id), before.alice);
    assert.equal(await reopened.getBalance(bob.id), before.bob);
    assert.deepEqual((await reopened.history(alice.id, undefined, 500)).txs, before.history);
    assert.equal((await reopened.getWalletByOwner('alice'))?.pubkey, alice.pubkey);
    assert.equal(await reopened.hasNonce('t1'), true);
    assert.equal((await reopened.getTxByNonce('m1'))?.seq, 0);
    assert.equal((await reopened.verifyIntegrity(before.head)).ok, true);

    // replay guards still bite after the restart
    await assert.rejects(reopened.mint(alice.id, 1n, { intent: 'X', nonce: 't1' }), (e: unknown) => {
      assert.equal((e as EngineError).code, 'DUPLICATE_NONCE');
      return true;
    });
    await assert.rejects(
      reopened.mint(alice.id, 1n, { intent: 'X', nonce: 'fresh', key: 'welcome:alice' }),
      (e: unknown) => {
        assert.equal((e as EngineError).code, 'DUPLICATE_KEY');
        return true;
      },
    );

    // ...and new writes extend, rather than fork, the chain
    const ref = await reopened.transfer(alice.id, bob.id, 10n, { intent: 'Transfer', nonce: 'after' });
    assert.equal(ref.seq, before.head.seq + 1);
    assert.equal((await reopened.getTx(ref.txId))?.prevHash, before.head.hash);
    assert.equal(await reopened.getBalance(bob.id), before.bob + 10n);

    const report = await reopened.verifyIntegrity(before.head);
    assert.equal(report.ok, true, 'the old checkpoint is still a prefix of the longer chain');
    assert.equal(report.checked, 6);
    await reopened.close();
  });

  test('two connections to one file take turns: seqs stay unique and contiguous', async () => {
    const path = newPath();
    const a = new SqliteBackend(path);
    const b = new SqliteBackend(path);
    await a.init();
    await b.init();
    const w = await a.createWallet('w', key('w1'));
    const same = await b.createWallet('w', key('other')); // created via `a`: idempotent across connections
    assert.equal(same.id, w.id);

    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        (i % 2 === 0 ? a : b).mint(w.id, 1n, { intent: 'Mint', nonce: `n${i}` }),
      ),
    );
    const report = await a.verifyIntegrity();
    assert.equal(report.ok, true, show(report));
    assert.equal(report.checked, 20);
    assert.equal(await b.getBalance(w.id), 20n);
    await a.close();
    await b.close();
  });

  test('an engine restarted over the same file keeps accounts, rentals and refusals', async () => {
    const path = newPath();
    const config = { ...defaultConfig(), backend: 'sqlite' as const, dbPath: path };
    let backend = new SqliteBackend(path);
    let engine = new EconomyEngine({ backend, custody: new Custody('sqlite'), config });
    await engine.init();

    const open = await engine.submit({ type: 'OpenAccount', nonce: 'o1', actor: 'alice' });
    assert.equal(open.ok, true);
    const rented = await engine.submit({ type: 'RentVehicle', nonce: 'r1', actor: 'alice', vehicle: 'bike', minutes: 30 });
    assert.ok(rented.ok);
    await backend.close();

    // "restart": brand-new backend, custody and engine over the same file
    backend = new SqliteBackend(path);
    engine = new EconomyEngine({ backend, custody: new Custody('sqlite'), config });
    await engine.init();

    const again = await engine.submit({ type: 'OpenAccount', nonce: 'o2', actor: 'alice' });
    assert.ok(!again.ok && again.code === 'ACCOUNT_EXISTS', 'the grant is not paid again after a restart');
    const replay = await engine.submit({ type: 'OpenAccount', nonce: 'o1', actor: 'alice' });
    assert.ok(replay.ok && replay.replayed === true);

    const returned = await engine.submit({
      type: 'ReturnVehicle',
      nonce: 'x1',
      actor: 'alice',
      rentalId: rented.txId,
      minutesUnused: 10,
    });
    assert.ok(returned.ok, show(returned));
    assert.equal(returned.newBalance, 500n - 30n + 10n);
    const twice = await engine.submit({
      type: 'ReturnVehicle',
      nonce: 'x2',
      actor: 'alice',
      rentalId: rented.txId,
      minutesUnused: 10,
    });
    assert.ok(!twice.ok && twice.code === 'RENTAL_CLOSED');

    const report = await backend.verifyIntegrity();
    assert.equal(report.ok, true, show(report));
    await backend.close();
  });

  test('a restart with a master seed reproduces every wallet key; a wrong seed refuses to start', async () => {
    const path = newPath();
    const config = { ...defaultConfig(), backend: 'sqlite' as const, dbPath: path };
    const seed = randomBytes(32);
    const otherSeed = randomBytes(32);

    let backend = new SqliteBackend(path);
    let engine = new EconomyEngine({ backend, custody: new Custody('sqlite', { masterSeed: seed }), config });
    await engine.init();
    const open = await engine.submit({ type: 'OpenAccount', nonce: 'o1', actor: 'alice' });
    assert.ok(open.ok);
    await backend.close();

    // "restart" with the SAME seed: every wallet (alice + every configured entity) reconciles.
    backend = new SqliteBackend(path);
    engine = new EconomyEngine({ backend, custody: new Custody('sqlite', { masterSeed: seed }), config });
    await assert.doesNotReject(() => engine.init());
    await backend.close();

    // "restart" with a DIFFERENT seed: every derived key mismatches its stored pubkey.
    backend = new SqliteBackend(path);
    engine = new EconomyEngine({ backend, custody: new Custody('sqlite', { masterSeed: otherSeed }), config });
    await assert.rejects(
      () => engine.init(),
      (error: unknown) => {
        assert.ok(error instanceof EngineError);
        assert.equal(error.code, 'CUSTODY_KEY_MISMATCH');
        return true;
      },
    );
    await backend.close();

    // "restart" with NO seed configured at all is unaffected by this feature — hasMasterSeed
    // is false, so reconciliation is skipped entirely (see the adjacent "keeps accounts" test
    // above, which relies on exactly this for backends that never opted into signing).
    // reconcileExistingWallet's OWN refusal when called with no seed is covered directly in
    // tests/custody.test.ts; engine.init() simply never calls it in that case.
    backend = new SqliteBackend(path);
    engine = new EconomyEngine({ backend, custody: new Custody('sqlite'), config });
    await assert.doesNotReject(() => engine.init());
    await backend.close();
  });
});

describe('SqliteBackend — verifyIntegrity never throws on odd stored types', () => {
  test('BLOB keys in the replay guards, wallets or balances are violations, not exceptions', async () => {
    const cases = [
      "INSERT INTO nonces (nonce, tx_id, created_at) VALUES (x'00ff', 'x', 'now')",
      "INSERT INTO memo_keys (key, tx_id, created_at) VALUES (x'00ff', 'x', 'now')",
      "INSERT INTO wallets (id, owner_id, address, pubkey, is_entity, created_at) VALUES (x'01', 'blob', 'a', 'p', 0, 'now')",
      "INSERT INTO balances (wallet_id, amount) VALUES (x'02', '0')",
    ];
    for (const sql of cases) {
      const { backend, path } = await populated();
      tamper(path, (db) => db.exec(sql));
      let report: IntegrityReport | undefined;
      await assert.doesNotReject(async () => {
        report = await backend.verifyIntegrity();
      }, sql);
      assert.ok(report !== undefined && report.ok === false, sql);
      await backend.close();
    }
  });

  test('the check leaves no transaction open, so writes work straight afterwards', async () => {
    const { backend, alice } = await populated();
    await backend.verifyIntegrity();
    await backend.mint(alice.id, 1n, { intent: 'X', nonce: 'after-verify' });
    assert.equal((await backend.verifyIntegrity()).ok, true);
    await backend.close();
  });
});
