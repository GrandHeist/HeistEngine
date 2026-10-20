// Custody tests. The signing round trip matters, but the load-bearing test in
// this file is the on-chain guard: it exists so that deleting the guard in
// src/engine/custody.ts fails loudly instead of quietly enabling real
// private-key custody. See the header block of that file before touching this.

import { randomBytes } from 'node:crypto';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { EngineError } from '../src/errors.ts';
import {
  Custody,
  ONCHAIN_BACKENDS,
  ONCHAIN_CUSTODY_BLOCKED,
  deriveAddress,
  isOnchain,
} from '../src/engine/custody.ts';
import type { BackendName } from '../src/ledger/backend.ts';

function throwsWithCode(fn: () => unknown, code: string): void {
  assert.throws(
    fn,
    (error: unknown) => {
      assert.ok(error instanceof EngineError, `expected an EngineError, got ${String(error)}`);
      assert.equal(error.code, code);
      return true;
    },
    `expected a throw with code ${code}`,
  );
}

describe('Custody — the on-chain guard', () => {
  // If you are reading this because the test failed: the guard was removed.
  // That is only allowed after an ADR in docs/adr/ and explicit human sign-off.
  test('ONCHAIN_CUSTODY_BLOCKED is still true', () => {
    assert.equal(
      ONCHAIN_CUSTODY_BLOCKED,
      true,
      'on-chain custody must stay unimplemented — see src/engine/custody.ts',
    );
  });

  test('constructing Custody for solana throws ONCHAIN_CUSTODY_BLOCKED', () => {
    throwsWithCode(() => new Custody('solana'), 'ONCHAIN_CUSTODY_BLOCKED');
  });

  test('every backend listed as on-chain is refused, and no other', () => {
    assert.deepEqual([...ONCHAIN_BACKENDS].sort(), ['solana']);

    for (const backend of ONCHAIN_BACKENDS) {
      assert.equal(isOnchain(backend), true);
      throwsWithCode(() => new Custody(backend), 'ONCHAIN_CUSTODY_BLOCKED');
    }

    const offchain: readonly BackendName[] = ['memory', 'sqlite', 'postgres'];
    for (const backend of offchain) {
      assert.equal(isOnchain(backend), false);
      const custody = new Custody(backend);
      assert.equal(custody.backend, backend);
    }
  });

  test('no key material is created for an on-chain backend', () => {
    // The guard is in the constructor precisely so no instance — and therefore
    // no key — can exist in on-chain mode.
    let instance: Custody | undefined;
    assert.throws(() => {
      instance = new Custody('solana');
    });
    assert.equal(instance, undefined);
  });
});

