// Shared conformance suite. Every case in here runs against EVERY backend, so
// MemoryBackend and SqliteBackend are proven to behave identically rather than
// merely to compile against the same interface. Adding a backend means adding
// one entry to `FACTORIES` and nothing else.

import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { EngineError } from '../src/errors.ts';
import { MemoryBackend } from '../src/ledger/memory.ts';
import { SqliteBackend } from '../src/ledger/sqlite.ts';
import { PostgresBackend } from '../src/ledger/postgres.ts';
import { GENESIS_HASH } from '../src/ledger/hashchain.ts';
import type { LedgerBackend, WalletKeyInfo } from '../src/ledger/backend.ts';
import type { Memo, Tx, Wallet } from '../src/types.ts';

interface BackendFactory {
  readonly label: string;
  create(): LedgerBackend;
}

const FACTORIES: BackendFactory[] = [
  { label: 'MemoryBackend', create: () => new MemoryBackend() },
  // ':memory:' so the suite needs no files and no cleanup.
  { label: 'SqliteBackend', create: () => new SqliteBackend(':memory:') },
];

// Real Postgres only, like ADR 0001 says: no mock, no in-memory stand-in claiming to be Postgres.
// `TEST_DATABASE_URL` defaults to a local instance; no explicit schema, so PostgresBackend makes a
// fresh one per test and drops it in `close()` — genuine isolation, no cleanup code needed here.
// If nothing is listening there, this entire backend is skipped (reported, not silently dropped)
// rather than failing every test in the suite over an environment gap unrelated to the code.
const PG_URL = process.env['TEST_DATABASE_URL'] ?? 'postgres://localhost/heist_engine_test';
let pgAvailable = false;
try {
  const probe = new PostgresBackend(PG_URL);
  await probe.init();
  await probe.close();
  pgAvailable = true;
} catch (error) {
  console.log(
    `SKIPPING PostgresBackend conformance suite: could not reach ${PG_URL} (${error instanceof Error ? error.message : String(error)})`,
  );
}
if (pgAvailable) {
  FACTORIES.push({ label: 'PostgresBackend', create: () => new PostgresBackend(PG_URL) });
}

/** Deterministic stand-in for a Custody-minted public half. */
function keyFor(seed: string): WalletKeyInfo {
  const pubkey = createHash('sha256').update(seed, 'utf8').digest('hex');
  return { pubkey, address: `HD${pubkey.slice(0, 40)}` };
}

function memo(intent: string, nonce?: string, detail?: string): Memo {
  const out: Memo = { intent };
  if (detail !== undefined) out.detail = detail;
  if (nonce !== undefined) out.nonce = nonce;
  return out;
}

/** Asserts the promise rejects with an EngineError carrying exactly `code`. */
async function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(
      error instanceof EngineError,
      `expected an EngineError with code ${code}, got ${String(error)}`,
    );
    assert.equal(error.code, code);
    return true;
  });
}

function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  assert.ok(value !== undefined, `expected an element at index ${index}`);
  return value;
}

