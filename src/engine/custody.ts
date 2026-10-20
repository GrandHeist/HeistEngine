// ===========================================================================
// CUSTODY — ed25519 signing keys for wallets. READ THIS BEFORE CHANGING IT.
// ===========================================================================
//
// WHY THIS FILE REFUSES TO RUN ON-CHAIN
//
// The project rules forbid this codebase from handling, generating,
// requesting, or storing private keys, seed phrases, wallet files, or real
// funds. That rule is absolute and this module is the exact place it would be
// violated, so the guard lives here, in the constructor, before any key
// material can exist.
//
//   * OFF-CHAIN MODE ('memory' | 'sqlite' | 'postgres') is ALLOWED.
//     The keypair signs rows in a local database. Those rows represent HD —
//     a non-redeemable in-game currency with no on/off-ramp, no market, and no
//     bearer property (see SPEC "Non-goals (v1)"). A key here authenticates
//     "this wallet authorised this ledger row" and nothing else. If the key
//     leaks, the worst case is forged history in a friends-only game server,
//     which the hash chain makes detectable. This is a SIGNING SCHEME, NOT A
//     WALLET.
//
//   * ON-CHAIN MODE ('solana') is BLOCKED, deliberately and
//     permanently until a human says otherwise. There, the identical keypair
//     would control real transferable on-chain assets — SPL tokens —
//     and the engine would be a custodian of bearer instruments for every
//     player on the server. That is real private-key custody. It is not a
//     thing this agent gets to switch on.
//
// TO ENABLE ON-CHAIN CUSTODY a human must, in this order:
//   1. Write an ADR in docs/adr/ covering key generation, encryption at rest,
//      the master-key/KMS story, rotation, backup/recovery (SPEC open
//      question 6), and the blast radius of a compromise.
//   2. Get explicit written sign-off from the project owner.
//   3. Only then remove this guard, in a reviewed commit of its own.
// Do not delete the guard to make a test pass. Do not route around it in
// engine.ts. The test asserting ONCHAIN_CUSTODY_BLOCKED exists to catch that.
//
// STORAGE STATUS (per SPEC "Custody"):
//   v0 (this file): keys in an in-memory Map. They die with the process.
//   v1 (TODO):      encrypted-at-rest KV — private keys encrypted with a server
//                   master key held outside the repo, loaded via env/KMS.
//   v2 (TODO):      MPC / threshold signatures so no single key can move funds.
// The public surface of this class is already shaped for v1 and v2: callers
// only ever pass an ownerId and get a signature back, so swapping the Map for
// an encrypted KV store or a remote MPC signer changes nothing outside.
// ===========================================================================

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { EngineError } from '../errors.ts';
import type { BackendName } from '../ledger/backend.ts';
import type { OwnerId } from '../types.ts';
import { DEFAULT_EPOCH, deriveWalletSeed } from './masterSeed.ts';

/**
 * Asserted by tests: on-chain custody is intentionally unimplemented.
 * If this is ever flipped to false, the guard below must already have been
 * removed under an ADR + human sign-off. See the header block.
 */
export const ONCHAIN_CUSTODY_BLOCKED = true;

/** Backends for which key generation is refused outright. */
export const ONCHAIN_BACKENDS: readonly BackendName[] = ['solana'];

/** Prefix on every derived address, so an HD address is recognisable on sight. */
const ADDRESS_PREFIX = 'HD';

/** Hex length of the address body. 20 bytes of sha256(pubkey). */
const ADDRESS_BODY_HEX_LEN = 40;

/** DER prefix for an ed25519 SPKI public key. The raw 32-byte key follows it. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * DER prefix for an ed25519 PKCS#8 private key (RFC 8410 appendix A). The raw
 * 32-byte seed follows it. For ed25519 the "private key" IS the 32-byte seed —
 * there is nothing else to derive it from, which is exactly why HKDF output
 * can be imported directly as one.
 */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** Raw ed25519 public key size in bytes. */
const ED25519_PUBKEY_BYTES = 32;

/** Raw ed25519 private key seed size in bytes. */
const ED25519_SEED_BYTES = 32;

