// In-process ledger backend. It is the reference implementation: every
// invariant the durable backends must enforce is enforced here, in plain
// TypeScript, with no storage layer to hide behind. Tests and the sim run
// against this; nothing about it may be backend-specific.

import { randomUUID } from 'node:crypto';

import type { Memo, OwnerId, Tx, TxId, TxKind, TxRef, Wallet, WalletId } from '../types.ts';
import {
  DuplicateKey,
  DuplicateNonce,
  InsufficientFunds,
  InvalidAmount,
  InvalidIntent,
  UnknownWallet,
} from '../errors.ts';
import type {
  BackendName,
  CreateWalletOptions,
  HistoryPage,
  IntegrityReport,
  LedgerBackend,
  WalletKeyInfo,
} from './backend.ts';
import {
  GENESIS_HASH,
  canonicalTxPayload,
  cloneMemo,
  compareCheckpoint,
  hashTx,
  headOf,
  validateMemo,
  verifyChain,
  verifyStructure,
} from './hashchain.ts';
import type { Checkpoint } from './hashchain.ts';

const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 500;

/** Defensive copy — callers must never be able to mutate ledger state. */
function cloneTx(tx: Tx): Tx {
  return { ...tx, memo: cloneMemo(tx.memo) };
}

function cloneWallet(wallet: Wallet): Wallet {
  return { ...wallet };
}

function encodeCursor(nextSeq: number): string {
  return Buffer.from(JSON.stringify({ s: nextSeq }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidIntent(`Malformed history cursor ${JSON.stringify(cursor)}`);
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('s' in parsed) ||
    typeof (parsed as { s: unknown }).s !== 'number' ||
    !Number.isSafeInteger((parsed as { s: number }).s)
  ) {
    throw new InvalidIntent(`Malformed history cursor ${JSON.stringify(cursor)}`);
  }
  return (parsed as { s: number }).s;
}

function normalizeLimit(limit?: number): number {
  if (limit === undefined) return DEFAULT_HISTORY_LIMIT;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new InvalidIntent(`History limit must be a positive integer, got ${String(limit)}`);
  }
  return Math.min(limit, MAX_HISTORY_LIMIT);
}

interface AppendSpec {
  kind: TxKind;
  from: WalletId | null;
  to: WalletId | null;
  amount: bigint;
  memo: Memo;
}

export class MemoryBackend implements LedgerBackend {
  readonly name: BackendName = 'memory';

  private readonly wallets = new Map<WalletId, Wallet>();
  private readonly walletsByOwner = new Map<OwnerId, WalletId>();
  private readonly balances = new Map<WalletId, bigint>();
  private readonly txs: Tx[] = [];
  private readonly txsById = new Map<TxId, Tx>();
  /** nonce -> id of the tx that consumed it. */
  private readonly nonces = new Map<string, TxId>();
  private readonly keys = new Set<string>();

  // No storage to provision and no handles to release, but the interface is the
  // contract: callers call these regardless of which backend they hold.
  async init(): Promise<void> {
    return;
  }

  async close(): Promise<void> {
    return;
  }

  // -------------------------------------------------------------------------
  // Wallets
  // -------------------------------------------------------------------------

  /**
   * The ledger never mints key material: Custody hands us the public half and we
   * store exactly that. Idempotent per owner — a second call returns the wallet
   * that already exists, matching the durable backends.
   */
  async createWallet(
    ownerId: OwnerId,
    key: WalletKeyInfo,
    opts?: CreateWalletOptions,
  ): Promise<Wallet> {
    if (typeof ownerId !== 'string' || ownerId.length === 0 || !ownerId.isWellFormed()) {
      throw new InvalidIntent('ownerId must be a non-empty, well-formed string');
    }
    if (key === null || typeof key !== 'object') {
      throw new InvalidIntent('key must be a WalletKeyInfo');
    }
    if (typeof key.pubkey !== 'string' || key.pubkey.length === 0) {
      throw new InvalidIntent('key.pubkey must be a non-empty string');
    }
    if (typeof key.address !== 'string' || key.address.length === 0) {
      throw new InvalidIntent('key.address must be a non-empty string');
    }

    const existingId = this.walletsByOwner.get(ownerId);
    if (existingId !== undefined) {
      const existing = this.wallets.get(existingId);
      if (existing !== undefined) return cloneWallet(existing);
    }

    const wallet: Wallet = {
      id: randomUUID(),
      ownerId,
      address: key.address,
      pubkey: key.pubkey,
      isEntity: opts?.isEntity ?? false,
      createdAt: new Date().toISOString(),
    };

    this.wallets.set(wallet.id, wallet);
    this.walletsByOwner.set(ownerId, wallet.id);
    this.balances.set(wallet.id, 0n);

    return cloneWallet(wallet);
  }

