// Config loading and validation.
//
// The SPEC's "Config example" is written as YAML. There is no YAML dependency in
// this project and none is permitted (zero external deps), so the on-disk format
// is JSON and the file is named `heist.config.json`. The shape is otherwise a
// one-to-one mapping of the SPEC example, with snake_case keys folded to camelCase.
//
// Money rule (see docs/adr/0002): every amount is a decimal STRING in config and
// a bigint in code. Nothing in the money path is ever a JS number — `JSON.parse`
// would silently turn 9007199254740993 into a float, so numeric amounts in the
// config file are rejected outright rather than coerced.

import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { EngineError, InvalidAmount, InvalidIntent, UnknownEntity } from '../errors.ts';
import type { BackendName } from '../ledger/backend.ts';

/** An NPC/system account. `treasury` is mandatory — it is the mint source. */
export interface EntityConfig {
  id: string;
  /** Display name shown in-game, e.g. "Crystal Bikes". */
  name?: string;
}

/** A purchasable service: who collects the money, and how much. */
export interface ServiceConfig {
  /** Entity id that receives the payment. MUST match a configured entity. */
  entity: string;
  /** Price per unit. Decimal string. */
  price: string;
}

export interface HeistConfig {
  backend: BackendName;
  /** Currency ticker. Cosmetic — the ledger is single-currency by design. */
  currency: string;
  /** Minted from treasury to a new player on OpenAccount. Decimal string. */
  welcomeGrant: string;
  /**
   * BuyService catalog: service name -> { payee entity, price }. This is the
   * ONLY source of truth for BuyService. The payee is explicit precisely so a
   * new service can never be silently routed to the wrong entity by a name
   * heuristic — an unknown entity here is a load-time failure.
   */
  services: Record<string, ServiceConfig>;
  /**
   * Non-service costs keyed by name, decimal strings. e.g. the `bike_rental`
   * flat fee used when a vehicle has no per-minute rate. NOT used by BuyService.
   */
  prices: Record<string, string>;
  /** vehicle key -> per-minute rental rate, decimal strings. */
  rentalPerMinute: Record<string, string>;
  entities: EntityConfig[];
  /**
   * Owner ids of staff who may authorize privileged intents (currently: Theft, alongside
   * the victim's own consent). Never an entity id. The engine checks the claimed id against
   * this list; that the claim is genuine is the adapter-auth layer's job (docs/adr/0004).
   */
  admins: string[];
  /** Filesystem path for the sqlite backend. Ignored by other backends. */
  dbPath?: string;
  /** Connection string for the postgres backend. Ignored by other backends. */
  databaseUrl?: string;
}

/** The entity that every economy must have: mint source and fine collector. */
export const TREASURY_ID = 'treasury';

const BACKEND_NAMES: readonly BackendName[] = ['memory', 'sqlite', 'postgres', 'solana'];

const DEFAULT_CONFIG_FILENAME = 'heist.config.json';

// ---------------------------------------------------------------------------
// Money parsing
// ---------------------------------------------------------------------------

/** More digits than this is not a plausible amount and is refused before BigInt sees it. */
const MAX_AMOUNT_DIGITS = 30;

/**
 * Parse a decimal money string into whole-HD bigint, for any caller (an intent off the wire, a
 * config value). Throws InvalidAmount with a message about the value only — no "config:" — so it
 * can be shown to an adapter as it stands. `parseAmount` below is the config-flavoured wrapper.
 *
 * Accepts "500", "0", "500.00" (a zero fractional part is tolerated so hand-written
 * config does not blow up). Rejects negatives, fractions of an HD, exponent notation,
 * anything non-numeric, and absurdly long numbers. `field` names the value in the message.
 */