function conformanceSuite(factory: BackendFactory): void {
  describe(`ledger conformance — ${factory.label}`, () => {
    let backend: LedgerBackend;

    beforeEach(async () => {
      backend = factory.create();
      await backend.init();
    });

    afterEach(async () => {
      await backend.close();
    });

    async function wallet(owner: string, isEntity = false): Promise<Wallet> {
      return await backend.createWallet(owner, keyFor(owner), { isEntity });
    }

    /** Every tx in the chain, oldest first, read back through the public API. */
    async function chain(walletIds: readonly string[]): Promise<Tx[]> {
      const seen = new Map<string, Tx>();
      for (const id of walletIds) {
        let cursor: string | undefined;
        for (;;) {
          const page = await backend.history(id, cursor, 500);
          for (const tx of page.txs) seen.set(tx.id, tx);
          if (page.cursor === null) break;
          cursor = page.cursor;
        }
      }
      return [...seen.values()].sort((a, b) => a.seq - b.seq);
    }

    // -----------------------------------------------------------------------
    // Wallets
    // -----------------------------------------------------------------------

    test('createWallet stores the supplied pubkey and address verbatim', async () => {
      const key = keyFor('alice');
      const created = await backend.createWallet('alice', key);

      assert.equal(created.ownerId, 'alice');
      assert.equal(created.pubkey, key.pubkey);
      assert.equal(created.address, key.address);
      assert.equal(created.isEntity, false);

      const byId = await backend.getWallet(created.id);
      assert.notEqual(byId, null);
      assert.equal(byId?.pubkey, key.pubkey);
      assert.equal(byId?.address, key.address);

      const byOwner = await backend.getWalletByOwner('alice');
      assert.deepEqual(byOwner, created);
    });

    test('createWallet is idempotent per owner and ignores the second key', async () => {
      const first = await backend.createWallet('alice', keyFor('alice'), { isEntity: false });
      const second = await backend.createWallet('alice', keyFor('someone-else'), {
        isEntity: true,
      });

      assert.equal(second.id, first.id);
      assert.equal(second.pubkey, first.pubkey, 'the original pubkey must not be replaced');
      assert.equal(second.address, first.address);
      assert.equal(second.isEntity, first.isEntity);

      assert.equal((await backend.listWallets()).length, 1);
    });

    test('isEntity is persisted as given', async () => {
      const entity = await backend.createWallet('treasury', keyFor('treasury'), {
        isEntity: true,
      });
      assert.equal(entity.isEntity, true);
      assert.equal((await backend.getWallet(entity.id))?.isEntity, true);
    });

    test('getWallet / getWalletByOwner return null for unknown ids', async () => {
      assert.equal(await backend.getWallet('no-such-wallet'), null);
      assert.equal(await backend.getWalletByOwner('nobody'), null);
    });

    test('a fresh wallet starts at zero', async () => {
      const alice = await wallet('alice');
      assert.equal(await backend.getBalance(alice.id), 0n);
    });

    // -----------------------------------------------------------------------
    // Arithmetic
    // -----------------------------------------------------------------------

    test('mint / transfer / burn move exactly the stated amounts', async () => {
      const alice = await wallet('alice');
      const bob = await wallet('bob');

      await backend.mint(alice.id, 1000n, memo('Test', 'm1'));
      assert.equal(await backend.getBalance(alice.id), 1000n);
      assert.equal(await backend.getBalance(bob.id), 0n);

      await backend.transfer(alice.id, bob.id, 250n, memo('Test', 't1'));
      assert.equal(await backend.getBalance(alice.id), 750n);
      assert.equal(await backend.getBalance(bob.id), 250n);

      await backend.burn(bob.id, 50n, memo('Test', 'b1'));
      assert.equal(await backend.getBalance(alice.id), 750n);
      assert.equal(await backend.getBalance(bob.id), 200n);

      // Burning the whole remainder is allowed and lands exactly on zero.
      await backend.burn(bob.id, 200n, memo('Test', 'b2'));
      assert.equal(await backend.getBalance(bob.id), 0n);
    });

    test('mint has from=null and burn has to=null', async () => {
      const alice = await wallet('alice');

      const mintRef = await backend.mint(alice.id, 100n, memo('Test', 'm1'));
      const mintTx = await backend.getTx(mintRef.txId);
      assert.notEqual(mintTx, null);
      assert.equal(mintTx?.kind, 'mint');
      assert.equal(mintTx?.from, null);
      assert.equal(mintTx?.to, alice.id);

      const burnRef = await backend.burn(alice.id, 40n, memo('Test', 'b1'));
      const burnTx = await backend.getTx(burnRef.txId);
      assert.notEqual(burnTx, null);
      assert.equal(burnTx?.kind, 'burn');
      assert.equal(burnTx?.from, alice.id);
      assert.equal(burnTx?.to, null);
    });

    // -----------------------------------------------------------------------
    // ADR 0002 REGRESSION GUARD.
    //
    // If this fails, money has stopped being stored as canonical base-10 TEXT
    // and something in the path is going through a JS number again. Do not
    // "fix" it by shrinking the amount.
    // -----------------------------------------------------------------------

    test('amounts far beyond 2^53 survive a full round trip exactly', async () => {
      const huge = 9007199254740993000n; // > Number.MAX_SAFE_INTEGER * 1000
      assert.notEqual(huge, BigInt(Number(huge)), 'the guard value must not be float-representable');

      const alice = await wallet('alice');
      const bob = await wallet('bob');

      const ref = await backend.mint(alice.id, huge, memo('Test', 'huge-mint'));
      assert.equal(await backend.getBalance(alice.id), huge);

      const tx = await backend.getTx(ref.txId);
      assert.equal(tx?.amount, huge);
      assert.equal(typeof tx?.amount, 'bigint');

      // And through history, which is a different read path on the sqlite side.
      const page = await backend.history(alice.id);
      assert.equal(at(page.txs, 0).amount, huge);

      // Arithmetic on the far side of 2^53 must stay exact, not merely close.
      const slice = 1n;
      await backend.transfer(alice.id, bob.id, slice, memo('Test', 'huge-transfer'));
      assert.equal(await backend.getBalance(alice.id), huge - slice);
      assert.equal(await backend.getBalance(bob.id), slice);
      assert.equal(await backend.getBalance(alice.id), 9007199254740992999n);
    });

    // -----------------------------------------------------------------------
    // Rejections — and, just as importantly, that nothing moves on rejection
    // -----------------------------------------------------------------------

    test('insufficient funds is rejected and mutates NOTHING', async () => {
      const alice = await wallet('alice');
      const bob = await wallet('bob');
      await backend.mint(alice.id, 100n, memo('Test', 'seed'));

      const before = await backend.verifyIntegrity();

      await rejectsWithCode(
        backend.transfer(alice.id, bob.id, 500n, memo('Test', 'overdraw')),
        'INSUFFICIENT_FUNDS',
      );

      assert.equal(await backend.getBalance(alice.id), 100n, 'payer balance must be untouched');
      assert.equal(await backend.getBalance(bob.id), 0n, 'payee balance must be untouched');

      // The nonce must NOT have been consumed by the failed attempt...
      assert.equal(await backend.hasNonce('overdraw'), false);

      // ...and must therefore still be usable for a real settlement.
      await backend.transfer(alice.id, bob.id, 10n, memo('Test', 'overdraw'));
      assert.equal(await backend.getBalance(alice.id), 90n);
      assert.equal(await backend.getBalance(bob.id), 10n);
      assert.equal(await backend.hasNonce('overdraw'), true);

      // No orphan row was appended by the rejected attempt.
      const after = await backend.verifyIntegrity();
      assert.equal(after.checked, before.checked + 1);
      assert.equal(after.ok, true);
    });

    test('burning more than the wallet holds is rejected and mutates nothing', async () => {
      const alice = await wallet('alice');
      await backend.mint(alice.id, 10n, memo('Test', 'seed'));

      await rejectsWithCode(backend.burn(alice.id, 11n, memo('Test', 'bad-burn')), 'INSUFFICIENT_FUNDS');

      assert.equal(await backend.getBalance(alice.id), 10n);
      assert.equal(await backend.hasNonce('bad-burn'), false);
    });

    test('zero and negative amounts are rejected on every write path', async () => {
      const alice = await wallet('alice');
      const bob = await wallet('bob');
      await backend.mint(alice.id, 1000n, memo('Test', 'seed'));

      for (const bad of [0n, -1n, -9007199254740993000n]) {
        await rejectsWithCode(backend.mint(alice.id, bad, memo('Test')), 'INVALID_AMOUNT');
        await rejectsWithCode(backend.burn(alice.id, bad, memo('Test')), 'INVALID_AMOUNT');
        await rejectsWithCode(
          backend.transfer(alice.id, bob.id, bad, memo('Test')),
          'INVALID_AMOUNT',
        );
      }

      assert.equal(await backend.getBalance(alice.id), 1000n);
      assert.equal(await backend.getBalance(bob.id), 0n);
      assert.equal((await backend.verifyIntegrity()).checked, 1);
    });

    test('an unknown wallet is rejected on every path that names one', async () => {
      const alice = await wallet('alice');
      await backend.mint(alice.id, 100n, memo('Test', 'seed'));

      await rejectsWithCode(backend.getBalance('ghost'), 'UNKNOWN_WALLET');
      await rejectsWithCode(backend.mint('ghost', 10n, memo('Test')), 'UNKNOWN_WALLET');
      await rejectsWithCode(backend.burn('ghost', 10n, memo('Test')), 'UNKNOWN_WALLET');
      await rejectsWithCode(backend.transfer('ghost', alice.id, 10n, memo('Test')), 'UNKNOWN_WALLET');
      await rejectsWithCode(backend.transfer(alice.id, 'ghost', 10n, memo('Test')), 'UNKNOWN_WALLET');

      assert.equal(await backend.getBalance(alice.id), 100n);
      assert.equal((await backend.verifyIntegrity()).checked, 1);
    });

    test('a duplicate nonce is rejected and the replay moves no money', async () => {
      const alice = await wallet('alice');
      const bob = await wallet('bob');
      await backend.mint(alice.id, 1000n, memo('Test', 'seed'));

      await backend.transfer(alice.id, bob.id, 100n, memo('Test', 'once'));
      assert.equal(await backend.getBalance(alice.id), 900n);
      assert.equal(await backend.getBalance(bob.id), 100n);
      assert.equal(await backend.hasNonce('once'), true);

      await rejectsWithCode(
        backend.transfer(alice.id, bob.id, 100n, memo('Test', 'once')),
        'DUPLICATE_NONCE',
      );

      assert.equal(await backend.getBalance(alice.id), 900n, 'replay must not debit again');
      assert.equal(await backend.getBalance(bob.id), 100n, 'replay must not credit again');

      // A replay under a different kind/amount is still a replay.
      await rejectsWithCode(backend.mint(alice.id, 5n, memo('Test', 'once')), 'DUPLICATE_NONCE');
      assert.equal(await backend.getBalance(alice.id), 900n);

      assert.equal((await backend.verifyIntegrity()).checked, 2);
    });

    test('transfer to self is rejected', async () => {
      const alice = await wallet('alice');
      await backend.mint(alice.id, 100n, memo('Test', 'seed'));

      await rejectsWithCode(
        backend.transfer(alice.id, alice.id, 10n, memo('Test', 'self')),
        'INVALID_INTENT',
      );

      assert.equal(await backend.getBalance(alice.id), 100n);
      assert.equal(await backend.hasNonce('self'), false);
      assert.equal((await backend.verifyIntegrity()).checked, 1);
    });

    // A write can be wrong two ways at once (reused nonce AND an unknown wallet). The engine
    // never produces this — it checks the nonce and resolves every wallet before it ever calls
    // the backend — but the backend interface is public on its own, and every backend must pick
    // the same winner. Memory and sqlite once disagreed here (memory checked wallets before
    // replay guards, sqlite the other way round), invisible to the engine-level fuzz suite
    // precisely because the engine never drives this path.
    test('a reused nonce is reported even when the wallet it names is also unknown', async () => {
      const alice = await wallet('alice');
      const bob = await wallet('bob');
      await backend.mint(alice.id, 100n, memo('Test', 'seed'));
      await backend.transfer(alice.id, bob.id, 10n, memo('Test', 'dup'));

      await rejectsWithCode(
        backend.transfer(alice.id, 'no-such-wallet', 10n, memo('Test', 'dup')),
        'DUPLICATE_NONCE',
      );
      await rejectsWithCode(backend.mint('no-such-wallet', 10n, memo('Test', 'dup')), 'DUPLICATE_NONCE');
      await rejectsWithCode(backend.burn('no-such-wallet', 10n, memo('Test', 'dup')), 'DUPLICATE_NONCE');

      assert.equal(await backend.getBalance(alice.id), 90n, 'nothing further moved');
    });

    test('a reused key is reported even when the wallet it names is also unknown', async () => {
      const alice = await wallet('alice');
      const bob = await wallet('bob');
      await backend.mint(alice.id, 100n, memo('Test', 'seed'));
      await backend.transfer(alice.id, bob.id, 10n, { intent: 'Test', key: 'dup-key' });

      await rejectsWithCode(
        backend.transfer(alice.id, 'no-such-wallet', 10n, { intent: 'Test', key: 'dup-key' }),
        'DUPLICATE_KEY',
      );

      assert.equal(await backend.getBalance(alice.id), 90n, 'nothing further moved');
    });

    // -----------------------------------------------------------------------
    // History
    // -----------------------------------------------------------------------

    test('history is newest-first', async () => {
      const alice = await wallet('alice');
      for (let i = 0; i < 5; i++) {
        await backend.mint(alice.id, BigInt(i + 1), memo('Test', `m${i}`, `mint ${i}`));
      }

      const page = await backend.history(alice.id);
      assert.equal(page.txs.length, 5);
      assert.equal(page.cursor, null);

      const seqs = page.txs.map((tx) => tx.seq);
      assert.deepEqual(seqs, [4, 3, 2, 1, 0]);
      assert.equal(at(page.txs, 0).memo.detail, 'mint 4');
    });

    test('history paginates: no duplicates, no gaps, cursor eventually null', async () => {
      const alice = await wallet('alice');
      const total = 7;
      for (let i = 0; i < total; i++) {
        await backend.mint(alice.id, BigInt(i + 1), memo('Test', `m${i}`));
      }

      const collected: Tx[] = [];
      const pageSizes: number[] = [];
      let cursor: string | undefined;
      let guard = 0;

      for (;;) {
        assert.ok(guard++ < 20, 'pagination did not terminate');
        const page = await backend.history(alice.id, cursor, 3);
        pageSizes.push(page.txs.length);
        collected.push(...page.txs);
        if (page.cursor === null) break;
        cursor = page.cursor;
      }

      assert.deepEqual(pageSizes, [3, 3, 1]);
      assert.equal(collected.length, total);

      const ids = new Set(collected.map((tx) => tx.id));
      assert.equal(ids.size, total, 'a tx appeared on more than one page');

      const seqs = collected.map((tx) => tx.seq);
      assert.deepEqual(seqs, [6, 5, 4, 3, 2, 1, 0], 'pages must concatenate to strict seq-desc');
    });

    test('history only returns txs the wallet is a party to', async () => {
      const alice = await wallet('alice');
      const bob = await wallet('bob');
      const carol = await wallet('carol');

      await backend.mint(alice.id, 500n, memo('Test', 'm1'));
      await backend.transfer(alice.id, bob.id, 100n, memo('Test', 't1'));
      await backend.mint(carol.id, 700n, memo('Test', 'm2'));

      const bobHistory = await backend.history(bob.id);
      assert.equal(bobHistory.txs.length, 1);
      assert.equal(at(bobHistory.txs, 0).amount, 100n);

      const carolHistory = await backend.history(carol.id);
      assert.equal(carolHistory.txs.length, 1);
      assert.equal(at(carolHistory.txs, 0).amount, 700n);

      assert.equal((await backend.history(alice.id)).txs.length, 2);
    });

    test('getTx returns null for an unknown tx id', async () => {
      assert.equal(await backend.getTx('no-such-tx'), null);
    });

    test('history of an unknown wallet is rejected, not answered with an empty page', async () => {
      // A caller cannot tell "this wallet has no history" from "this wallet does
      // not exist" if one backend throws and the other returns an empty page.
      await rejectsWithCode(backend.history('ghost'), 'UNKNOWN_WALLET');
    });

    // -----------------------------------------------------------------------
    // Input validation that must not differ between backends
    // -----------------------------------------------------------------------

    test('an empty memo nonce is rejected', async () => {
      const alice = await wallet('alice');
      // An empty nonce is not a nonce: it gives no replay protection at all, so
      // it must be refused rather than silently settled un-guarded.
      await rejectsWithCode(backend.mint(alice.id, 10n, memo('Test', '')), 'INVALID_INTENT');
      assert.equal(await backend.getBalance(alice.id), 0n);
    });

    test('createWallet rejects an empty pubkey or address', async () => {
      await rejectsWithCode(
        backend.createWallet('bob', { pubkey: '', address: 'HDaddress' }),
        'INVALID_INTENT',
      );
      await rejectsWithCode(
        backend.createWallet('carol', { pubkey: 'ab'.repeat(32), address: '' }),
        'INVALID_INTENT',
      );
    });

    // -----------------------------------------------------------------------
    // Hash chain
    // -----------------------------------------------------------------------

    test('verifyIntegrity reports ok on a healthy chain', async () => {
      const alice = await wallet('alice');
      const bob = await wallet('bob');

      const empty = await backend.verifyIntegrity();
      assert.equal(empty.ok, true);
      assert.equal(empty.checked, 0);
      assert.deepEqual(empty.brokenAt, []);
      assert.deepEqual(empty.balanceMismatches, []);

      await backend.mint(alice.id, 1000n, memo('Test', 'm1'));
      await backend.transfer(alice.id, bob.id, 300n, memo('Test', 't1'));
      await backend.burn(bob.id, 100n, memo('Test', 'b1'));

      const report = await backend.verifyIntegrity();
      assert.equal(report.ok, true);
      assert.equal(report.checked, 3);
      assert.deepEqual(report.brokenAt, []);
      assert.deepEqual(report.balanceMismatches, []);
    });

    test('each tx links to its predecessor and seq is contiguous from 0', async () => {
      const alice = await wallet('alice');
      const bob = await wallet('bob');

      await backend.mint(alice.id, 1000n, memo('Test', 'm1', 'first'));
      await backend.transfer(alice.id, bob.id, 300n, memo('Test', 't1'));
      await backend.transfer(bob.id, alice.id, 50n, memo('Test', 't2'));
      await backend.burn(alice.id, 25n, memo('Test', 'b1'));

      const txs = await chain([alice.id, bob.id]);
      assert.equal(txs.length, 4);

      let expectedPrev = GENESIS_HASH;
      for (let i = 0; i < txs.length; i++) {
        const tx = at(txs, i);
        assert.equal(tx.seq, i, `seq must be contiguous from 0 (index ${i})`);
        assert.equal(tx.prevHash, expectedPrev, `prevHash must chain (index ${i})`);
        assert.match(tx.hash, /^[0-9a-f]{64}$/);
        assert.notEqual(tx.hash, tx.prevHash);
        expectedPrev = tx.hash;
      }

      assert.equal(at(txs, 0).prevHash, GENESIS_HASH);
    });

    test('memos survive the round trip, including an absent detail', async () => {
      const alice = await wallet('alice');

      const withDetail = await backend.mint(alice.id, 10n, memo('Fine', 'n1', 'speeding'));
      const withoutDetail = await backend.mint(alice.id, 10n, memo('Payout', 'n2'));

      const a = await backend.getTx(withDetail.txId);
      assert.equal(a?.memo.intent, 'Fine');
      assert.equal(a?.memo.detail, 'speeding');
      assert.equal(a?.memo.nonce, 'n1');

      const b = await backend.getTx(withoutDetail.txId);
      assert.equal(b?.memo.intent, 'Payout');
      assert.equal(b?.memo.detail, undefined);
      assert.equal(b?.memo.nonce, 'n2');
    });

    test('checkpoint and verifyIntegrity(checkpoint) agree, and an extension keeps the old one valid', async () => {
      const alice = await wallet('alice');
      assert.equal(await backend.checkpoint(), null);
      assert.equal((await backend.verifyIntegrity()).head, null);

      await backend.mint(alice.id, 10n, memo('Test', 'c1'));
      const cp = await backend.checkpoint();
      assert.notEqual(cp, null);
      assert.equal(cp?.seq, 0);

      await backend.mint(alice.id, 10n, memo('Test', 'c2'));
      const report = await backend.verifyIntegrity(cp ?? undefined);
      assert.equal(report.ok, true);
      assert.equal(report.checkpoint, 'ok');
      assert.equal(report.head?.seq, 1);
      assert.deepEqual(report.violations, []);

      // A checkpoint from a longer, different history is not satisfied by this ledger.
      const ahead = { seq: 5, hash: 'a'.repeat(64) };
      const behind = await backend.verifyIntegrity(ahead);
      assert.equal(behind.checkpoint, 'truncated');
      assert.equal(behind.ok, false);
      const forked = await backend.verifyIntegrity({ seq: 0, hash: 'a'.repeat(64) });
      assert.equal(forked.checkpoint, 'rewritten');
      assert.equal(forked.ok, false);
    });

    test('getTxByNonce returns the tx that consumed the nonce, and null otherwise', async () => {
      const alice = await wallet('alice');
      assert.equal(await backend.getTxByNonce('nope'), null);
      const ref = await backend.mint(alice.id, 10n, memo('Test', 'known'));
      const found = await backend.getTxByNonce('known');
      assert.equal(found?.id, ref.txId);
      assert.equal(found?.hash, ref.hash);
    });

    test('a memo key is accepted once, atomically with the write', async () => {
      const alice = await wallet('alice');
      const keyed: Memo = { intent: 'Test', nonce: 'k1', key: 'welcome:alice' };
      await backend.mint(alice.id, 10n, keyed);

      await rejectsWithCode(
        backend.mint(alice.id, 10n, { intent: 'Test', nonce: 'k2', key: 'welcome:alice' }),
        'DUPLICATE_KEY',
      );
      // A rejected write leaves nothing behind: balance, nonce and history are untouched.
      assert.equal(await backend.getBalance(alice.id), 10n);
      assert.equal(await backend.hasNonce('k2'), false);
      assert.equal((await backend.history(alice.id)).txs.length, 1);

      // A different key is independent.
      await backend.mint(alice.id, 5n, { intent: 'Test', nonce: 'k3', key: 'welcome:bob' });
      assert.equal(await backend.getBalance(alice.id), 15n);
    });

    test('memo key and meta round-trip and are covered by the hash', async () => {
      const alice = await wallet('alice');
      const ref = await backend.mint(alice.id, 10n, {
        intent: 'RentVehicle',
        nonce: 'm1',
        key: 'k',
        meta: { vehicle: 'bike', minutes: '30' },
      });
      const tx = await backend.getTx(ref.txId);
      assert.deepEqual(tx?.memo.meta, { vehicle: 'bike', minutes: '30' });
      assert.equal(tx?.memo.key, 'k');
      assert.deepEqual((await backend.verifyIntegrity()).brokenAt, []);
    });

    test('malformed memos are rejected before anything is written', async () => {
      const alice = await wallet('alice');
      const bad: unknown[] = [
        { intent: '' },
        { intent: 'x'.repeat(65) },
        { intent: 'Test', detail: 'line\nbreak' },
        { intent: 'Test', detail: 'x'.repeat(513) },
        { intent: 'Test', detail: 5 },
        { intent: 'Test', nonce: '' },
        { intent: 'Test', nonce: 'x'.repeat(129) },
        { intent: 'Test', key: '' },
        { intent: 'Test', meta: 'nope' },
        { intent: 'Test', meta: { 'Bad Key': 'v' } },
        { intent: 'Test', meta: { k: 5 } },
        { intent: 'Test', meta: { k: 'a\u0000b' } },
        { intent: 'Test', meta: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, 'v'])) },
        null,
        'a string',
      ];
      for (const m of bad) {
        await rejectsWithCode(backend.mint(alice.id, 1n, m as Memo), 'INVALID_INTENT');
      }
      assert.equal(await backend.getBalance(alice.id), 0n);
      assert.equal((await backend.history(alice.id)).txs.length, 0);
    });

    test('a non-bigint amount is rejected on every write path', async () => {
      const alice = await wallet('alice');
      const bob = await wallet('bob');
      await backend.mint(alice.id, 100n, memo('Test'));
      for (const bad of [5, '5', 5.5, null, undefined, Number.NaN] as unknown[]) {
        await rejectsWithCode(backend.mint(alice.id, bad as bigint, memo('Test')), 'INVALID_AMOUNT');
        await rejectsWithCode(backend.burn(alice.id, bad as bigint, memo('Test')), 'INVALID_AMOUNT');
        await rejectsWithCode(
          backend.transfer(alice.id, bob.id, bad as bigint, memo('Test')),
          'INVALID_AMOUNT',
        );
      }
      assert.equal(await backend.getBalance(alice.id), 100n);
    });

    test('concurrent createWallet for one owner yields one wallet, same id for everyone', async () => {
      const results = await Promise.all(
        Array.from({ length: 12 }, () => backend.createWallet('racer', keyFor('racer'))),
      );
      assert.equal(new Set(results.map((w) => w.id)).size, 1);
      assert.equal((await backend.listWallets()).filter((w) => w.ownerId === 'racer').length, 1);
    });

    test('createWallet rejects a non-string owner id with a typed error', async () => {
      for (const bad of [undefined, null, 5, '']) {
        await rejectsWithCode(backend.createWallet(bad as string, keyFor('x')), 'INVALID_INTENT');
      }
    });

    test('hasNonce is false before settlement and true after', async () => {
      const alice = await wallet('alice');
      assert.equal(await backend.hasNonce('fresh'), false);
      await backend.mint(alice.id, 10n, memo('Test', 'fresh'));
      assert.equal(await backend.hasNonce('fresh'), true);
    });
  });
}

for (const factory of FACTORIES) conformanceSuite(factory);
