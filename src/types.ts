// Core domain types. Every amount in this system is a bigint of whole units of the configured
// currency (HD, "Heist Dollar," is just this project's own default placeholder name — the
// server owner sets the real one in config). There are no floats anywhere in the money path, by design.

export type WalletId = string;
export type OwnerId = string;
export type TxId = string;

/** A ledger account. Players and NPC entities both get one — they are indistinguishable to the ledger. */
export interface Wallet {
  id: WalletId;
  ownerId: OwnerId;
  /** Public address, derived from the keypair. Safe to display in-game. */
  address: string;
  /** ed25519 public key, hex. */
  pubkey: string;
  /** True for NPC/system accounts (treasury, hospital, ...). */
  isEntity: boolean;
  createdAt: string;
}

/** Why money moved. Attached to every transaction and never null. */
export interface Memo {
  /** The intent type that produced this op, e.g. "RentVehicle". */
  intent: string;
  /** Free-text detail shown in history, e.g. "Crystal Bikes — 30min". */
  detail?: string;
  /** Adapter-supplied idempotency key. Replaying the same one is rejected. */
  nonce?: string;
  /**
   * Business-object key: at most ONE tx in the whole ledger may carry a given key, enforced
   * atomically by the backend like a nonce. Lets the engine say "one welcome grant per owner",
   * "one refund per rental" without scanning history.
   */
  key?: string;
  /**
   * Machine-read fields (e.g. a rental's vehicle and minutes). Engine logic reads these and
   * never parses `detail`, which is display text. Hashed into the chain. See validateMemo.
   */
  meta?: Record<string, string>;
}

export type TxKind = 'transfer' | 'mint' | 'burn';

export interface Tx {
  id: TxId;
  kind: TxKind;
  /** null for mint — money enters the world from nowhere. */
  from: WalletId | null;
  /** null for burn — money leaves the world. */
  to: WalletId | null;
  amount: bigint;
  memo: Memo;
  /** Hash of the previous tx in the chain. Genesis is all zeroes. */
  prevHash: string;
  /** Hash over the canonical serialization of this tx, including prevHash. */
  hash: string;
  /** ed25519 signature by the payer's custodial key. null for mint (treasury authority signs). */
  signature: string | null;
  createdAt: string;
  /** Monotonic position in the chain, starting at 0. */
  seq: number;
}

export interface TxRef {
  txId: TxId;
  hash: string;
  seq: number;
}

// ---------------------------------------------------------------------------
// Intents — what an adapter sends. The adapter never names a ledger operation;
// it describes what happened in the world and the engine decides the money move.
// ---------------------------------------------------------------------------

export type IntentType =
  | 'OpenAccount'
  | 'RentVehicle'
  | 'ReturnVehicle'
  | 'BuyService'
  | 'Payout'
  | 'Fine'
  | 'Transfer'
  | 'Theft';

export interface BaseIntent {
  type: IntentType;
  /** Idempotency key from the adapter. Required — replay protection per SPEC open question 4. */
  nonce: string;
  /** Who the adapter says triggered this. */
  actor: OwnerId;
}

export interface OpenAccountIntent extends BaseIntent {
  type: 'OpenAccount';
}
export interface RentVehicleIntent extends BaseIntent {
  type: 'RentVehicle';
  vehicle: string;
  minutes: number;
}
export interface ReturnVehicleIntent extends BaseIntent {
  type: 'ReturnVehicle';
  /** The `txId` that RentVehicle returned. That ledger row IS the rental record. */
  rentalId: TxId;
  /** Whole minutes left on the rental, used for the partial refund. */
  minutesUnused: number;
}
export interface BuyServiceIntent extends BaseIntent {
  type: 'BuyService';
  service: string;
  /** Multiplier for metered services (litres of fuel, etc). Defaults to 1. */
  units?: number;
}
export interface PayoutIntent extends BaseIntent {
  type: 'Payout';
  employer: OwnerId;
  amount: string;
}
export interface FineIntent extends BaseIntent {
  type: 'Fine';
  amount: string;
  reason?: string;
}
export interface TransferIntent extends BaseIntent {
  type: 'Transfer';
  to: OwnerId;
  amount: string;
}
export interface TheftIntent extends BaseIntent {
  type: 'Theft';
  victim: OwnerId;
  amount: string;
  /** Theft requires explicit authorization — consent or admin. */
  authorizedBy: string;
}

export type Intent =
  | OpenAccountIntent
  | RentVehicleIntent
  | ReturnVehicleIntent
  | BuyServiceIntent
  | PayoutIntent
  | FineIntent
  | TransferIntent
  | TheftIntent;

/** What the engine hands back to the adapter. The adapter renders this and nothing else. */
export interface IntentResult {
  ok: true;
  txId: TxId;
  hash: string;
  /**
   * Balance of the acting party after settlement, or null if reading it back failed. The tx
   * settled either way: an ok result never means "maybe not".
   */
  newBalance: bigint | null;
  /** True when this is the original result of an intent whose nonce was submitted again. */
  replayed?: boolean;
  /** Human-readable line the adapter can show in-game. */
  message: string;
}

export interface IntentFailure {
  ok: false;
  code: string;
  message: string;
}

export type EngineResponse = IntentResult | IntentFailure;