describe('Custody — keys and signing', () => {
  test('createKeypair returns a 32-byte hex pubkey, an address and a PKCS#8 PEM', () => {
    const custody = new Custody('memory');
    const keypair = custody.createKeypair('alice');

    assert.match(keypair.pubkey, /^[0-9a-f]{64}$/);
    assert.equal(keypair.address, deriveAddress(keypair.pubkey));
    assert.match(keypair.privateKeyPem, /^-----BEGIN PRIVATE KEY-----/);

    assert.equal(custody.has('alice'), true);
    assert.equal(custody.pubkeyOf('alice'), keypair.pubkey);
    assert.equal(custody.addressOf('alice'), keypair.address);
  });

  test('unknown owners have no key, pubkey or address', () => {
    const custody = new Custody('memory');
    assert.equal(custody.has('nobody'), false);
    assert.equal(custody.pubkeyOf('nobody'), null);
    assert.equal(custody.addressOf('nobody'), null);
  });

  test('createKeypair refuses to overwrite an existing key', () => {
    const custody = new Custody('memory');
    custody.createKeypair('alice');
    throwsWithCode(() => custody.createKeypair('alice'), 'CUSTODY_KEY_EXISTS');
  });

  test('each owner gets a distinct keypair', () => {
    const custody = new Custody('memory');
    const alice = custody.createKeypair('alice');
    const bob = custody.createKeypair('bob');
    assert.notEqual(alice.pubkey, bob.pubkey);
    assert.notEqual(alice.address, bob.address);
  });

  test('sign / verify round-trips', () => {
    const custody = new Custody('memory');
    const keypair = custody.createKeypair('alice');
    const payload = 'kind="transfer"\namount="9007199254740993000"';

    const signature = custody.sign('alice', payload);
    assert.match(signature, /^[0-9a-f]{128}$/);
    assert.equal(custody.verify(keypair.pubkey, payload, signature), true);
  });

  test('a tampered payload fails verification', () => {
    const custody = new Custody('memory');
    const keypair = custody.createKeypair('alice');
    const payload = 'amount="100"';
    const signature = custody.sign('alice', payload);

    assert.equal(custody.verify(keypair.pubkey, payload, signature), true);
    assert.equal(custody.verify(keypair.pubkey, 'amount="1000"', signature), false);
    assert.equal(custody.verify(keypair.pubkey, `${payload} `, signature), false);
    assert.equal(custody.verify(keypair.pubkey, '', signature), false);
  });

  test('a tampered signature or a foreign pubkey fails verification', () => {
    const custody = new Custody('memory');
    const alice = custody.createKeypair('alice');
    const bob = custody.createKeypair('bob');
    const payload = 'amount="100"';
    const signature = custody.sign('alice', payload);

    assert.equal(custody.verify(bob.pubkey, payload, signature), false);

    const flipped = `${signature.slice(0, -1)}${signature.endsWith('0') ? '1' : '0'}`;
    assert.equal(custody.verify(alice.pubkey, payload, flipped), false);

    // Malformed inputs must be a `false`, never a throw — an auditor feeding in
    // junk should get "not verified", not a crash.
    assert.equal(custody.verify('not-hex', payload, signature), false);
    assert.equal(custody.verify(alice.pubkey, payload, 'not-hex'), false);
    assert.equal(custody.verify('', payload, signature), false);
    assert.equal(custody.verify(alice.pubkey, payload, ''), false);
    assert.equal(custody.verify('ab'.repeat(10), payload, signature), false);
  });

  test('signing without a key is refused', () => {
    const custody = new Custody('memory');
    throwsWithCode(() => custody.sign('nobody', 'payload'), 'CUSTODY_KEY_MISSING');
  });

  test('an empty ownerId is refused', () => {
    const custody = new Custody('memory');
    throwsWithCode(() => custody.createKeypair(''), 'CUSTODY_OWNER_INVALID');
    throwsWithCode(() => custody.createKeypair('   '), 'CUSTODY_OWNER_INVALID');
  });

  test('importKeypair restores the same public identity', () => {
    const first = new Custody('memory');
    const original = first.createKeypair('alice');

    const restored = new Custody('memory').importKeypair('alice', original.privateKeyPem);
    assert.equal(restored.pubkey, original.pubkey);
    assert.equal(restored.address, original.address);
  });

  test('importKeypair rejects junk that is not a private key', () => {
    const custody = new Custody('memory');
    throwsWithCode(() => custody.importKeypair('alice', 'not a pem'), 'CUSTODY_KEY_INVALID');
  });

  test('clear() forgets every key', () => {
    const custody = new Custody('memory');
    custody.createKeypair('alice');
    custody.clear();
    assert.equal(custody.has('alice'), false);
    // ...and the owner can be re-keyed afterwards.
    assert.doesNotThrow(() => custody.createKeypair('alice'));
  });
});

