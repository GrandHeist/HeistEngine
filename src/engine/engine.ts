// ===========================================================================
// ECONOMY ENGINE — the intent router.
// ===========================================================================
//
// The adapter never names a ledger operation. It describes what happened in the
// world (an Intent) and this class decides the money move, validates it against
// the config-driven world rules, and hands a settled op to the LedgerBackend.
//
// Invariants held here:
//   * `submit` NEVER throws. Every failure comes back as IntentFailure with a
//     stable `code` the adapter can branch on.
//   * All money is bigint. Config strings and intent amount strings go through
//     the config helpers; nothing in the money path is a JS number.
//   * Every settled op carries a Memo whose `intent` is the intent type and
//     whose `nonce` is the intent nonce. Replay enforcement itself lives in the
//     backend (`hasNonce` + the settle path) — this file only asks, it does not
//     keep its own nonce set.
// ===========================================================================

import { randomUUID } from 'node:crypto';

import {
  AccountExists,
  DuplicateKey,
  DuplicateNonce,
  EngineError,
  InvalidAmount,
  InvalidIntent,
  LedgerCorrupt,
  NotAuthorized,
  RentalClosed,
  UnknownEntity,
  UnknownRental,
  UnknownWallet,
} from '../errors.ts';
import {
  own,
  parseAmount,
  parseAmountText,
  priceOf,
  rentalRateOf,
  serviceOf,
  TREASURY_ID,
} from '../config/config.ts';
import type { HeistConfig } from '../config/config.ts';
import type { LedgerBackend, WalletKeyInfo } from '../ledger/backend.ts';
import { CONTROL_CHARS, validateMemo } from '../ledger/hashchain.ts';
import type { Custody } from './custody.ts';
import { Mutex } from './mutex.ts';
import type {
  BuyServiceIntent,
  EngineResponse,
  FineIntent,
  Intent,
  IntentResult,
  Memo,
  OpenAccountIntent,
  OwnerId,
  PayoutIntent,
  RentVehicleIntent,
  ReturnVehicleIntent,
  TheftIntent,
  TransferIntent,
  Tx,
  Wallet,
  WalletId,
} from '../types.ts';

/** The entity that rents out vehicles, per SPEC "Intent catalog". */
const RENTAL_ENTITY: OwnerId = 'bike-rental-co';

/** Price key used when a vehicle has no per-minute rate — a flat rental fee. */
const FLAT_RENTAL_PRICE_KEY = 'bike_rental';

/**
 * Error codes whose message is written for the adapter and safe to show a player. Every other
 * failure is reported generically; the detail (SQL, column names, stored rows) goes to the log.
 */
const PUBLIC_CODES: ReadonlySet<string> = new Set([
  'INSUFFICIENT_FUNDS',
  'UNKNOWN_WALLET',
  'DUPLICATE_NONCE',
  'INVALID_INTENT',
  'INVALID_AMOUNT',
  'UNKNOWN_ENTITY',
  'NOT_AUTHORIZED',
  'ACCOUNT_EXISTS',
  'UNKNOWN_RENTAL',
  'RENTAL_CLOSED',
]);

/** For a replayed nonce: which side of the tx is the party that initiated that intent type. */
const INITIATOR_IS_RECIPIENT: ReadonlySet<string> = new Set([
  'OpenAccount',
  'ReturnVehicle',
  'Payout',
  'Theft',
]);

/** Longest fine reason kept in a memo. */
const MAX_REASON = 120;

export interface EconomyEngineOptions {
  backend: LedgerBackend;
  custody: Custody;
  config: HeistConfig;
  /**
   * Called with the real cause of any failure the adapter is not shown (unexpected errors,
   * ledger corruption). `ref` is the short id included in the adapter-facing message so an
   * operator can match the two. Defaults to console.error.
   */
  onInternalError?: (cause: unknown, ref: string) => void;
}

export class EconomyEngine {
  readonly #backend: LedgerBackend;
  readonly #custody: Custody;
  readonly #config: HeistConfig;
  readonly #onInternalError: (cause: unknown, ref: string) => void;
  /** entity id -> display name, built once from config. */
  readonly #entities: Map<OwnerId, string>;
  /** Lower-cased entity ids. Player ids may not collide with these, whatever the casing. */
  readonly #entityKeys: Set<string>;
  readonly #admins: Set<string>;
  /** Intents read-then-write across awaits, so they run one at a time. */
  readonly #lock = new Mutex();

