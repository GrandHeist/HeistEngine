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
  BetSettled,
  DuplicateKey,
  DuplicateNonce,
  EngineError,
  InvalidAmount,
  InvalidIntent,
  LedgerCorrupt,
  LoanClosed,
  NotAuthorized,
  RentalClosed,
  UnknownBet,
  UnknownEntity,
  UnknownLoan,
  UnknownRental,
  UnknownWallet,
} from '../errors.ts';
import {
  isWalletBucket,
  own,
  parseAmount,
  parseAmountText,
  parsePercent,
  priceOf,
  rentalRateOf,
  serviceOf,
  TREASURY_ID,
  WALLET_BUCKETS,
} from '../config/config.ts';
import type { HeistConfig } from '../config/config.ts';
import type { LedgerBackend, WalletKeyInfo } from '../ledger/backend.ts';
import { CONTROL_CHARS, validateMemo } from '../ledger/hashchain.ts';
import type { Custody } from './custody.ts';
import { Mutex } from './mutex.ts';
import type {
  BuyServiceIntent,
  BuySharesIntent,
  DepositToSocietyIntent,
  EngineResponse,
  FineIntent,
  Intent,
  IntentResult,
  LaunderMoneyIntent,
  Memo,
  OpenAccountIntent,
  OwnerId,
  PayoutIntent,
  PlaceBetIntent,
  RentVehicleIntent,
  RepayLoanIntent,
  ReturnVehicleIntent,
  RobEntityIntent,
  SellSharesIntent,
  SettleBetIntent,
  TakeLoanIntent,
  TheftIntent,
  TransferIntent,
  Tx,
  TxId,
  Wallet,
  WalletBucket,
  WalletId,
} from '../types.ts';

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
  'UNKNOWN_BET',
  'BET_SETTLED',
  'UNKNOWN_LOAN',
  'LOAN_CLOSED',
]);