  async getWallet(id: WalletId): Promise<Wallet | null> {
    const wallet = this.wallets.get(id);
    return wallet === undefined ? null : cloneWallet(wallet);
  }

  async getWalletByOwner(ownerId: OwnerId): Promise<Wallet | null> {
    const id = this.walletsByOwner.get(ownerId);
    if (id === undefined) return null;
    const wallet = this.wallets.get(id);
    return wallet === undefined ? null : cloneWallet(wallet);
  }

  async listWallets(): Promise<Wallet[]> {
    return [...this.wallets.values()].map(cloneWallet);
  }

  async getBalance(id: WalletId): Promise<bigint> {
    this.requireWallet(id);
    return this.balances.get(id) ?? 0n;
  }

  // -------------------------------------------------------------------------
  // Money movement
  // -------------------------------------------------------------------------

  async transfer(from: WalletId, to: WalletId, amount: bigint, memo: Memo): Promise<TxRef> {
    if (from === to) {
      throw new InvalidIntent('Cannot transfer to the same wallet');
    }
    return this.append({ kind: 'transfer', from, to, amount, memo });
  }

  async mint(to: WalletId, amount: bigint, memo: Memo): Promise<TxRef> {
    return this.append({ kind: 'mint', from: null, to, amount, memo });
  }