  constructor(options: EconomyEngineOptions) {
    this.#backend = options.backend;
    this.#custody = options.custody;
    this.#config = options.config;
    this.#onInternalError =
      options.onInternalError ??
      ((cause, ref) => console.error(`[heist-engine] internal error ${ref}:`, cause));
    this.#entities = new Map(options.config.entities.map((e) => [e.id, e.name ?? e.id]));
    this.#entityKeys = new Set(options.config.entities.map((e) => e.id.toLowerCase()));
    this.#admins = new Set(options.config.admins);
  }

  get config(): HeistConfig {
    return this.#config;
  }

  /**
   * Bring the world up: initialise the backend, then make sure every configured
   * entity has a wallet. Idempotent — safe to call on every process start, and
   * safe against a backend that already persisted the wallets.
   */
  async init(): Promise<void> {
    await this.#backend.init();

    // Entity ids share the owner namespace with players. A player wallet already sitting on
    // an entity's id (say, config gained a "casino-house" after a player joined as that)
    // would be treated as the entity's wallet: refuse to start instead.
    for (const wallet of await this.#backend.listWallets()) {
      if (!wallet.isEntity && this.#isEntityId(wallet.ownerId)) {
        throw new EngineError(
          'ENTITY_ID_CONFLICT',
          `A player wallet already uses the reserved entity id "${wallet.ownerId}"`,
        );
      }
    }
    for (const entity of this.#config.entities) {
      await this.#ensureWallet(entity.id, true);
    }
  }

  /**
   * The intent router. Never throws: an EngineError becomes a typed failure and
   * anything unexpected becomes code 'INTERNAL'.
   */
  async submit(intent: Intent): Promise<EngineResponse> {
    return await this.#guarded(() => this.#route(intent));
  }