/** For a replayed nonce: which side of the tx is the party that initiated that intent type. */
const INITIATOR_IS_RECIPIENT: ReadonlySet<string> = new Set([
  'OpenAccount',
  'ReturnVehicle',
  'Payout',
  'Theft',
  'RobEntity',
  'SettleBet',
  'TakeLoan',
  'SellShares',
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
      // ADR 0003 part 3: with a master seed configured, every already-existing wallet's key
      // must re-derive to its stored pubkey or the engine refuses to start. With no seed
      // configured this is skipped entirely — unchanged from before this feature existed.
      if (this.#custody.hasMasterSeed) {
        this.#custody.reconcileExistingWallet(wallet.ownerId, wallet.pubkey);
      }
    }
    for (const entity of this.#config.entities) {
      await this.#ensureWallet(entity.id, true);
    }

    // Fixed-float tradeable businesses get their total share count minted into `<id>#float`
    // exactly once, ever — real scarcity from genesis, not minted per-trade. A deterministic
    // nonce makes this safe to run again on every restart.
    for (const [businessId, entry] of Object.entries(this.#config.shares.businesses)) {
      if (entry.totalShares === undefined) continue;
      const genesisNonce = `float-genesis:${businessId}`;
      if (await this.#backend.hasNonce(genesisNonce)) continue;
      const float = await this.#ensureWallet(`${businessId}#float`, false);
      const totalShares = parseAmount(entry.totalShares, `shares.businesses.${businessId}.totalShares`);
      await this.#backend.mint(float.id, totalShares, { intent: 'ShareFloatGenesis', nonce: genesisNonce });
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

  /**
   * ADMIN ONLY — not an Intent and not reachable through `submit`. Moves money between two
   * ENTITIES (e.g. a business paying periodic tax to the government treasury) — every other
   * operation in this engine has a player on at least one side; this is the one exception, and
   * it exists only because a server operator or a scheduled job calls it directly, same trust
   * level as fundEntity. Replay-protected by `nonce` like any other write.
   */
  async taxEntity(fromEntityId: OwnerId, toEntityId: OwnerId, amount: string, nonce: string): Promise<EngineResponse> {
    return await this.#guarded(async () => {
      assertNonEmpty(nonce, 'nonce');
      assertNonEmpty(fromEntityId, 'fromEntityId');
      assertNonEmpty(toEntityId, 'toEntityId');
      if (fromEntityId === toEntityId) {
        throw new InvalidIntent('taxEntity: fromEntityId and toEntityId must differ');
      }
      const from = await this.#requireEntityWallet(fromEntityId);
      const to = await this.#requireEntityWallet(toEntityId);
      const prior = await this.#backend.getTxByNonce(nonce);
      if (prior !== null) {
        if (prior.memo.intent === 'TaxSociety' && prior.from === from.id && prior.to === to.id) {
          return await this.#replayed(prior, from.id);
        }
        throw new DuplicateNonce(nonce);
      }
      const value = this.#intentAmount(amount, 'amount');
      const ref = await this.#backend.transfer(from.id, to.id, value, {
        intent: 'TaxSociety',
        detail: `tax from ${this.#displayName(fromEntityId)} to ${this.#displayName(toEntityId)}`,
        nonce,
      });
      return await this.#result(
        ref,
        from.id,
        `Taxed ${this.#money(value)} from ${this.#displayName(fromEntityId)} to ${this.#displayName(toEntityId)}.`,
      );
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
      // The wallet that moved is bucket-specific (e.g. "player-1#bank"'s id), not necessarily
      // intent.actor's base/cash wallet, so match by stripping the bucket suffix back off its
      // owner id rather than comparing wallet ids against the base wallet directly.
      const initiatorId = INITIATOR_IS_RECIPIENT.has(prior.memo.intent) ? prior.to : prior.from;
      const initiatorWallet = initiatorId !== null ? await this.#backend.getWallet(initiatorId) : null;
      const matches =
        typeof intent.actor === 'string' &&
        initiatorWallet !== null &&
        stripBucketSuffix(initiatorWallet.ownerId) === intent.actor &&
        prior.memo.intent === intent.type;
      if (matches && initiatorWallet !== null) {
        return await this.#replayed(prior, initiatorWallet.id);
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
      case 'DepositToSociety':
        return await this.#depositToSociety(intent);
      case 'RobEntity':
        return await this.#robEntity(intent);
      case 'PlaceBet':
        return await this.#placeBet(intent);
      case 'SettleBet':
        return await this.#settleBet(intent);
      case 'LaunderMoney':
        return await this.#launderMoney(intent);
      case 'TakeLoan':
        return await this.#takeLoan(intent);
      case 'RepayLoan':
        return await this.#repayLoan(intent);
      case 'BuyShares':
        return await this.#buyShares(intent);
      case 'SellShares':
        return await this.#sellShares(intent);
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
    const grantWallet = await this.#bucketWallet(player, this.#config.walletBuckets.welcomeGrant);

    let ref;
    try {
      ref = await this.#backend.mint(grantWallet.id, amount, memo);
    } catch (cause) {
      if (cause instanceof DuplicateKey) throw new AccountExists(intent.actor, player.address);
      throw cause;
    }

    return await this.#result(
      ref,
      grantWallet.id,
      `Account opened. ${this.#money(amount)} welcome grant received.`,
    );
  }

  /** player's rental bucket -> bike-rental-co, rate * minutes (or the flat fee). */
  async #rentVehicle(intent: RentVehicleIntent): Promise<IntentResult> {
    assertName(intent.vehicle, 'vehicle');
    const minutes = requireWholeCount(intent.minutes, 'minutes');

    const amount = this.#rentalCost(intent.vehicle, minutes);
    requirePositive(amount, 'rental cost');

    const bucket = this.#resolveBucket(intent.bucket, this.#config.walletBuckets.rental);
    const basePlayer = await this.#requirePlayerWallet(intent.actor, 'actor');
    const player = await this.#bucketWallet(basePlayer, bucket);
    const payee = await this.#requireEntityWallet(this.#config.rentalEntity);

    const ref = await this.#backend.transfer(
      player.id,
      payee.id,
      amount,
      {
        ...this.#memo(intent, `${intent.vehicle} — ${minutes}min`),
        // The rental record: ReturnVehicle reads these, never the detail text.
        meta: { vehicle: intent.vehicle, minutes: String(minutes), bucket },
      },
    );

    return await this.#result(
      ref,
      player.id,
      `Paid ${this.#money(amount)} to ${this.#displayName(this.#config.rentalEntity)}.`,
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

    const basePlayer = await this.#requirePlayerWallet(intent.actor, 'actor');
    const payer = await this.#requireEntityWallet(this.#config.rentalEntity);

    const rawRental = await this.#backend.getTx(intent.rentalId);
    const bucket = requireRentalBucket(rawRental);
    const player = await this.#bucketWallet(basePlayer, bucket);

    const { rental, rentedMinutes } = requireRental(rawRental, player.id, payer.id);
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
      `Refunded ${this.#money(refund)} from ${this.#displayName(this.#config.rentalEntity)}.`,
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

    const bucket = this.#resolveBucket(intent.bucket, this.#config.walletBuckets.buyService);
    const basePlayer = await this.#requirePlayerWallet(intent.actor, 'actor');
    const player = await this.#bucketWallet(basePlayer, bucket);
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
    const bucket = this.#resolveBucket(intent.bucket, this.#config.walletBuckets.payout);
    const basePlayer = await this.#requirePlayerWallet(intent.actor, 'actor');
    const player = await this.#bucketWallet(basePlayer, bucket);

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

    const bucket = this.#resolveBucket(intent.bucket, this.#config.walletBuckets.fine);
    const basePlayer = await this.#requirePlayerWallet(intent.actor, 'actor');
    const player = await this.#bucketWallet(basePlayer, bucket);
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
    const bucket = this.#resolveBucket(intent.bucket, this.#config.walletBuckets.transfer);

    const baseFrom = await this.#requirePlayerWallet(intent.actor, 'actor');
    const baseTo = await this.#requirePlayerWallet(intent.to, 'to');
    const from = await this.#bucketWallet(baseFrom, bucket);
    const to = await this.#bucketWallet(baseTo, bucket);

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
    const bucket = this.#resolveBucket(intent.bucket, this.#config.walletBuckets.theft);

    const baseVictim = await this.#requirePlayerWallet(intent.victim, 'victim');
    const baseRobber = await this.#requirePlayerWallet(intent.actor, 'actor');
    const victim = await this.#bucketWallet(baseVictim, bucket);
    const robber = await this.#bucketWallet(baseRobber, bucket);

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

  /**
   * player -> any configured entity, an adapter-decided amount. The generic "pay a business"
   * primitive — a society/government account deposit, rent, anything without a catalog price.
   * A fixed price (a vehicle, a house, an impound fee) belongs in the `services` config and
   * should use BuyService instead.
   */
  async #depositToSociety(intent: DepositToSocietyIntent): Promise<IntentResult> {
    const amount = this.#intentAmount(intent.amount, 'amount');
    const bucket = this.#resolveBucket(intent.bucket, this.#config.walletBuckets.depositToSociety);

    const basePlayer = await this.#requirePlayerWallet(intent.actor, 'actor');
    const player = await this.#bucketWallet(basePlayer, bucket);
    const payee = await this.#requireEntityWallet(intent.entity);

    const ref = await this.#backend.transfer(
      player.id,
      payee.id,
      amount,
      this.#memo(intent, `deposit to ${this.#displayName(intent.entity)}`),
    );

    return await this.#result(
      ref,
      player.id,
      `Paid ${this.#money(amount)} to ${this.#displayName(intent.entity)}.`,
    );
  }

  /**
   * entity -> player (the robber). Unlike Theft, the source cannot consent — an NPC store, bank
   * or ATM has no owner to ask — so authorizedBy must always be a configured admin.
   */
  async #robEntity(intent: RobEntityIntent): Promise<IntentResult> {
    if (typeof intent.authorizedBy !== 'string' || intent.authorizedBy.trim() === '') {
      throw new NotAuthorized('RobEntity requires authorizedBy — a configured admin id');
    }
    const authorizedBy = intent.authorizedBy.trim();
    if (!this.#admins.has(authorizedBy)) {
      throw new NotAuthorized(
        `RobEntity must be authorized by a configured admin, not "${authorizedBy}" — an entity cannot consent`,
      );
    }
    const amount = this.#intentAmount(intent.amount, 'amount');
    const bucket = this.#resolveBucket(intent.bucket, this.#config.walletBuckets.robberyProceeds);

    const payer = await this.#requireEntityWallet(intent.entity);
    const baseRobber = await this.#requirePlayerWallet(intent.actor, 'actor');
    const robber = await this.#bucketWallet(baseRobber, bucket);

    const ref = await this.#backend.transfer(
      payer.id,
      robber.id,
      amount,
      this.#memo(intent, `robbed ${this.#displayName(intent.entity)}, authorized by ${authorizedBy}`),
    );

    return await this.#result(
      ref,
      robber.id,
      `Took ${this.#money(amount)} from ${this.#displayName(intent.entity)}.`,
    );
  }

  /**
   * player -> casino/gambling entity: the wager. Settled, if won, by a later SettleBet.
   * Same-ledger-currency chips only — nothing here ever moves money outside this ledger.
   */
  async #placeBet(intent: PlaceBetIntent): Promise<IntentResult> {
    const amount = this.#intentAmount(intent.amount, 'amount');
    const bucket = this.#resolveBucket(intent.bucket, this.#config.walletBuckets.bet);

    const basePlayer = await this.#requirePlayerWallet(intent.actor, 'actor');
    const player = await this.#bucketWallet(basePlayer, bucket);
    const casino = await this.#requireEntityWallet(intent.casino);

    const ref = await this.#backend.transfer(
      player.id,
      casino.id,
      amount,
      {
        ...this.#memo(intent, `bet at ${this.#displayName(intent.casino)}`),
        // The casino's OWNER id (not its wallet id) — SettleBet looks this up via
        // #requireEntityWallet, which takes an OwnerId. `bucket` lets SettleBet pay
        // winnings back into the SAME bucket the wager came from.
        meta: { casino: intent.casino, bucket },
      },
    );

    return await this.#result(
      ref,
      player.id,
      `Wagered ${this.#money(amount)} at ${this.#displayName(intent.casino)}.`,
    );
  }

  /**
   * casino entity -> player, paying out a WON bet. `betId` is the PlaceBet `txId`. A loss needs
   * no call at all — the wager already settled to the casino at PlaceBet time. Paid once per
   * bet: the payout carries the key `settle:<betId>`, which the ledger accepts a single time.
   */
  async #settleBet(intent: SettleBetIntent): Promise<IntentResult> {
    assertNonEmpty(intent.betId, 'betId');
    const payout = this.#intentAmount(intent.payout, 'payout');

    const basePlayer = await this.#requirePlayerWallet(intent.actor, 'actor');

    const rawBet = await this.#backend.getTx(intent.betId);
    const bucket = requireBetBucket(rawBet);
    const player = await this.#bucketWallet(basePlayer, bucket);

    const bet = requireBet(rawBet, player.id);
    const casino = await this.#requireEntityWallet(bet.casino);
    // The claimed casino (from meta) must be where the wager's money actually went — otherwise
    // a PlaceBet-shaped row paid to entity A could be settled by naming a different entity B in
    // this check alone, same class of gap requireRental already closes for rentals.
    if (bet.to !== casino.id) {
      throw new UnknownBet('No such bet for this player');
    }

    let ref;
    try {
      ref = await this.#backend.transfer(casino.id, player.id, payout, {
        ...this.#memo(intent, `won at ${this.#displayName(bet.casino)}`),
        key: `settle:${intent.betId}`,
        meta: { bet: intent.betId },
      });
    } catch (cause) {
      if (cause instanceof DuplicateKey) throw new BetSettled(intent.betId);
      throw cause;
    }

    return await this.#result(
      ref,
      player.id,
      `Won ${this.#money(payout)} at ${this.#displayName(bet.casino)}.`,
    );
  }

  /**
   * player's dirty bucket -> the player's own chosen clean bucket, minus a cut to
   * `laundering.feeEntity`. The only path dirty money has back to being spendable.
   *
   * Two ledger writes, not one — a transfer only ever moves money between exactly two
   * wallets, and this moves it to two destinations (the player's clean bucket, and the fee
   * entity). Both run inside this engine's single intent-at-a-time lock, so nothing else can
   * observe a half-done state; the only way to see one is a process crash between the two
   * writes. If that happens, every HD is still visibly sitting in some real wallet (nothing
   * is burned or created) — just not yet moved to its second destination. No automatic
   * resumption: the top-level nonce replay guard answers an identical retry with the
   * already-settled result rather than re-entering this handler, so a stuck fee leg needs an
   * operator to notice (e.g. via verifyIntegrity) and move it manually. Documented, not solved.
   */
  async #launderMoney(intent: LaunderMoneyIntent): Promise<IntentResult> {
    if (intent.toBucket !== 'cash' && intent.toBucket !== 'bank') {
      throw new InvalidIntent(`toBucket must be "cash" or "bank", got ${JSON.stringify(intent.toBucket)}`);
    }
    const amount = this.#intentAmount(intent.amount, 'amount');

    const basePlayer = await this.#requirePlayerWallet(intent.actor, 'actor');
    const dirty = await this.#bucketWallet(basePlayer, 'dirty');
    const clean = await this.#bucketWallet(basePlayer, intent.toBucket);
    const feeEntity = await this.#requireEntityWallet(this.#config.laundering.feeEntity);

    const cutPercent = parsePercent(this.#config.laundering.cutPercent, 'laundering.cutPercent');
    const fee = (amount * cutPercent) / 100n;
    const net = amount - fee;
    requirePositive(net, 'amount after the laundering cut');

    const ref = await this.#backend.transfer(dirty.id, clean.id, net, {
      ...this.#memo(intent, `laundered into ${intent.toBucket}`),
      meta: { toBucket: intent.toBucket, fee: fee.toString() },
    });

    if (fee > 0n) {
      await this.#backend.transfer(dirty.id, feeEntity.id, fee, {
        intent: intent.type,
        nonce: `${intent.nonce}:fee`,
        detail: `laundering fee to ${this.#displayName(this.#config.laundering.feeEntity)}`,
      });
    }

    return await this.#result(
      ref,
      clean.id,
      `Laundered ${this.#money(net)} into ${intent.toBucket} (${this.#money(fee)} fee).`,
    );
  }

  /**
   * any configured entity (the lender) -> player, the principal. Interest is simple, charged
   * once here, never accruing further — `owed` (principal + interest) is stored in this tx's
   * own `meta` as the authoritative total due, since it can never be mutated later.
   */
  async #takeLoan(intent: TakeLoanIntent): Promise<IntentResult> {
    const principal = this.#intentAmount(intent.principal, 'principal');
    const interestPercent = parsePercent(this.#config.loans.interestPercent, 'loans.interestPercent');
    const owed = principal + (principal * interestPercent) / 100n;

    const lender = await this.#requireEntityWallet(intent.lender);
    const bucket = this.#resolveBucket(intent.bucket, this.#config.walletBuckets.loan);
    const basePlayer = await this.#requirePlayerWallet(intent.actor, 'actor');
    const player = await this.#bucketWallet(basePlayer, bucket);

    const ref = await this.#backend.transfer(lender.id, player.id, principal, {
      ...this.#memo(intent, `loan from ${this.#displayName(intent.lender)}`),
      meta: { lender: intent.lender, owed: owed.toString() },
    });

    return await this.#result(
      ref,
      player.id,
      `Borrowed ${this.#money(principal)} from ${this.#displayName(intent.lender)}; ${this.#money(owed)} owed in total.`,
    );
  }

  /**
   * player -> the loan's lender, an installment or the final payment. Always debited from
   * `loans.repaymentBucket` (see RepayLoanIntent) so "how much has this player repaid toward
   * loan X" is answerable by scanning exactly that one wallet's history for RepayLoan txs
   * naming this loanId — the engine has no secondary index by meta field, so this is a real
   * O(that wallet's history) scan, not a stored running balance. Fine for a friends server;
   * documented, not hidden.
   */
  async #repayLoan(intent: RepayLoanIntent): Promise<IntentResult> {
    assertNonEmpty(intent.loanId, 'loanId');
    const amount = this.#intentAmount(intent.amount, 'amount');

    const basePlayer = await this.#requirePlayerWallet(intent.actor, 'actor');
    const player = await this.#bucketWallet(basePlayer, this.#config.loans.repaymentBucket);

    const loan = await this.#requireLoan(await this.#backend.getTx(intent.loanId), intent.actor);
    const lender = await this.#requireEntityWallet(loan.lender);

    const repaidSoFar = await this.#repaidSoFar(player.id, intent.loanId);
    const remaining = loan.owed - repaidSoFar;
    if (remaining <= 0n) throw new LoanClosed(intent.loanId);
    if (amount > remaining) {
      throw new InvalidIntent(`amount (${this.#money(amount)}) exceeds the ${this.#money(remaining)} still owed on this loan`);
    }

    const ref = await this.#backend.transfer(player.id, lender.id, amount, {
      ...this.#memo(intent, `loan repayment to ${this.#displayName(loan.lender)}`),
      meta: { loan: intent.loanId },
    });

    return await this.#result(
      ref,
      player.id,
      `Repaid ${this.#money(amount)} to ${this.#displayName(loan.lender)}; ${this.#money(remaining - amount)} still owed.`,
    );
  }

  /**
   * player's money -> business, `shares * pricePerShare`; shares move the other way. Two
   * ledger writes (money, then shares), same reasoning as LaunderMoney: a transfer only ever
   * moves one thing between two wallets, and this moves two different things. A fixed-float
   * business draws shares out of `<id>#float`, so this fails with INSUFFICIENT_FUNDS — same
   * error a player would get overspending money — once the float runs out; an unlimited
   * business just mints the shares bought.
   */
  async #buyShares(intent: BuySharesIntent): Promise<IntentResult> {
    const shareCount = requireWholeCount(intent.shares, 'shares');
    const pricePerShare = this.#intentAmount(intent.pricePerShare, 'pricePerShare');
    const cost = pricePerShare * BigInt(shareCount);
    requirePositive(cost, 'cost');

    const float = this.#requireTradeable(intent.business);
    const business = await this.#requireEntityWallet(intent.business);
    const bucket = this.#resolveBucket(intent.bucket, this.#config.walletBuckets.shares);
    const basePlayer = await this.#requirePlayerWallet(intent.actor, 'actor');
    const money = await this.#bucketWallet(basePlayer, bucket);
    const playerShares = await this.#shareWallet(basePlayer, intent.business);

    const ref = await this.#backend.transfer(money.id, business.id, cost, {
      ...this.#memo(intent, `bought ${shareCount} shares of ${this.#displayName(intent.business)}`),
      meta: { business: intent.business, shares: String(shareCount) },
    });

    if (float.totalShares !== null) {
      const floatWallet = await this.#floatWallet(intent.business);
      await this.#backend.transfer(floatWallet.id, playerShares.id, BigInt(shareCount), {
        intent: intent.type,
        nonce: `${intent.nonce}:shares`,
        detail: `${shareCount} shares of ${this.#displayName(intent.business)} from the float`,
      });
    } else {
      await this.#backend.mint(playerShares.id, BigInt(shareCount), {
        intent: intent.type,
        nonce: `${intent.nonce}:shares`,
        detail: `${shareCount} shares of ${this.#displayName(intent.business)}, minted on demand`,
      });
    }

    const newShares = await this.#balanceOrNull(playerShares.id);
    return {
      ok: true,
      txId: ref.txId,
      hash: ref.hash,
      newBalance: newShares,
      message: `Bought ${shareCount} shares of ${this.#displayName(intent.business)} for ${this.#money(cost)}. You now hold ${newShares ?? '?'} shares.`,
    };
  }

  /** The reverse of #buyShares: shares move to the business/float, money moves to the player. */
  async #sellShares(intent: SellSharesIntent): Promise<IntentResult> {
    const shareCount = requireWholeCount(intent.shares, 'shares');
    const pricePerShare = this.#intentAmount(intent.pricePerShare, 'pricePerShare');
    const proceeds = pricePerShare * BigInt(shareCount);
    requirePositive(proceeds, 'proceeds');

    const float = this.#requireTradeable(intent.business);
    const business = await this.#requireEntityWallet(intent.business);
    const bucket = this.#resolveBucket(intent.bucket, this.#config.walletBuckets.shares);
    const basePlayer = await this.#requirePlayerWallet(intent.actor, 'actor');
    const money = await this.#bucketWallet(basePlayer, bucket);
    const playerShares = await this.#shareWallet(basePlayer, intent.business);

    if (float.totalShares !== null) {
      const floatWallet = await this.#floatWallet(intent.business);
      await this.#backend.transfer(playerShares.id, floatWallet.id, BigInt(shareCount), {
        intent: intent.type,
        nonce: `${intent.nonce}:shares`,
        detail: `${shareCount} shares of ${this.#displayName(intent.business)} back to the float`,
      });
    } else {
      await this.#backend.burn(playerShares.id, BigInt(shareCount), {
        intent: intent.type,
        nonce: `${intent.nonce}:shares`,
        detail: `${shareCount} shares of ${this.#displayName(intent.business)}, burned on sale`,
      });
    }

    const ref = await this.#backend.transfer(business.id, money.id, proceeds, {
      ...this.#memo(intent, `sold ${shareCount} shares of ${this.#displayName(intent.business)}`),
      meta: { business: intent.business, shares: String(shareCount) },
    });

    return await this.#result(
      ref,
      money.id,
      `Sold ${shareCount} shares of ${this.#displayName(intent.business)} for ${this.#money(proceeds)}.`,
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

  /** The intent's own override if present, else the configured default for this operation. */
  #resolveBucket(explicit: WalletBucket | undefined, configured: WalletBucket): WalletBucket {
    if (explicit === undefined) return configured;
    if (!isWalletBucket(explicit)) {
      throw new InvalidIntent(`bucket must be one of ${WALLET_BUCKETS.join(' | ')}, got ${JSON.stringify(explicit)}`);
    }
    return explicit;
  }

  /**
   * The wallet for one money bucket of a player who already has a cash-bucket account (the
   * wallet OpenAccount created). 'cash' IS that same wallet, unsuffixed — exactly the original
   * single-balance design, so a server using only 'cash' everywhere never creates another
   * wallet at all. 'bank'/'dirty' are separate ledger wallets (owner id `${base}#bucket`),
   * created lazily on first use, each with its own address and keypair.
   */
  async #bucketWallet(player: Wallet, bucket: WalletBucket): Promise<Wallet> {
    if (bucket === 'cash') return player;
    return await this.#ensureWallet(`${player.ownerId}#${bucket}`, false);
  }

  /** A player's share-holding wallet for one business — `${base}#shares:<business>`, lazy. */
  async #shareWallet(player: Wallet, business: OwnerId): Promise<Wallet> {
    return await this.#ensureWallet(`${player.ownerId}#shares:${business}`, false);
  }

  /** A fixed-float business's unsold-shares wallet — `${business}#float`. Seeded once in init(). */
  async #floatWallet(business: OwnerId): Promise<Wallet> {
    return await this.#ensureWallet(`${business}#float`, false);
  }

  /** The configured float cap for a tradeable business, or throws if it isn't one at all. */
  #requireTradeable(business: unknown): { totalShares: bigint | null } {
    if (typeof business !== 'string' || business === '') {
      throw new InvalidIntent('business must be a non-empty string');
    }
    const entry = own(this.#config.shares.businesses, business);
    if (entry === undefined) {
      throw new InvalidIntent(
        `"${business}" is not a tradeable business — add it to config under shares.businesses`,
      );
    }
    return {
      totalShares:
        entry.totalShares === undefined
          ? null
          : parseAmount(entry.totalShares, `shares.businesses.${business}.totalShares`),
    };
  }

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

  /**
   * The lender and total owed for a loan, read from the TakeLoan tx's structured `meta`. Throws
   * UnknownLoan unless the tx really is a TakeLoan paid TO this actor, so one player cannot cite
   * another's loan. Ownership is checked by owner id (bucket-suffix stripped), not WalletId
   * equality, since TakeLoan's destination bucket is config-driven and not passed back in here.
   */
  async #requireLoan(tx: Tx | null, actorOwnerId: OwnerId): Promise<{ lender: OwnerId; owed: bigint }> {
    const lender = tx?.memo.meta?.['lender'];
    const owedRaw = tx?.memo.meta?.['owed'];
    if (
      tx === null ||
      tx.kind !== 'transfer' ||
      tx.memo.intent !== 'TakeLoan' ||
      tx.to === null ||
      typeof lender !== 'string' ||
      lender === '' ||
      typeof owedRaw !== 'string' ||
      !/^[0-9]{1,30}$/.test(owedRaw)
    ) {
      throw new UnknownLoan('No such loan for this player');
    }
    const toWallet = await this.#backend.getWallet(tx.to);
    if (toWallet === null || stripBucketSuffix(toWallet.ownerId) !== actorOwnerId) {
      throw new UnknownLoan('No such loan for this player');
    }
    return { lender, owed: BigInt(owedRaw) };
  }

  /**
   * Sum of every RepayLoan transfer OUT of `walletId` naming `loanId` — the full history of
   * that one wallet, paged. There is no backend query by meta field, so this is the real cost
   * of "how much has been repaid": bounded to one player's own repayment activity (see
   * RepayLoanIntent), not every wallet in the economy.
   */
  async #repaidSoFar(walletId: WalletId, loanId: TxId): Promise<bigint> {
    let total = 0n;
    let cursor: string | undefined;
    for (;;) {
      const page = await this.#backend.history(walletId, cursor);
      for (const tx of page.txs) {
        if (tx.kind === 'transfer' && tx.from === walletId && tx.memo.intent === 'RepayLoan' && tx.memo.meta?.['loan'] === loanId) {
          total += tx.amount;
        }
      }
      if (page.cursor === null) break;
      cursor = page.cursor;
    }
    return total;
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
    value !== value.normalize('NFC') || // "café" typed two ways is one id, not two grants
    // '#' is reserved for internal bucket wallet keys (`${ownerId}#bank`). Without this, an
    // adapter submitting actor "player-1#bank" would collide with player-1's OWN bank wallet.
    value.includes('#')
  ) {
    throw new InvalidIntent(
      `${field} must be a 1-128 character NFC-normalized id with no padding, control, invisible or "#" characters`,
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
 * Strip a trailing `#bucket` suffix off an internal bucket-wallet owner id, back to the
 * player's real OwnerId. A no-op for the base ('cash') wallet, which was never suffixed.
 */
function stripBucketSuffix(ownerId: OwnerId): OwnerId {
  const i = ownerId.lastIndexOf('#');
  if (i === -1) return ownerId;
  return isWalletBucket(ownerId.slice(i + 1)) ? ownerId.slice(0, i) : ownerId;
}

/**
 * The bucket a rental was paid from, read from its structured `meta`. Missing (a rental from
 * before this feature existed) defaults to 'cash' — the only bucket that ever existed before.
 * A present-but-invalid value means the tx cannot really be a rental: reported the same as any
 * other malformed rental, not a crash, and without creating a stray wallet for a garbage name.
 */
function requireRentalBucket(rental: Tx | null): WalletBucket {
  const raw = rental?.memo.meta?.['bucket'];
  if (raw === undefined) return 'cash';
  if (isWalletBucket(raw)) return raw;
  throw new UnknownRental('No such rental for this player');
}

/** Same idea as requireRentalBucket, for a PlaceBet's wager bucket. */
function requireBetBucket(bet: Tx | null): WalletBucket {
  const raw = bet?.memo.meta?.['bucket'];
  if (raw === undefined) return 'cash';
  if (isWalletBucket(raw)) return raw;
  throw new UnknownBet('No such bet for this player');
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

/**
 * The bet tx's claimed casino OWNER id (from its structured `meta`) and where its money actually
 * went. Throws UnknownBet unless the tx really is a PlaceBet payment from this player, so one
 * player cannot cite another's bet (or any non-bet tx) to collect a payout. The caller still must
 * check `to` against the casino id's resolved wallet — this only validates the tx's shape, not
 * that the claimed casino is who was actually paid (see the call site). The same message covers
 * every mismatch: it must not reveal whether some other player's tx id exists.
 */
function requireBet(bet: Tx | null, playerWallet: WalletId): { casino: OwnerId; to: WalletId } {
  const casino = bet?.memo.meta?.['casino'];
  if (
    bet === null ||
    bet.kind !== 'transfer' ||
    bet.memo.intent !== 'PlaceBet' ||
    bet.from !== playerWallet ||
    bet.to === null ||
    typeof casino !== 'string' ||
    casino === ''
  ) {
    throw new UnknownBet('No such bet for this player');
  }
  return { casino, to: bet.to };
}

/** Only reachable if an adapter sends a type outside the union. */
function unknownType(intent: never): string {
  return String((intent as { type?: unknown }).type);
}