describe('Custody — master seed (ADR 0003 part 3)', () => {
  test('with no seed, hasMasterSeed is false and keys stay random across instances', () => {
    const custody = new Custody('memory');
    assert.equal(custody.hasMasterSeed, false);
    const a = custody.createKeypair('alice');
    const b = new Custody('memory').createKeypair('alice');
    assert.notEqual(a.pubkey, b.pubkey, 'random generation must not accidentally collide or be deterministic');
  });

  test('with a seed, the same owner derives the identical key on a fresh instance', () => {
    const seed = randomBytes(32);
    const first = new Custody('memory', { masterSeed: seed });
    const a1 = first.createKeypair('alice');

    const second = new Custody('memory', { masterSeed: seed });
    assert.equal(second.hasMasterSeed, true);
    assert.equal(second.reconcileExistingWallet('alice', a1.pubkey), undefined);
    assert.equal(second.pubkeyOf('alice'), a1.pubkey);
    assert.equal(second.addressOf('alice'), a1.address);
  });

  test('with a seed, different owners derive different keys', () => {
    const custody = new Custody('memory', { masterSeed: randomBytes(32) });
    const alice = custody.createKeypair('alice');
    const bob = custody.createKeypair('bob');
    assert.notEqual(alice.pubkey, bob.pubkey);
  });

  test('with a seed, a different epoch for the same owner derives a different key', () => {
    const seed = randomBytes(32);
    const epoch0 = new Custody('memory', { masterSeed: seed }).createKeypair('alice');

    // reconcileExistingWallet derives at the given epoch and compares; asking it to match
    // epoch 0's pubkey while reconciling at epoch 1 must mismatch if epochs truly differ.
    throwsWithCode(
      () => new Custody('memory', { masterSeed: seed }).reconcileExistingWallet('alice', epoch0.pubkey, 1),
      'CUSTODY_KEY_MISMATCH',
    );
  });

  test('reconcileExistingWallet with the wrong seed refuses with CUSTODY_KEY_MISMATCH', () => {
    const original = new Custody('memory', { masterSeed: randomBytes(32) }).createKeypair('alice');
    const wrongSeedCustody = new Custody('memory', { masterSeed: randomBytes(32) });

    throwsWithCode(() => wrongSeedCustody.reconcileExistingWallet('alice', original.pubkey), 'CUSTODY_KEY_MISMATCH');
  });

  test('reconcileExistingWallet with no seed configured refuses with MASTER_SEED_MISSING', () => {
    const original = new Custody('memory', { masterSeed: randomBytes(32) }).createKeypair('alice');
    const noSeedCustody = new Custody('memory');

    throwsWithCode(() => noSeedCustody.reconcileExistingWallet('alice', original.pubkey), 'MASTER_SEED_MISSING');
  });

  test('reconcileExistingWallet is a no-op if the owner is already loaded', () => {
    const custody = new Custody('memory', { masterSeed: randomBytes(32) });
    const alice = custody.createKeypair('alice');
    // A mismatched expected pubkey here would throw if it actually re-derived; it must not,
    // because the key is already loaded from createKeypair above.
    assert.doesNotThrow(() => custody.reconcileExistingWallet('alice', 'not-even-hex'));
    assert.equal(custody.pubkeyOf('alice'), alice.pubkey);
  });

  test('constructing with a wrong-length seed is refused', () => {
    throwsWithCode(() => new Custody('memory', { masterSeed: Buffer.from('tooshort') }), 'MASTER_SEED_INVALID');
  });

  test('derived keys still sign and verify like random ones', () => {
    const custody = new Custody('memory', { masterSeed: randomBytes(32) });
    const keypair = custody.createKeypair('alice');
    const payload = 'kind="transfer"';
    const signature = custody.sign('alice', payload);
    assert.equal(custody.verify(keypair.pubkey, payload, signature), true);
  });
});

describe('deriveAddress', () => {
  test('is deterministic and 42 characters long', () => {
    const custody = new Custody('memory');
    const keypair = custody.createKeypair('alice');

    const once = deriveAddress(keypair.pubkey);
    const twice = deriveAddress(keypair.pubkey);

    assert.equal(once, twice);
    assert.equal(once.length, 42, 'HD + 40 hex characters');
    assert.match(once, /^HD[0-9a-f]{40}$/);
  });

  test('is stable across hex casing, because it digests the raw key bytes', () => {
    const custody = new Custody('memory');
    const keypair = custody.createKeypair('alice');
    assert.equal(deriveAddress(keypair.pubkey.toUpperCase()), deriveAddress(keypair.pubkey));
  });

  test('different keys derive different addresses', () => {
    const custody = new Custody('memory');
    const a = custody.createKeypair('alice');
    const b = custody.createKeypair('bob');
    assert.notEqual(deriveAddress(a.pubkey), deriveAddress(b.pubkey));
  });

  test('rejects anything that is not a 32-byte hex key', () => {
    throwsWithCode(() => deriveAddress('ab'), 'CUSTODY_KEY_INVALID');
    throwsWithCode(() => deriveAddress('zz'.repeat(32)), 'CUSTODY_KEY_INVALID');
    throwsWithCode(() => deriveAddress(''), 'CUSTODY_KEY_INVALID');
    throwsWithCode(() => deriveAddress('ab'.repeat(33)), 'CUSTODY_KEY_INVALID');
  });
});