  /**
   * ADMIN ONLY — not an Intent and not reachable through `submit`. Puts HD into an entity's
   * wallet (mint) so payouts, refunds and welcome-free worlds have a source on a fresh ledger.
   * Whoever holds the EconomyEngine object is the admin; the adapter surface (submit) has no
   * way to name this operation. Replay-protected by `nonce` like any other write.
   */
  async fundEntity(entityId: OwnerId, amount: string, nonce: string): Promise<EngineResponse> {
    return await this.#guarded(async () => {
      assertNonEmpty(nonce, 'nonce');
      assertNonEmpty(entityId, 'entityId');
      const entity = await this.#requireEntityWallet(entityId);
      const prior = await this.#backend.getTxByNonce(nonce);
      if (prior !== null) {
        if (prior.memo.intent === 'AdminFund' && prior.to === entity.id) {
          return await this.#replayed(prior, entity.id);
        }
        throw new DuplicateNonce(nonce);
      }
      const value = this.#intentAmount(amount, 'amount');
      const ref = await this.#backend.mint(entity.id, value, {
        intent: 'AdminFund',
        detail: `admin funding of ${this.#displayName(entityId)}`,
        nonce,
      });
      return await this.#result(ref, entity.id, `Funded ${this.#displayName(entityId)} with ${this.#money(value)}.`);
    });
  }

  /** Serialize, and turn every throw into a typed failure. */
  async #guarded(work: () => Promise<IntentResult>): Promise<EngineResponse> {
    try {
      return await this.#lock.run(work);
    } catch (cause) {
      if (cause instanceof EngineError && PUBLIC_CODES.has(cause.code)) {
        return { ok: false, code: cause.code, message: cause.message };
      }
      // Anything else may carry SQL, column names or stored rows. Log it, tell the adapter
      // only that it happened and how to find it.
      const ref = randomUUID().slice(0, 8);
      try {
        this.#onInternalError(cause, ref);
      } catch {
        // a broken logger must not turn a typed failure into a throw
      }
      return {
        ok: false,
        code: cause instanceof LedgerCorrupt ? 'LEDGER_CORRUPT' : 'INTERNAL',
        message: `Internal error (ref ${ref}). The server log has the details.`,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Routing
  // -------------------------------------------------------------------------

  async #route(intent: Intent): Promise<IntentResult> {
    if (intent === null || typeof intent !== 'object') {
      throw new InvalidIntent('Intent must be an object');
    }
    assertNonce(intent.nonce);
    assertNonEmpty(intent.actor, 'actor');

    // Ask the backend — the single source of truth for replay — before doing any
    // work that has a side effect. The backend still enforces atomically at write time.
    // A retry of an intent that already settled (same nonce, same type, same initiator) gets
    // the ORIGINAL result back so the adapter can carry on; any other reuse is a duplicate.
    const prior = await this.#backend.getTxByNonce(intent.nonce);
    if (prior !== null) {
      const initiator = INITIATOR_IS_RECIPIENT.has(prior.memo.intent) ? prior.to : prior.from;
      const actor =
        typeof intent.actor === 'string' ? await this.#backend.getWalletByOwner(intent.actor) : null;
      if (actor !== null && initiator === actor.id && prior.memo.intent === intent.type) {
        return await this.#replayed(prior, actor.id);
      }
      throw new DuplicateNonce(intent.nonce);
    }

    switch (intent.type) {
      case 'OpenAccount':
        return await this.#openAccount(intent);
      case 'RentVehicle':
        return await this.#rentVehicle(intent);
      case 'ReturnVehicle':
        return await this.#returnVehicle(intent);
      case 'BuyService':
        return await this.#buyService(intent);
      case 'Payout':
        return await this.#payout(intent);
      case 'Fine':
        return await this.#fine(intent);
      case 'Transfer':
        return await this.#transfer(intent);
      case 'Theft':
        return await this.#theft(intent);
      default:
        throw new InvalidIntent(`Unknown intent type ${JSON.stringify(unknownType(intent))}`);
    }
  }

  // -------------------------------------------------------------------------
  // Intent handlers
  // -------------------------------------------------------------------------

  /**
   * Open an account and pay the welcome grant — once per owner.
   *
   * The grant is a MINT, attributed to the treasury in the memo (docs/adr/0004 explains why it
   * is not a treasury transfer). "Once" is enforced by the ledger, not by a check here: the mint
   * carries the key `welcome:<owner>` and a backend accepts a given key exactly once, atomically.
   * A wallet written without its mint (interrupted open) simply gets the grant on the next call.
   */
  async #openAccount(intent: OpenAccountIntent): Promise<IntentResult> {
    this.#requireEntity(TREASURY_ID);
    const amount = parseAmount(this.#config.welcomeGrant, 'welcomeGrant');
    requirePositive(amount, 'welcomeGrant');

    this.#assertPlayerId(intent.actor, 'actor');
    const existing = await this.#backend.getWalletByOwner(intent.actor);
    if (existing?.isEntity === true) throw new NotAuthorized(`"${intent.actor}" is an entity account`);
    // Validate the whole memo BEFORE creating a wallet: a grant the ledger will refuse must not
    // leave an orphan wallet behind.
    const memo: Memo = {
      ...this.#memo(intent, `welcome grant from ${this.#displayName(TREASURY_ID)}`),
      key: `welcome:${intent.actor}`,
    };
    validateMemo(memo);
    const player = existing ?? (await this.#ensureWallet(intent.actor, false));

    let ref;
    try {
      ref = await this.#backend.mint(player.id, amount, memo);
    } catch (cause) {
      if (cause instanceof DuplicateKey) throw new AccountExists(intent.actor, player.address);
      throw cause;
    }

    return await this.#result(
      ref,
      player.id,
      `Account opened. ${this.#money(amount)} welcome grant received.`,
    );
  }

  /** player -> bike-rental-co, rate * minutes (or the flat fee). */
  async #rentVehicle(intent: RentVehicleIntent): Promise<IntentResult> {
    assertName(intent.vehicle, 'vehicle');
    const minutes = requireWholeCount(intent.minutes, 'minutes');

    const amount = this.#rentalCost(intent.vehicle, minutes);
    requirePositive(amount, 'rental cost');

    const player = await this.#requirePlayerWallet(intent.actor, 'actor');
    const payee = await this.#requireEntityWallet(RENTAL_ENTITY);

    const ref = await this.#backend.transfer(
      player.id,
      payee.id,
      amount,
      {
        ...this.#memo(intent, `${intent.vehicle} — ${minutes}min`),
        // The rental record: ReturnVehicle reads these, never the detail text.
        meta: { vehicle: intent.vehicle, minutes: String(minutes) },
      },
    );

    return await this.#result(
      ref,
      player.id,
      `Paid ${this.#money(amount)} to ${this.#displayName(RENTAL_ENTITY)}.`,
    );
  }

  /**
   * bike-rental-co -> player, refunding the unused portion of ONE rental.
   *
   * The rental is the RentVehicle tx named by `rentalId`: its amount is what was actually paid
   * and its `meta` holds the minutes rented, so the refund is `paid * unused / rented` whatever
   * the config says today, and never more than was paid. A rental is returned once: the refund
   * carries the key `return:<rentalId>`, which the ledger accepts a single time, atomically.
   */
  async #returnVehicle(intent: ReturnVehicleIntent): Promise<IntentResult> {
    assertNonEmpty(intent.rentalId, 'rentalId');
    const minutesUnused = requireWholeCount(intent.minutesUnused, 'minutesUnused');

    const player = await this.#requirePlayerWallet(intent.actor, 'actor');
    const payer = await this.#requireEntityWallet(RENTAL_ENTITY);

    const { rental, rentedMinutes } = requireRental(
      await this.#backend.getTx(intent.rentalId),
      player.id,
      payer.id,
    );
    if (minutesUnused > rentedMinutes) {
      throw new InvalidIntent(
        `minutesUnused (${minutesUnused}) exceeds the ${rentedMinutes} minutes rented`,
      );
    }

    const refund = (rental.amount * BigInt(minutesUnused)) / BigInt(rentedMinutes);
    requirePositive(refund, 'refund');

    let ref;
    try {
      ref = await this.#backend.transfer(payer.id, player.id, refund, {
        ...this.#memo(intent, `${rental.memo.meta?.['vehicle'] ?? 'rental'} — refund ${minutesUnused}min`),
        key: `return:${intent.rentalId}`,
        meta: { rental: intent.rentalId, minutesUnused: String(minutesUnused) },
      });
    } catch (cause) {
      if (cause instanceof DuplicateKey) throw new RentalClosed(intent.rentalId);
      throw cause;
    }

    return await this.#result(
      ref,
      player.id,
      `Refunded ${this.#money(refund)} from ${this.#displayName(RENTAL_ENTITY)}.`,
    );
  }

  /** player -> service entity, price * units. */
  async #buyService(intent: BuyServiceIntent): Promise<IntentResult> {
    assertName(intent.service, 'service');
    const units = intent.units === undefined ? 1 : requireWholeCount(intent.units, 'units');

    // Unknown service is reported as UnknownEntity per the intent catalog: there
    // is no entity behind it to pay. `serviceOf` throws exactly that.
    const service = serviceOf(this.#config, intent.service);
    const entityId: OwnerId = service.entity;
    const amount = service.price * BigInt(units);
    requirePositive(amount, 'price');

    const player = await this.#requirePlayerWallet(intent.actor, 'actor');
    const payee = await this.#requireEntityWallet(entityId);

    const ref = await this.#backend.transfer(
      player.id,
      payee.id,
      amount,
      this.#memo(intent, units === 1 ? intent.service : `${intent.service} x${units}`),
    );

    return await this.#result(
      ref,
      player.id,
      `Paid ${this.#money(amount)} to ${this.#displayName(entityId)}.`,
    );
  }

  /** employer entity -> player. */
  async #payout(intent: PayoutIntent): Promise<IntentResult> {
    assertNonEmpty(intent.employer, 'employer');
    const amount = this.#intentAmount(intent.amount, 'amount');

    const employer = await this.#requireEntityWallet(intent.employer);
    const player = await this.#requirePlayerWallet(intent.actor, 'actor');

    const ref = await this.#backend.transfer(
      employer.id,
      player.id,
      amount,
      this.#memo(intent, `payout from ${this.#displayName(intent.employer)}`),
    );

    return await this.#result(
      ref,
      player.id,
      `Received ${this.#money(amount)} from ${this.#displayName(intent.employer)}.`,
    );
  }

  /** player -> treasury. */
  async #fine(intent: FineIntent): Promise<IntentResult> {
    const amount = this.#intentAmount(intent.amount, 'amount');

    const player = await this.#requirePlayerWallet(intent.actor, 'actor');
    const treasury = await this.#requireEntityWallet(TREASURY_ID);

    const reason = cleanReason(intent.reason);

    const ref = await this.#backend.transfer(
      player.id,
      treasury.id,
      amount,
      this.#memo(intent, reason === undefined ? 'fine' : `fine — ${reason}`),
    );

    const suffix = reason === undefined ? '' : ` (${reason})`;
    return await this.#result(
      ref,
      player.id,
      `Paid ${this.#money(amount)} to ${this.#displayName(TREASURY_ID)}${suffix}.`,
    );
  }

  /** player -> player. */
  async #transfer(intent: TransferIntent): Promise<IntentResult> {
    assertNonEmpty(intent.to, 'to');
    if (intent.to === intent.actor) {
      throw new InvalidIntent('Cannot transfer to yourself');
    }
    const amount = this.#intentAmount(intent.amount, 'amount');

    const from = await this.#requirePlayerWallet(intent.actor, 'actor');
    const to = await this.#requirePlayerWallet(intent.to, 'to');

    const ref = await this.#backend.transfer(
      from.id,
      to.id,
      amount,
      this.#memo(intent, `to ${intent.to}`),
    );

    return await this.#result(
      ref,
      from.id,
      `Sent ${this.#money(amount)} to ${intent.to}.`,
    );
  }

  /** victim -> actor. Only ever with explicit authorization. */
  async #theft(intent: TheftIntent): Promise<IntentResult> {
    assertNonEmpty(intent.victim, 'victim');
    if (typeof intent.authorizedBy !== 'string' || intent.authorizedBy.trim() === '') {
      throw new NotAuthorized(
        'Theft requires authorizedBy — consent from the victim or an admin id',
      );
    }
    if (intent.victim === intent.actor) {
      throw new InvalidIntent('Cannot steal from yourself');
    }
    // Whoever authorizes must be the victim (consent) or a configured admin. A free-text
    // "authorizedBy" would authorize anything; naming the robber themselves authorizes nothing.
    const authorizedBy = intent.authorizedBy.trim();
    if (authorizedBy !== intent.victim && !this.#admins.has(authorizedBy)) {
      throw new NotAuthorized(
        `Theft must be authorized by the victim (consent) or a configured admin, not "${authorizedBy}"`,
      );
    }
    const amount = this.#intentAmount(intent.amount, 'amount');

    const victim = await this.#requirePlayerWallet(intent.victim, 'victim');
    const robber = await this.#requirePlayerWallet(intent.actor, 'actor');

    const ref = await this.#backend.transfer(
      victim.id,
      robber.id,
      amount,
      this.#memo(intent, `theft from ${intent.victim}, authorized by ${authorizedBy}`),
    );

    return await this.#result(
      ref,
      robber.id,
      `Took ${this.#money(amount)} from ${intent.victim}.`,
    );
  }

  // -------------------------------------------------------------------------
  // Pricing
  // -------------------------------------------------------------------------

  #rentalCost(vehicle: string, minutes: number): bigint {
    if (own(this.#config.rentalPerMinute, vehicle) !== undefined) {
      return rentalRateOf(this.#config, vehicle) * BigInt(minutes);
    }
    if (own(this.#config.prices, FLAT_RENTAL_PRICE_KEY) === undefined) {
      throw new InvalidIntent(
        `No rental rate configured for vehicle "${vehicle}" and no "${FLAT_RENTAL_PRICE_KEY}" flat price to fall back on`,
      );
    }
    return priceOf(this.#config, FLAT_RENTAL_PRICE_KEY);
  }

  // -------------------------------------------------------------------------
  // Wallets, memos, results
  // -------------------------------------------------------------------------

  /** Create the wallet if absent, minting the keypair through Custody first. */
  async #ensureWallet(ownerId: OwnerId, isEntity: boolean): Promise<Wallet> {
    const existing = await this.#backend.getWalletByOwner(ownerId);
    if (existing !== null) {
      if (isEntity && !existing.isEntity) {
        throw new EngineError('ENTITY_ID_CONFLICT', `A player wallet already uses the entity id "${ownerId}"`);
      }
      return existing;
    }
    return await this.#backend.createWallet(ownerId, this.#keyFor(ownerId), { isEntity });
  }

  /** The public half of this owner's keypair, generated on first use. */
  #keyFor(ownerId: OwnerId): WalletKeyInfo {
    const pubkey = this.#custody.pubkeyOf(ownerId);
    const address = this.#custody.addressOf(ownerId);
    if (pubkey !== null && address !== null) {
      return { pubkey, address };
    }
    const keypair = this.#custody.createKeypair(ownerId);
    // The private half stays inside Custody; only the public half crosses to the
    // ledger. Never log or return keypair.privateKeyPem.
    return { pubkey: keypair.pubkey, address: keypair.address };
  }

  #isEntityId(ownerId: OwnerId): boolean {
    return this.#entityKeys.has(ownerId.toLowerCase());
  }

  /** A well-formed owner id that is not an entity's. Entity ids never act as players. */
  #assertPlayerId(ownerId: OwnerId, role: string): void {
    assertOwnerId(ownerId, role);
    if (this.#isEntityId(ownerId)) {
      throw new NotAuthorized(`"${ownerId}" is an entity account and cannot be the ${role} of a player intent`);
    }
  }

  /** The wallet of a PLAYER owner. Entity ids are rejected as actor / to / victim. */
  async #requirePlayerWallet(ownerId: OwnerId, role: string): Promise<Wallet> {
    this.#assertPlayerId(ownerId, role);
    const wallet = await this.#backend.getWalletByOwner(ownerId);
    if (wallet === null) throw new UnknownWallet(ownerId);
    if (wallet.isEntity) {
      throw new NotAuthorized(`"${ownerId}" is an entity account and cannot be the ${role} of a player intent`);
    }
    return wallet;
  }

  #requireEntity(entityId: OwnerId): void {
    if (!this.#entities.has(entityId)) throw new UnknownEntity(entityId);
  }

  async #requireEntityWallet(entityId: OwnerId): Promise<Wallet> {
    this.#requireEntity(entityId);
    const wallet = await this.#backend.getWalletByOwner(entityId);
    if (wallet === null) throw new UnknownWallet(entityId);
    return wallet;
  }

  #memo(intent: Intent, detail?: string): Memo {
    const memo: Memo = { intent: intent.type, nonce: intent.nonce };
    if (detail !== undefined && detail !== '') memo.detail = detail;
    return memo;
  }

  /**
   * Called after the ledger write has settled, so it must never throw: a failed read-back
   * reports `newBalance: null`, not a failure for money that already moved.
   */
  async #result(
    ref: { txId: string; hash: string },
    balanceOf: WalletId,
    message: string,
  ): Promise<IntentResult> {
    return {
      ok: true,
      txId: ref.txId,
      hash: ref.hash,
      newBalance: await this.#balanceOrNull(balanceOf),
      message,
    };
  }

  /** The original result of an intent whose nonce came in again. */
  async #replayed(prior: Tx, balanceOf: WalletId): Promise<IntentResult> {
    return {
      ok: true,
      txId: prior.id,
      hash: prior.hash,
      newBalance: await this.#balanceOrNull(balanceOf),
      replayed: true,
      message: 'This intent was already settled; returning the original result.',
    };
  }

  async #balanceOrNull(id: WalletId): Promise<bigint | null> {
    try {
      return await this.#backend.getBalance(id);
    } catch (cause) {
      try {
        this.#onInternalError(cause, 'post-settle-balance');
      } catch {
        // logging must not undo a settled result
      }
      return null;
    }
  }

  #displayName(entityId: OwnerId): string {
    return this.#entities.get(entityId) ?? entityId;
  }

  #money(amount: bigint): string {
    return `${amount.toString()} ${this.#config.currency}`;
  }

  /** Parse an amount string off an intent and require it to be strictly positive. */
  #intentAmount(raw: string, field: string): bigint {
    // parseAmountText throws InvalidAmount about the value itself (no "config:" prefix).
    const amount = parseAmountText(raw, field);
    requirePositive(amount, field);
    return amount;
  }
}