export interface Keypair {
  /** Raw ed25519 public key, hex. Matches Wallet.pubkey in types.ts. */
  pubkey: string;
  /** Deterministic display address: 'HD' + sha256(pubkey).hex.slice(0, 40). */
  address: string;
  /**
   * PKCS#8 PEM of the private key. Returned so a caller can hand it to the v1
   * encrypted-KV store. NEVER log this, never put it in a memo, never return it
   * over the adapter HTTP surface.
   */
  privateKeyPem: string;
}

interface StoredKey {
  privateKey: KeyObject;
  pubkeyHex: string;
  address: string;
}

/**
 * v1 (this file, ADR 0003 part 3): a 32-byte secret, read once at process start
 * (see masterSeed.ts), that every wallet's key derives from via HKDF. Nothing
 * per-wallet is stored — a restart reproduces every key from the seed alone.
 * v2 (TODO): encrypted-at-rest per-wallet store, or MPC — see the header block.
 */
export interface CustodyOptions {
  masterSeed?: Buffer;
}

export class Custody {
  readonly backend: BackendName;
  readonly #masterSeed: Buffer | undefined;

  /**
   * Process-local cache of loaded keys. With a master seed configured, a key
   * in here was either just derived (createKeypair, a new wallet) or
   * reconciled against the ledger's stored pubkey (reconcileExistingWallet,
   * a restart) — never stored anywhere itself.
   * TODO(v2): replace with an MPC threshold signer; `sign` becomes async.
   */
  readonly #keys = new Map<OwnerId, StoredKey>();

  constructor(backend: BackendName, options?: CustodyOptions) {
    if (isOnchain(backend)) {
      throw new EngineError(
        'ONCHAIN_CUSTODY_BLOCKED',
        `On-chain custody is deliberately not implemented (backend "${backend}"). ` +
          `Enabling it would make this engine hold private keys that control real ` +
          `on-chain assets on behalf of every player — real key custody of bearer ` +
          `instruments, which this project forbids. Off-chain backends ` +
          `(memory | sqlite | postgres) sign rows in a local database for HD, a ` +
          `non-redeemable in-game currency; that is a signing scheme, not a wallet. ` +
          `Turning this on requires an ADR in docs/adr/ and explicit human sign-off ` +
          `first. Do not remove this guard to make something pass.`,
      );
    }
    this.backend = backend;
    if (options?.masterSeed !== undefined && options.masterSeed.length !== ED25519_SEED_BYTES) {
      throw new EngineError(
        'MASTER_SEED_INVALID',
        `Master seed must be ${ED25519_SEED_BYTES} bytes, got ${options.masterSeed.length}`,
      );
    }
    this.#masterSeed = options?.masterSeed;
  }

  /**
   * True if this instance derives keys deterministically from a master seed
   * (ADR 0003 part 3) instead of generating random ones. Callers use this to
   * decide whether boot-time reconciliation (reconcileExistingWallet) applies
   * at all — an instance with no seed configured behaves exactly as before
   * this feature existed (random keys, lost on restart, no reconciliation).
   */
  get hasMasterSeed(): boolean {
    return this.#masterSeed !== undefined;
  }

