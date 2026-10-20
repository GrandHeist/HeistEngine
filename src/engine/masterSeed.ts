// MASTER SEED — loads the one secret every wallet's signing key derives from
// (ADR 0003 part 3, option 1: HKDF from a master seed). This file never
// creates or stores a private key itself; it only reads and derives raw seed
// bytes. Custody turns a derived seed into an actual ed25519 key.
//
// The seed file must live OUTSIDE this repo and outside the ledger's database
// directory (ADR 0003: "a leaked ledger backup must not also leak the seed").
// Back it up separately from the ledger. Losing it is unrecoverable for
// signing — ledger history stays readable and verifiable, but nothing already
// using the lost seed can be signed again, and existing signed rows still
// verify against their stored pubkeys.
//
// On-disk format: exactly 64 hex characters (32 bytes), optionally followed by
// trailing whitespace/newline. Hex, not raw binary, so the file is printable,
// easy to check the length of, and safe to move through a text-based secret
// manager — the same convention as every other hex value in this codebase
// (pubkeys, addresses, signatures).

import { readFileSync, statSync } from 'node:fs';
import { hkdfSync } from 'node:crypto';
import { EngineError } from '../errors.ts';
import type { OwnerId } from '../types.ts';

/** Exact byte length of a valid master seed. */
export const MASTER_SEED_BYTES = 32;

/** Fixed, versioned HKDF salt (ADR 0003 part 3). Changing this re-derives every key. */
const HKDF_SALT = Buffer.from('heist-wallet-v1', 'utf8');

/**
 * v1 always derives at epoch 0 — no rotation table exists yet (ADR 0003 part 3
 * leaves rotation open). Reserved as an explicit parameter from day one so a
 * future rotation scheme changes a stored epoch number, not this function.
 */
export const DEFAULT_EPOCH = 0;

/**
 * Read the master seed from a file. Refuses to return anything on a missing
 * file, a wrong length, or (on POSIX) permissions that let group/other read
 * or write it — a `chmod 600` file is the whole point of this storage choice,
 * so a looser mode is treated the same as a missing seed: signing cannot
 * start safely.
 */
export function loadMasterSeed(path: string): Buffer {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new EngineError(
      'MASTER_SEED_MISSING',
      `Could not read the master seed file at "${path}": ` +
        `${cause instanceof Error ? cause.message : String(cause)}. Signing cannot start without it — ` +
        `see ADR 0003 part 3.`,
    );
  }

  try {
    const mode = statSync(path).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      throw new EngineError(
        'MASTER_SEED_INSECURE_PERMISSIONS',
        `The master seed file at "${path}" is readable or writable by group/other ` +
          `(mode 0${mode.toString(8)}). Run "chmod 600 ${path}" before starting.`,
      );
    }
  } catch (cause) {
    if (cause instanceof EngineError) throw cause;
    // statSync failing right after a successful readFileSync would be very unusual
    // (e.g. a race with deletion); treat it the same as a missing file.
    throw new EngineError(
      'MASTER_SEED_MISSING',
      `Could not check permissions on the master seed file at "${path}": ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  const trimmed = raw.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new EngineError(
      'MASTER_SEED_INVALID',
      `The master seed file at "${path}" must contain exactly 64 hex characters (32 bytes), ` +
        `optionally with trailing whitespace. Got ${trimmed.length} non-whitespace characters.`,
    );
  }
  return Buffer.from(trimmed, 'hex');
}

/**
 * Derive the 32-byte seed for one wallet's ed25519 key:
 * HKDF-SHA256(masterSeed, salt="heist-wallet-v1", info = ownerId + epoch).
 * Deterministic — the same (masterSeed, ownerId, epoch) always yields the
 * same bytes. That determinism is the entire feature: it lets a restart
 * reproduce every wallet's key from the seed alone, with nothing per-wallet
 * stored anywhere.
 */
export function deriveWalletSeed(masterSeed: Buffer, ownerId: OwnerId, epoch: number = DEFAULT_EPOCH): Buffer {
  if (masterSeed.length !== MASTER_SEED_BYTES) {
    throw new EngineError(
      'MASTER_SEED_INVALID',
      `Master seed must be ${MASTER_SEED_BYTES} bytes, got ${masterSeed.length}`,
    );
  }
  if (typeof ownerId !== 'string' || ownerId.trim() === '') {
    throw new EngineError('CUSTODY_OWNER_INVALID', 'ownerId must be a non-empty string');
  }
  if (!Number.isInteger(epoch) || epoch < 0) {
    throw new EngineError('MASTER_SEED_INVALID', `epoch must be a non-negative integer, got ${String(epoch)}`);
  }
  // A NUL separator keeps ("ab", 1) distinguishable from ("ab1", undefined) etc. — string
  // concatenation alone could let two different (ownerId, epoch) pairs collide on the same info.
  const info = Buffer.from(`${ownerId}\u0000${epoch}`, 'utf8');
  return Buffer.from(hkdfSync('sha256', masterSeed, HKDF_SALT, info, MASTER_SEED_BYTES));
}