// ---------------------------------------------------------------------------
// Small guards
// ---------------------------------------------------------------------------

/** Owner ids are opaque, but must be plain: no padding, no control characters, bounded. */
function assertOwnerId(value: unknown, field: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 128 ||
    value !== value.trim() ||
    CONTROL_CHARS.test(value) ||
    /\p{Cf}/u.test(value) || // zero-width and other invisible format characters
    !value.isWellFormed() ||
    value !== value.normalize('NFC') // "café" typed two ways is one id, not two grants
  ) {
    throw new InvalidIntent(
      `${field} must be a 1-128 character NFC-normalized id with no padding, control or invisible characters`,
    );
  }
}

/** A catalog key an adapter names (vehicle, service): short, single-line, no padding. */
function assertName(value: unknown, field: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 64 ||
    value !== value.trim() ||
    CONTROL_CHARS.test(value) ||
    !value.isWellFormed()
  ) {
    throw new InvalidIntent(`${field} must be 1-64 characters, single-line, with no padding`);
  }
}

/**
 * Free-text a caller supplies for display (a fine's reason). It ends up in a hashed memo, so it
 * is flattened to one line and capped rather than rejected: a rude or long reason must not stop a fine.
 */
function cleanReason(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const flat = raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat === '') return undefined;
  if (flat.length <= MAX_REASON) return flat;
  // Cut by Unicode code point, never by raw UTF-16 unit: slicing at a fixed offset can land
  // inside a surrogate pair (an emoji, say) and leave a lone surrogate behind, which
  // validateMemo then refuses as not well-formed — turning a harmless long reason into a
  // fine that cannot be recorded at all.
  const codePoints = Array.from(flat);
  return codePoints.length > MAX_REASON
    ? `${codePoints.slice(0, MAX_REASON - 1).join('')}…`
    : flat;
}