export function parseAmountText(value: unknown, field: string): bigint {
  if (typeof value !== 'string') {
    throw new InvalidAmount(
      `${field} must be a decimal string, got ${describe(value)}. ` +
        `Money is never a JSON number — quote it, e.g. "500".`,
    );
  }
  const trimmed = value.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (match === null) {
    throw new InvalidAmount(`${field} is not a non-negative decimal string: ${JSON.stringify(value)}`);
  }
  const fraction = match[2];
  if (fraction !== undefined && /[^0]/.test(fraction)) {
    throw new InvalidAmount(
      `${field} = ${JSON.stringify(value)} has a fractional part. HD is indivisible — amounts must be whole.`,
    );
  }
  // match[1] is guaranteed by the regex; noUncheckedIndexedAccess needs the guard.
  const whole = match[1];
  if (whole === undefined) {
    throw new InvalidAmount(`${field} could not be parsed: ${JSON.stringify(value)}`);
  }
  if (whole.replace(/^0+(?=\d)/, '').length > MAX_AMOUNT_DIGITS) {
    throw new InvalidAmount(`${field} has more than ${MAX_AMOUNT_DIGITS} digits`);
  }
  return BigInt(whole);
}

/** Config-flavoured `parseAmountText`: same grammar, but a bad value is a config error. */
export function parseAmount(value: string, field: string): bigint {
  try {
    return parseAmountText(value, field);
  } catch (cause) {
    if (cause instanceof InvalidAmount) throw new InvalidIntent(`config: ${cause.message}`);
    throw cause;
  }
}

/**
 * Own-property lookup. A plain `record[name]` also finds `constructor`, `toString` and friends
 * on the prototype, so a vehicle or service NAMED that would resolve to a function.
 */
export function own<T>(record: Readonly<Record<string, T>>, name: string): T | undefined {
  return Object.hasOwn(record, name) ? record[name] : undefined;
}

/**
 * The payee entity and price of a catalog service.
 *
 * Throws `UnknownEntity` for a service that is not in the catalog — from the
 * caller's point of view there is simply no entity behind that name to pay.
 * The entity itself is guaranteed to exist by load-time validation.
 */
export function serviceOf(
  config: HeistConfig,
  name: string,
): { entity: string; price: bigint } {
  const entry = own(config.services, name);
  if (entry === undefined) {
    throw new UnknownEntity(name);
  }
  return { entity: entry.entity, price: parseAmount(entry.price, `services.${name}.price`) };
}

/** Price of a non-service cost as bigint. Throws InvalidIntent for unknown keys. */
export function priceOf(config: HeistConfig, service: string): bigint {
  const raw = own(config.prices, service);
  if (raw === undefined) {
    throw new InvalidIntent(`No price configured for service "${service}"`);
  }
  return parseAmount(raw, `prices.${service}`);
}

