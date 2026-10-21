// Core domain types. Every amount in this system is a bigint of whole units of the configured
// currency (HD, "Heist Dollar," is just this project's own default placeholder name — the
// server owner sets the real one in config). There are no floats anywhere in the money path, by design.

export type WalletId = string;
export type OwnerId = string;
export type TxId = string;

/**
 * A player's money comes in three flavours, matching real FiveM RP server convention
 * (ESX ships `bank`/`money`/`black_money` by default): `cash` on hand (robbable by Theft),
 * `bank` (safe from Theft), and `dirty` (hot money — e.g. robbery proceeds — unusable until
 * LaunderMoney converts it). `cash` is the original single balance every wallet always had;
 * `bank`/`dirty` are additive and only come into existence if an operation actually uses them.
 * Entities (NPC/system accounts) are never split into buckets — only players are.
 */
export type WalletBucket = 'cash' | 'bank' | 'dirty';

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
  | 'Theft'
  | 'DepositToSociety'
  | 'RobEntity'
  | 'PlaceBet'
  | 'SettleBet'
  | 'LaunderMoney';

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
  /** Which bucket pays. Defaults to config's `walletBuckets.rental` if omitted. */
  bucket?: WalletBucket;
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
  /** Which bucket pays. Defaults to config's `walletBuckets.buyService` if omitted. */
  bucket?: WalletBucket;
}
export interface PayoutIntent extends BaseIntent {
  type: 'Payout';
  employer: OwnerId;
  amount: string;
  /** Which bucket receives it. Defaults to config's `walletBuckets.payout` if omitted. */
  bucket?: WalletBucket;
}
export interface FineIntent extends BaseIntent {
  type: 'Fine';
  amount: string;
  reason?: string;
  /** Which bucket pays. Defaults to config's `walletBuckets.fine` if omitted. */
  bucket?: WalletBucket;
}
export interface TransferIntent extends BaseIntent {
  type: 'Transfer';
  to: OwnerId;
  amount: string;
  /** Bucket on BOTH sides — handing over cash or an e-transfer between banks. Defaults to config's `walletBuckets.transfer`. */
  bucket?: WalletBucket;
}
export interface TheftIntent extends BaseIntent {
  type: 'Theft';
  victim: OwnerId;
  amount: string;
  /** Theft requires explicit authorization — consent or admin. */
  authorizedBy: string;
  /** Bucket on BOTH sides. Defaults to config's `walletBuckets.theft` if omitted. */
  bucket?: WalletBucket;
}
/**
 * player -> any configured entity, an arbitrary amount. The generic primitive behind a
 * business/government "society" account deposit, rent, a property purchase priced inline, etc. —
 * anything that is "a player pays some business an amount" without a catalog price. A FIXED
 * price (rent, a vehicle, a house) belongs in the `services` config catalog and uses BuyService
 * instead; this exists for amounts the adapter decides at call time.
 */
export interface DepositToSocietyIntent extends BaseIntent {
  type: 'DepositToSociety';
  entity: OwnerId;
  amount: string;
  /** Which bucket pays. Defaults to config's `walletBuckets.depositToSociety` if omitted. */
  bucket?: WalletBucket;
}
/**
 * entity -> player (the robber). Unlike Theft, the source is an NPC/system account, which cannot
 * consent — so `authorizedBy` must always name a configured admin, never the entity itself.
 */
export interface RobEntityIntent extends BaseIntent {
  type: 'RobEntity';
  entity: OwnerId;
  amount: string;
  authorizedBy: string;
  /** Which bucket the robber receives into. Defaults to config's `walletBuckets.robberyProceeds` if omitted. */
  bucket?: WalletBucket;
}
/** player -> casino/gambling entity. The wager. Settled (if won) by a later SettleBet. */
export interface PlaceBetIntent extends BaseIntent {
  type: 'PlaceBet';
  casino: OwnerId;
  amount: string;
  /** Which bucket wagers. Defaults to config's `walletBuckets.bet` if omitted. SettleBet pays winnings back into this same bucket. */
  bucket?: WalletBucket;
}
/**
 * casino entity -> player, paying out a WON bet. `betId` is the `txId` PlaceBet returned. Only
 * called on a win — a loss needs no further action, the wager already moved to the casino at
 * PlaceBet time. Settled once per bet, same guarantee ReturnVehicle gives a rental.
 */
export interface SettleBetIntent extends BaseIntent {
  type: 'SettleBet';
  betId: TxId;
  payout: string;
}

/**
 * player's `dirty` bucket -> the player's own chosen clean bucket, minus a cut that goes to
 * the configured `laundering.feeEntity`. The only path dirty money has back to being ordinary
 * cash or bank money — without this, `dirty` would be a dead end.
 */
export interface LaunderMoneyIntent extends BaseIntent {
  type: 'LaunderMoney';
  amount: string;
  /** The clean bucket to launder into. Never 'dirty' — laundering INTO dirty makes no sense. */
  toBucket: 'cash' | 'bank';
}

export type Intent =
  | OpenAccountIntent
  | RentVehicleIntent
  | ReturnVehicleIntent
  | BuyServiceIntent
  | PayoutIntent
  | FineIntent
  | TransferIntent
  | TheftIntent
  | DepositToSocietyIntent
  | RobEntityIntent
  | PlaceBetIntent
  | SettleBetIntent
  | LaunderMoneyIntent;

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