  async burn(from: WalletId, amount: bigint, memo: Memo): Promise<TxRef> {
    return this.append({ kind: 'burn', from, to: null, amount, memo });
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async history(id: WalletId, cursor?: string, limit?: number): Promise<HistoryPage> {
    this.requireWallet(id);
    const max = normalizeLimit(limit);
    const before = cursor === undefined ? null : decodeCursor(cursor);

    const page: Tx[] = [];
    let nextCursor: string | null = null;

    // Newest first: the array is append-only, so walking it backwards is seq-desc.
    for (let i = this.txs.length - 1; i >= 0; i -= 1) {
      const tx = this.txs[i];
      if (tx === undefined) continue;
      if (tx.from !== id && tx.to !== id) continue;
      if (before !== null && tx.seq >= before) continue;

      if (page.length === max) {
        nextCursor = encodeCursor(page[page.length - 1]?.seq ?? tx.seq + 1);
        break;
      }
      page.push(cloneTx(tx));
    }

    return { txs: page, cursor: nextCursor };
  }

  async getTx(txId: string): Promise<Tx | null> {
    const tx = this.txsById.get(txId);
    return tx === undefined ? null : cloneTx(tx);
  }

  async hasNonce(nonce: string): Promise<boolean> {
    return this.nonces.has(nonce);
  }

  async getTxByNonce(nonce: string): Promise<Tx | null> {
    const id = this.nonces.get(nonce);
    return id === undefined ? null : await this.getTx(id);
  }

  // -------------------------------------------------------------------------
  // Integrity
  // -------------------------------------------------------------------------

  async checkpoint(): Promise<Checkpoint | null> {
    return headOf(this.txs);
  }

  async verifyIntegrity(expected?: Checkpoint): Promise<IntegrityReport> {
    const { brokenAt } = verifyChain(this.txs);
    const violations = verifyStructure(this.txs, new Set(this.wallets.keys()));
    for (const [id, balance] of this.balances) {
      if (balance < 0n) violations.push({ seq: null, reason: `wallet ${id} has a negative stored balance` });
    }
    const checkpoint = expected === undefined ? 'none' : compareCheckpoint(this.txs, expected);

    // Fold the whole history and compare against the incrementally maintained
    // balances. Drift between the two is exactly what this check exists to find.
    const folded = new Map<WalletId, bigint>();
    for (const id of this.wallets.keys()) folded.set(id, 0n);

    for (const tx of this.txs) {
      if (tx.from !== null) folded.set(tx.from, (folded.get(tx.from) ?? 0n) - tx.amount);
      if (tx.to !== null) folded.set(tx.to, (folded.get(tx.to) ?? 0n) + tx.amount);
    }

    const balanceMismatches: WalletId[] = [];
    const ids = new Set<WalletId>([...this.balances.keys(), ...folded.keys()]);
    for (const id of ids) {
      if ((this.balances.get(id) ?? 0n) !== (folded.get(id) ?? 0n)) balanceMismatches.push(id);
    }

    return {
      ok:
        brokenAt.length === 0 &&
        balanceMismatches.length === 0 &&
        violations.length === 0 &&
        (checkpoint === 'none' || checkpoint === 'ok'),
      checked: this.txs.length,
      brokenAt,
      balanceMismatches,
      violations,
      head: headOf(this.txs),
      checkpoint,
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private requireWallet(id: WalletId): Wallet {
    const wallet = this.wallets.get(id);
    if (wallet === undefined) throw new UnknownWallet(id);
    return wallet;
  }

  private append(spec: AppendSpec): TxRef {
    const { kind, from, to, amount, memo } = spec;

    if (typeof amount !== 'bigint') {
      throw new InvalidAmount('Amount must be a bigint of whole HD');
    }
    if (amount <= 0n) {
      throw new InvalidAmount(`Amount must be greater than zero, got ${String(amount)} HD`);
    }

    validateMemo(memo);
    const nonce = memo.nonce;
    if (nonce !== undefined && this.nonces.has(nonce)) throw new DuplicateNonce(nonce);
    const key = memo.key;
    if (key !== undefined && this.keys.has(key)) throw new DuplicateKey(key);

    // Same order as SqliteBackend: shape, memo, replay guards, wallets, then funds — so a write
    // that is invalid in more than one way reports the same code on every backend.
    if (from !== null) this.requireWallet(from);
    if (to !== null) this.requireWallet(to);

    // Debit side must be able to cover it. Mint has no debit side.
    if (from !== null) {
      const available = this.balances.get(from) ?? 0n;
      if (available < amount) throw new InsufficientFunds(from, amount, available);
    }

    const prev = this.txs[this.txs.length - 1];
    const prevHash = prev === undefined ? GENESIS_HASH : prev.hash;
    const seq = this.txs.length;
    const createdAt = new Date().toISOString();
    const storedMemo = cloneMemo(memo);

    const hash = hashTx(
      canonicalTxPayload({ kind, from, to, amount, memo: storedMemo, prevHash, seq, createdAt }),
    );

    const tx: Tx = {
      id: randomUUID(),
      kind,
      from,
      to,
      amount,
      memo: storedMemo,
      prevHash,
      hash,
      // The ledger holds no key material, so it signs nothing. Custody attaches
      // signatures before handing a tx here on the backends that carry them.
      signature: null,
      createdAt,
      seq,
    };

    // Commit: append, index, then move the balances. All in-process and
    // synchronous, so there is no window where a caller can observe a half-write.
    this.txs.push(tx);
    this.txsById.set(tx.id, tx);
    if (nonce !== undefined) this.nonces.set(nonce, tx.id);
    if (key !== undefined) this.keys.add(key);
    if (from !== null) this.balances.set(from, (this.balances.get(from) ?? 0n) - amount);
    if (to !== null) this.balances.set(to, (this.balances.get(to) ?? 0n) + amount);

    return { txId: tx.id, hash: tx.hash, seq: tx.seq };
  }
}