/** Per-minute rental rate of a vehicle as bigint. Throws InvalidIntent for unknown keys. */
export function rentalRateOf(config: HeistConfig, vehicle: string): bigint {
  const raw = own(config.rentalPerMinute, vehicle);
  if (raw === undefined) {
    throw new InvalidIntent(`No rental rate configured for vehicle "${vehicle}"`);
  }
  return parseAmount(raw, `rentalPerMinute.${vehicle}`);
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * A sane, playable default matching the SPEC's example config plus the entity
 * table in "Entity wallets". Kept in sync with src/config/heist.config.json —
 * that file is this function serialised.
 */
export function defaultConfig(): HeistConfig {
  return {
    backend: 'memory',
    currency: 'HD',
    welcomeGrant: '500',
    services: {
      hospital_full_heal: { entity: 'hospital', price: '200' },
      gas_per_liter: { entity: 'gas-station-1', price: '2' },
      impound_release: { entity: 'pd-impound', price: '250' },
      sedan_purchase: { entity: 'car-dealer', price: '15000' },
      apartment_rent: { entity: 'realty-office', price: '100' },
    },
    prices: {
      bike_rental: '10',
    },
    rentalPerMinute: {
      bike: '1',
      car: '3',
      helicopter: '25',
    },
    entities: [
      { id: 'treasury', name: 'City Treasury' },
      { id: 'bike-rental-co', name: 'Crystal Bikes' },
      { id: 'hospital', name: 'Pillbox Medical' },
      { id: 'gas-station-1', name: 'Xero Gas — Strawberry' },
      { id: 'taxi-co', name: 'Downtown Cab Co.' },
      { id: 'pd-payroll', name: 'LSPD Payroll' },
      { id: 'pd-impound', name: 'Impound Lot' },
      { id: 'car-dealer', name: 'Westside Motors' },
      { id: 'realty-office', name: 'Skyline Realty' },
      { id: 'casino-house', name: 'Golden Chip Casino' },
    ],
    admins: [],
  };
}

// ---------------------------------------------------------------------------
// Loading + validation
// ---------------------------------------------------------------------------

/**
 * Read and validate a config file.
 *
 * With no argument it looks for `heist.config.json` in the current working
 * directory. Missing/unreadable file, bad JSON, or any invalid field throws —
 * a half-valid economy config is worse than no economy at all.
 */
export function loadConfig(path?: string): HeistConfig {
  const target =
    path === undefined
      ? resolve(process.cwd(), DEFAULT_CONFIG_FILENAME)
      : isAbsolute(path)
        ? path
        : resolve(process.cwd(), path);

  let text: string;
  try {
    text = readFileSync(target, 'utf8');
  } catch (cause) {
    throw new EngineError(
      'CONFIG_UNREADABLE',
      `Cannot read config at ${target}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new EngineError(
      'CONFIG_MALFORMED',
      `Config at ${target} is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  return validateConfig(parsed, target);
}

/**
 * Validate an already-parsed config object and apply defaults.
 * Exported so tests and the CLI can validate an inline object without a file.
 */
export function validateConfig(input: unknown, source = '<inline>'): HeistConfig {
  if (!isRecord(input)) {
    throw new InvalidIntent(`config (${source}): expected a JSON object, got ${describe(input)}`);
  }

  const defaults = defaultConfig();

  // backend ----------------------------------------------------------------
  const backendRaw = input['backend'] ?? defaults.backend;
  if (typeof backendRaw !== 'string' || !isBackendName(backendRaw)) {
    throw new InvalidIntent(
      `config (${source}): backend must be one of ${BACKEND_NAMES.join(' | ')}, got ${describe(backendRaw)}`,
    );
  }
  const backend: BackendName = backendRaw;

  // currency ---------------------------------------------------------------
  const currencyRaw = input['currency'] ?? defaults.currency;
  if (typeof currencyRaw !== 'string' || currencyRaw.trim() === '') {
    throw new InvalidIntent(
      `config (${source}): currency must be a non-empty string, got ${describe(currencyRaw)}`,
    );
  }
  const currency = currencyRaw.trim();

  // welcomeGrant -----------------------------------------------------------
  const welcomeGrantRaw = input['welcomeGrant'] ?? defaults.welcomeGrant;
  if (typeof welcomeGrantRaw !== 'string') {
    throw new InvalidIntent(
      `config (${source}): welcomeGrant must be a decimal string, got ${describe(welcomeGrantRaw)}`,
    );
  }
  requirePositiveAtLoad(parseAmount(welcomeGrantRaw, 'welcomeGrant'), 'welcomeGrant', source);
  const welcomeGrant = welcomeGrantRaw.trim();

  // prices / rentalPerMinute -----------------------------------------------
  const prices = readAmountMap(input['prices'], 'prices', defaults.prices, source);
  const rentalPerMinute = readAmountMap(
    input['rentalPerMinute'],
    'rentalPerMinute',
    defaults.rentalPerMinute,
    source,
  );

  // entities ---------------------------------------------------------------
  // Read before services: the service catalog is checked against these ids, and
  // a service pointing at a non-existent entity must fail here, at startup,
  // rather than pay the wrong entity at runtime.
  const entities = readEntities(input['entities'] ?? defaults.entities, source);

  // services ---------------------------------------------------------------
  const services = readServices(
    input['services'],
    defaults.services,
    new Set(entities.map((e) => e.id)),
    source,
  );

  const admins = readAdmins(input['admins'], defaults.admins, entities, source);

  const config: HeistConfig = {
    backend,
    currency,
    welcomeGrant,
    services,
    prices,
    rentalPerMinute,
    entities,
    admins,
  };

  // dbPath — optional, and under exactOptionalPropertyTypes it must be omitted
  // entirely rather than set to undefined.
  const dbPathRaw = input['dbPath'];
  if (dbPathRaw !== undefined && dbPathRaw !== null) {
    if (typeof dbPathRaw !== 'string' || dbPathRaw.trim() === '') {
      throw new InvalidIntent(
        `config (${source}): dbPath must be a non-empty string when present, got ${describe(dbPathRaw)}`,
      );
    }
    config.dbPath = dbPathRaw;
  }
  if (backend === 'sqlite' && config.dbPath === undefined) {
    throw new InvalidIntent(`config (${source}): backend "sqlite" requires dbPath`);
  }

  // databaseUrl — same optionality rules as dbPath above.
  const databaseUrlRaw = input['databaseUrl'];
  if (databaseUrlRaw !== undefined && databaseUrlRaw !== null) {
    if (typeof databaseUrlRaw !== 'string' || databaseUrlRaw.trim() === '') {
      throw new InvalidIntent(
        `config (${source}): databaseUrl must be a non-empty string when present, got ${describe(databaseUrlRaw)}`,
      );
    }
    config.databaseUrl = databaseUrlRaw;
  }
  if (backend === 'postgres' && config.databaseUrl === undefined) {
    throw new InvalidIntent(`config (${source}): backend "postgres" requires databaseUrl`);
  }

  return config;
}

function readAmountMap(
  raw: unknown,
  field: string,
  fallback: Record<string, string>,
  source: string,
): Record<string, string> {
  if (raw === undefined || raw === null) return { ...fallback };
  if (!isRecord(raw)) {
    throw new InvalidIntent(
      `config (${source}): ${field} must be an object of key -> decimal string, got ${describe(raw)}`,
    );
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.trim() === '') {
      throw new InvalidIntent(`config (${source}): ${field} has an empty key`);
    }
    if (key === '__proto__') {
      throw new InvalidIntent(`config (${source}): ${field} may not use the key "__proto__"`);
    }
    if (typeof value !== 'string') {
      throw new InvalidIntent(
        `config (${source}): ${field}.${key} must be a decimal string, got ${describe(value)}. ` +
          `Quote money values — JSON numbers are floats.`,
      );
    }
    requirePositiveAtLoad(parseAmount(value, `${field}.${key}`), `${field}.${key}`, source);
    out[key] = value.trim();
  }
  return out;
}

/**
 * Read the BuyService catalog, checking every payee against the configured
 * entity ids. An unknown entity throws immediately and names the service, so a
 * typo is a startup failure instead of a silent mispayment.
 */
function readServices(
  raw: unknown,
  fallback: Record<string, ServiceConfig>,
  entityIds: ReadonlySet<string>,
  source: string,
): Record<string, ServiceConfig> {
  const input = raw === undefined || raw === null ? fallback : raw;
  if (!isRecord(input)) {
    throw new InvalidIntent(
      `config (${source}): services must be an object of name -> { entity, price }, got ${describe(raw)}`,
    );
  }

  const out: Record<string, ServiceConfig> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key.trim() === '') {
      throw new InvalidIntent(`config (${source}): services has an empty key`);
    }
    if (key === '__proto__') {
      throw new InvalidIntent(`config (${source}): services may not use the key "__proto__"`);
    }
    if (!isRecord(value)) {
      throw new InvalidIntent(
        `config (${source}): services.${key} must be an object like ` +
          `{ "entity": "hospital", "price": "200" }, got ${describe(value)}`,
      );
    }

    const entity = value['entity'];
    if (typeof entity !== 'string' || entity.trim() === '') {
      throw new InvalidIntent(
        `config (${source}): services.${key}.entity must be a non-empty string, got ${describe(entity)}`,
      );
    }
    const entityId = entity.trim();
    if (!entityIds.has(entityId)) {
      throw new InvalidIntent(
        `config (${source}): services.${key}.entity = ${JSON.stringify(entityId)} is not a ` +
          `configured entity id. Add it to "entities" or point the service at one of: ` +
          `${[...entityIds].join(', ')}`,
      );
    }

    const price = value['price'];
    if (typeof price !== 'string') {
      throw new InvalidIntent(
        `config (${source}): services.${key}.price must be a decimal string, got ${describe(price)}. ` +
          `Quote money values — JSON numbers are floats.`,
      );
    }
    requirePositiveAtLoad(parseAmount(price, `services.${key}.price`), `services.${key}.price`, source);

    out[key] = { entity: entityId, price: price.trim() };
  }
  return out;
}

