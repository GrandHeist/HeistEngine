// Master seed loading and derivation (ADR 0003 part 3). loadMasterSeed touches a real file on
// disk (permissions matter here, so a mock filesystem would miss the actual bug class this
// guards against); deriveWalletSeed is pure HKDF math, tested without touching disk at all.

import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { EngineError } from '../src/errors.ts';
import { DEFAULT_EPOCH, MASTER_SEED_BYTES, deriveWalletSeed, loadMasterSeed } from '../src/engine/masterSeed.ts';

const dir = mkdtempSync(join(tmpdir(), 'heist-seed-'));
after(() => rmSync(dir, { recursive: true, force: true }));

let counter = 0;
function newPath(): string {
  counter += 1;
  return join(dir, `seed-${counter}.hex`);
}

function writeSeedFile(hex: string, mode = 0o600): string {
  const path = newPath();
  writeFileSync(path, hex, { mode });
  chmodSync(path, mode); // writeFileSync's mode is subject to umask; force it.
  return path;
}

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

describe('loadMasterSeed', () => {
  test('loads a valid 64-hex-char file as 32 raw bytes', () => {
    const hex = randomBytes(32).toString('hex');
    const path = writeSeedFile(hex);
    const seed = loadMasterSeed(path);
    assert.equal(seed.length, MASTER_SEED_BYTES);
    assert.equal(seed.toString('hex'), hex);
  });

  test('tolerates a trailing newline', () => {
    const hex = randomBytes(32).toString('hex');
    const path = writeSeedFile(`${hex}\n`);
    assert.equal(loadMasterSeed(path).toString('hex'), hex);
  });

  test('a missing file refuses with MASTER_SEED_MISSING', () => {
    throwsWithCode(() => loadMasterSeed(join(dir, 'does-not-exist.hex')), 'MASTER_SEED_MISSING');
  });

  test('a file with the wrong length refuses with MASTER_SEED_INVALID', () => {
    throwsWithCode(() => loadMasterSeed(writeSeedFile('ab')), 'MASTER_SEED_INVALID');
    throwsWithCode(() => loadMasterSeed(writeSeedFile(`${randomBytes(32).toString('hex')}ff`)), 'MASTER_SEED_INVALID');
  });

  test('a file with non-hex content refuses with MASTER_SEED_INVALID', () => {
    throwsWithCode(() => loadMasterSeed(writeSeedFile('z'.repeat(64))), 'MASTER_SEED_INVALID');
  });

  test('group- or other-readable permissions refuse with MASTER_SEED_INSECURE_PERMISSIONS', () => {
    const hex = randomBytes(32).toString('hex');
    throwsWithCode(() => loadMasterSeed(writeSeedFile(hex, 0o640)), 'MASTER_SEED_INSECURE_PERMISSIONS');
    throwsWithCode(() => loadMasterSeed(writeSeedFile(hex, 0o644)), 'MASTER_SEED_INSECURE_PERMISSIONS');
    throwsWithCode(() => loadMasterSeed(writeSeedFile(hex, 0o666)), 'MASTER_SEED_INSECURE_PERMISSIONS');
  });

  test('owner-only permissions (600 or stricter) are accepted', () => {
    const hex = randomBytes(32).toString('hex');
    assert.doesNotThrow(() => loadMasterSeed(writeSeedFile(hex, 0o600)));
    assert.doesNotThrow(() => loadMasterSeed(writeSeedFile(hex, 0o400)));
  });
});

describe('deriveWalletSeed', () => {
  test('is deterministic: same seed, owner and epoch always derive the same bytes', () => {
    const master = randomBytes(32);
    const a = deriveWalletSeed(master, 'alice', 0);
    const b = deriveWalletSeed(master, 'alice', 0);
    assert.equal(a.toString('hex'), b.toString('hex'));
    assert.equal(a.length, MASTER_SEED_BYTES);
  });

  test('defaults to epoch 0', () => {
    const master = randomBytes(32);
    assert.equal(deriveWalletSeed(master, 'alice').toString('hex'), deriveWalletSeed(master, 'alice', 0).toString('hex'));
    assert.equal(DEFAULT_EPOCH, 0);
  });

  test('different owners derive different seeds', () => {
    const master = randomBytes(32);
    assert.notEqual(deriveWalletSeed(master, 'alice').toString('hex'), deriveWalletSeed(master, 'bob').toString('hex'));
  });

  test('different epochs for the same owner derive different seeds', () => {
    const master = randomBytes(32);
    assert.notEqual(
      deriveWalletSeed(master, 'alice', 0).toString('hex'),
      deriveWalletSeed(master, 'alice', 1).toString('hex'),
    );
  });

  test('different master seeds derive different results for the same owner/epoch', () => {
    assert.notEqual(
      deriveWalletSeed(randomBytes(32), 'alice').toString('hex'),
      deriveWalletSeed(randomBytes(32), 'alice').toString('hex'),
    );
  });

  test('rejects a master seed that is not exactly 32 bytes', () => {
    throwsWithCode(() => deriveWalletSeed(Buffer.from('short'), 'alice'), 'MASTER_SEED_INVALID');
    throwsWithCode(() => deriveWalletSeed(randomBytes(31), 'alice'), 'MASTER_SEED_INVALID');
    throwsWithCode(() => deriveWalletSeed(randomBytes(33), 'alice'), 'MASTER_SEED_INVALID');
  });

  test('rejects an empty ownerId', () => {
    throwsWithCode(() => deriveWalletSeed(randomBytes(32), ''), 'CUSTODY_OWNER_INVALID');
    throwsWithCode(() => deriveWalletSeed(randomBytes(32), '   '), 'CUSTODY_OWNER_INVALID');
  });

  test('rejects a negative or non-integer epoch', () => {
    throwsWithCode(() => deriveWalletSeed(randomBytes(32), 'alice', -1), 'MASTER_SEED_INVALID');
    throwsWithCode(() => deriveWalletSeed(randomBytes(32), 'alice', 1.5), 'MASTER_SEED_INVALID');
  });
});