  /**
   * Create a keypair for a NEW owner and remember it. With a master seed
   * configured (ADR 0003 part 3), the key is derived deterministically — the
   * same owner on a fresh process with the same seed gets the identical key,
   * which is what lets a restart carry on signing for wallets it already
   * created. With no seed configured, the key is random and lost on restart,
   * exactly as before this feature existed (fine for the memory backend's
   * tests and dry runs).
   * Unreachable in on-chain mode — the constructor throws before an instance
   * exists, so no on-chain key material is ever created.
   */
  createKeypair(ownerId: OwnerId): Keypair {
    assertOwnerId(ownerId);
    if (this.#keys.has(ownerId)) {
      throw new EngineError(
        'CUSTODY_KEY_EXISTS',
        `Owner "${ownerId}" already has a custodial key. Refusing to overwrite it — ` +
          `that would orphan every signature already in the ledger.`,
      );
    }

    const stored =
      this.#masterSeed === undefined
        ? randomStoredKey()
        : keypairFromSeed(deriveWalletSeed(this.#masterSeed, ownerId, DEFAULT_EPOCH));
    this.#keys.set(ownerId, stored);

    return {
      pubkey: stored.pubkeyHex,
      address: stored.address,
      privateKeyPem: stored.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    };
  }

  /**
   * Boot-time reconciliation for a wallet that ALREADY exists in the ledger
   * (ADR 0003 part 3): derive this owner's key from the master seed, and load
   * it into the cache only if the derived pubkey matches what the ledger
   * already has stored for it. A mismatch — or no master seed configured at
   * all — is a startup failure, never a silent re-key: a wrong or missing key
   * here means every future signature for this wallet would fail to verify
   * against its already-stored pubkey.
   * No-op if this owner's key is already loaded this process.
   */
  reconcileExistingWallet(ownerId: OwnerId, storedPubkeyHex: string, epoch: number = DEFAULT_EPOCH): void {
    assertOwnerId(ownerId);
    if (this.#keys.has(ownerId)) return;
    if (this.#masterSeed === undefined) {
      throw new EngineError(
        'MASTER_SEED_MISSING',
        `Owner "${ownerId}" already has a wallet in the ledger, but no master seed is configured, ` +
          `so its signing key cannot be reproduced. Refusing to start — see ADR 0003 part 3.`,
      );
    }
    const stored = keypairFromSeed(deriveWalletSeed(this.#masterSeed, ownerId, epoch));
    if (stored.pubkeyHex !== storedPubkeyHex) {
      throw new EngineError(
        'CUSTODY_KEY_MISMATCH',
        `Owner "${ownerId}"'s key, derived from the configured master seed at epoch ${epoch}, does not ` +
          `match its pubkey already stored in the ledger. The seed may be wrong, or this wallet predates ` +
          `the current seed/epoch. Refusing to start rather than sign with a key that will not verify — ` +
          `see ADR 0003 part 3.`,
      );
    }
    this.#keys.set(ownerId, stored);
  }

  /** True if this owner has a custodial key in this process. */
  has(ownerId: OwnerId): boolean {
    return this.#keys.has(ownerId);
  }

  /** Public key (hex) for an owner, or null if unknown. */
  pubkeyOf(ownerId: OwnerId): string | null {
    return this.#keys.get(ownerId)?.pubkeyHex ?? null;
  }

  /** Derived address for an owner, or null if unknown. */
  addressOf(ownerId: OwnerId): string | null {
    return this.#keys.get(ownerId)?.address ?? null;
  }

  /**
   * Import an existing key for an owner. This is the seam the v1 encrypted-KV
   * store plugs into on restart: decrypt, then import. It never generates.
   */
  importKeypair(ownerId: OwnerId, privateKeyPem: string): Keypair {
    assertOwnerId(ownerId);
    if (this.#keys.has(ownerId)) {
      throw new EngineError(
        'CUSTODY_KEY_EXISTS',
        `Owner "${ownerId}" already has a custodial key loaded.`,
      );
    }

    let privateKey: KeyObject;
    try {
      privateKey = createPrivateKey(privateKeyPem);
    } catch (cause) {
      throw new EngineError(
        'CUSTODY_KEY_INVALID',
        `Could not import a private key for "${ownerId}": ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    if (privateKey.asymmetricKeyType !== 'ed25519') {
      throw new EngineError(
        'CUSTODY_KEY_INVALID',
        `Custodial keys must be ed25519, got ${String(privateKey.asymmetricKeyType)}`,
      );
    }

    const pubkeyHex = rawPubkeyHex(createPublicKey(privateKey));
    const address = deriveAddress(pubkeyHex);
    this.#keys.set(ownerId, { privateKey, pubkeyHex, address });

    return { pubkey: pubkeyHex, address, privateKeyPem };
  }

  /**
   * Sign a canonical payload with the owner's custodial key.
   * Returns a hex signature, matching Tx.signature in types.ts.
   */
  sign(ownerId: OwnerId, payload: string): string {
    const stored = this.#keys.get(ownerId);
    if (stored === undefined) {
      throw new EngineError(
        'CUSTODY_KEY_MISSING',
        `No custodial key for owner "${ownerId}". Call createKeypair first — an ` +
          `unsigned ledger row is not allowed.`,
      );
    }
    // ed25519 takes no digest algorithm; null is correct here.
    return sign(null, Buffer.from(payload, 'utf8'), stored.privateKey).toString('hex');
  }

  /**
   * Verify a signature against a raw hex ed25519 public key. Static-ish by
   * nature — it needs no stored key, so auditors can verify the whole ledger
   * with only the public data.
   */
  verify(pubkey: string, payload: string, signature: string): boolean {
    let publicKey: KeyObject;
    let sigBytes: Buffer;
    try {
      publicKey = publicKeyFromHex(pubkey);
      sigBytes = fromHex(signature, 'signature');
    } catch {
      return false;
    }
    try {
      return verify(null, Buffer.from(payload, 'utf8'), publicKey, sigBytes);
    } catch {
      return false;
    }
  }

  /** Forget every key in this process. Test hygiene only. */
  clear(): void {
    this.#keys.clear();
  }
}

// ---------------------------------------------------------------------------
// Pure helpers — exported where the engine and tests need them.
// ---------------------------------------------------------------------------

export function isOnchain(backend: BackendName): boolean {
  return ONCHAIN_BACKENDS.includes(backend);
}

/**
 * 'HD' + sha256(pubkey).hex.slice(0, 40).
 * The digest is taken over the RAW PUBLIC KEY BYTES (not the hex text), so the
 * derivation is stable regardless of hex casing. Deterministic: the same pubkey
 * always yields the same address.
 */
export function deriveAddress(pubkeyHex: string): string {
  const raw = fromHex(pubkeyHex, 'pubkey');
  if (raw.length !== ED25519_PUBKEY_BYTES) {
    throw new EngineError(
      'CUSTODY_KEY_INVALID',
      `Expected a ${ED25519_PUBKEY_BYTES}-byte ed25519 public key, got ${raw.length} bytes`,
    );
  }
  const digest = createHash('sha256').update(raw).digest('hex');
  return ADDRESS_PREFIX + digest.slice(0, ADDRESS_BODY_HEX_LEN);
}

/** A fresh random ed25519 keypair, wrapped as a StoredKey. The pre-seed-derivation default. */
function randomStoredKey(): StoredKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubkeyHex = rawPubkeyHex(publicKey);
  return { privateKey, pubkeyHex, address: deriveAddress(pubkeyHex) };
}

/**
 * Import a raw 32-byte ed25519 seed as a private key and wrap it as a
 * StoredKey. For ed25519 the "private key" and the "seed" are the same 32
 * bytes (RFC 8032) — this just wraps them in the PKCS#8 DER shape node's
 * crypto module requires to import one, mirroring publicKeyFromHex below.
 */
function keypairFromSeed(seed: Buffer): StoredKey {
  if (seed.length !== ED25519_SEED_BYTES) {
    throw new EngineError(
      'MASTER_SEED_INVALID',
      `Expected a ${ED25519_SEED_BYTES}-byte ed25519 seed, got ${seed.length} bytes`,
    );
  }
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const pubkeyHex = rawPubkeyHex(createPublicKey(privateKey));
  return { privateKey, pubkeyHex, address: deriveAddress(pubkeyHex) };
}

/** Rebuild a node KeyObject from a raw hex ed25519 public key. */
function publicKeyFromHex(pubkeyHex: string): KeyObject {
  const raw = fromHex(pubkeyHex, 'pubkey');
  if (raw.length !== ED25519_PUBKEY_BYTES) {
    throw new EngineError(
      'CUSTODY_KEY_INVALID',
      `Expected a ${ED25519_PUBKEY_BYTES}-byte ed25519 public key, got ${raw.length} bytes`,
    );
  }
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

/** Extract the raw 32-byte public key from a node ed25519 KeyObject, as hex. */
function rawPubkeyHex(publicKey: KeyObject): string {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return Buffer.from(der.subarray(der.length - ED25519_PUBKEY_BYTES)).toString('hex');
}

function fromHex(value: string, field: string): Buffer {
  if (typeof value !== 'string' || value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(value)) {
    throw new EngineError('CUSTODY_KEY_INVALID', `${field} is not a hex string`);
  }
  return Buffer.from(value, 'hex');
}

function assertOwnerId(ownerId: OwnerId): void {
  if (typeof ownerId !== 'string' || ownerId.trim() === '') {
    throw new EngineError('CUSTODY_OWNER_INVALID', 'ownerId must be a non-empty string');
  }
}