function readAdmins(
  raw: unknown,
  fallback: string[],
  entities: EntityConfig[],
  source: string,
): string[] {
  if (raw === undefined || raw === null) return [...fallback];
  if (!Array.isArray(raw)) {
    throw new InvalidIntent(`config (${source}): admins must be an array of owner ids, got ${describe(raw)}`);
  }
  const reserved = new Set(entities.map((e) => e.id.toLowerCase()));
  const out: string[] = [];
  for (const item of raw as unknown[]) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new InvalidIntent(`config (${source}): admins entries must be non-empty strings, got ${describe(item)}`);
    }
    const id = item.trim();
    if (reserved.has(id.toLowerCase())) {
      throw new InvalidIntent(`config (${source}): admin "${id}" collides with an entity id`);
    }
    if (out.includes(id)) {
      throw new InvalidIntent(`config (${source}): duplicate admin "${id}"`);
    }
    out.push(id);
  }
  return out;
}

function readEntities(raw: unknown, source: string): EntityConfig[] {
  if (!Array.isArray(raw)) {
    throw new InvalidIntent(
      `config (${source}): entities must be an array, got ${describe(raw)}`,
    );
  }
  if (raw.length === 0) {
    throw new InvalidIntent(`config (${source}): entities must not be empty`);
  }

  const out: EntityConfig[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < raw.length; i++) {
    const item: unknown = raw[i];
    if (!isRecord(item)) {
      throw new InvalidIntent(
        `config (${source}): entities[${i}] must be an object like { "id": "hospital" }, got ${describe(item)}`,
      );
    }
    const id = item['id'];
    if (typeof id !== 'string' || id.trim() === '') {
      throw new InvalidIntent(
        `config (${source}): entities[${i}].id must be a non-empty string, got ${describe(id)}`,
      );
    }
    const trimmedId = id.trim();
    if (seen.has(trimmedId)) {
      throw new InvalidIntent(`config (${source}): duplicate entity id "${trimmedId}"`);
    }
    seen.add(trimmedId);

    const entity: EntityConfig = { id: trimmedId };

    const name = item['name'];
    if (name !== undefined && name !== null) {
      if (typeof name !== 'string' || name.trim() === '') {
        throw new InvalidIntent(
          `config (${source}): entities[${i}].name must be a non-empty string when present, got ${describe(name)}`,
        );
      }
      entity.name = name.trim();
    }

    out.push(entity);
  }

  // The one entity the engine cannot synthesise: mints originate here and fines
  // land here. Without it OpenAccount and Fine have nowhere to point.
  if (!seen.has(TREASURY_ID)) {
    throw new InvalidIntent(
      `config (${source}): entities must include "${TREASURY_ID}" — it is the mint source for ` +
        `welcome grants and payouts and the payee for fines.`,
    );
  }

  return out;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** A zero price or grant is a config mistake (free everything, or a grant that grants nothing). */
function requirePositiveAtLoad(amount: bigint, field: string, source: string): void {
  if (amount <= 0n) {
    throw new InvalidIntent(`config (${source}): ${field} must be greater than zero, got ${amount.toString()}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBackendName(value: string): value is BackendName {
  return (BACKEND_NAMES as readonly string[]).includes(value);
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'string' ? JSON.stringify(value) : `${typeof value} (${String(value)})`;
}