/** Same rules the ledger applies to memo.nonce, checked up front so nothing is written first. */
function assertNonce(value: unknown): void {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.length > 128 ||
    CONTROL_CHARS.test(value) ||
    !value.isWellFormed()
  ) {
    throw new InvalidIntent('nonce must be a 1-128 character single-line string');
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidIntent(`${field} must be a non-empty string`);
  }
}

function requirePositive(amount: bigint, field: string): void {
  if (amount <= 0n) {
    throw new InvalidAmount(`${field} must be greater than zero, got ${amount.toString()}`);
  }
}

/** Counts (minutes, units) are plain integers, never money — but never floats either. */
function requireWholeCount(value: number, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new InvalidIntent(`${field} must be a whole number, got ${String(value)}`);
  }
  if (value <= 0) {
    throw new InvalidIntent(`${field} must be greater than zero, got ${String(value)}`);
  }
  return value;
}

/**
 * The rental tx and the minutes rented, read from its structured `meta`. Throws UnknownRental unless the
 * tx really is a RentVehicle payment from this player to the rental entity, so one player
 * cannot cite another's rental (or any non-rental tx) to get a refund. The same message is used
 * for every mismatch: it must not reveal whether some other player's tx id exists.
 */
function requireRental(
  rental: Tx | null,
  playerWallet: WalletId,
  entityWallet: WalletId,
): { rental: Tx; rentedMinutes: number } {
  const minutes = rental?.memo.meta?.['minutes'];
  if (
    rental === null ||
    rental.kind !== 'transfer' ||
    rental.memo.intent !== 'RentVehicle' ||
    rental.from !== playerWallet ||
    rental.to !== entityWallet ||
    typeof minutes !== 'string' ||
    !/^[1-9][0-9]{0,14}$/.test(minutes)
  ) {
    throw new UnknownRental('No such rental for this player');
  }
  return { rental, rentedMinutes: Number(minutes) };
}

/** Only reachable if an adapter sends a type outside the union. */
function unknownType(intent: never): string {
  return String((intent as { type?: unknown }).type);
}
