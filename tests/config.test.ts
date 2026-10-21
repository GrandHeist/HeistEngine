// Config tests. The theme is that a bad economy config must fail at LOAD time,
// loudly, rather than mispay an entity or silently float a money value at
// runtime. See docs/adr/0002 for why numbers are refused outright.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { EngineError } from '../src/errors.ts';
import {
  TREASURY_ID,
  defaultConfig,
  loadConfig,
  own,
  parseAmount,
  parseAmountText,
  priceOf,
  rentalRateOf,
  serviceOf,
  validateConfig,
} from '../src/config/config.ts';

const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** Writes `value` as JSON to a throwaway file and returns its path. */
function configFile(value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'heist-config-'));
  tempDirs.push(dir);
  const path = join(dir, 'heist.config.json');
  writeFileSync(path, JSON.stringify(value), 'utf8');
  return path;
}

function throwsWithCode(fn: () => unknown, code: string, why: string): void {
  assert.throws(
    fn,
    (error: unknown) => {
      assert.ok(error instanceof EngineError, `${why}: expected an EngineError, got ${String(error)}`);
      assert.equal(error.code, code, why);
      return true;
    },
    why,
  );
}

/** Shallow-clone the default config so a test can corrupt one field. */
function withDefaults(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...(defaultConfig() as unknown as Record<string, unknown>), ...overrides };
}

describe('defaultConfig', () => {
  test('round-trips through validation unchanged', () => {
    const original = defaultConfig();
    assert.deepEqual(validateConfig(original), original);
  });

  test('round-trips through JSON and validation unchanged', () => {
    const original = defaultConfig();
    const viaJson: unknown = JSON.parse(JSON.stringify(original));
    assert.deepEqual(validateConfig(viaJson), original);
  });

  test('validation is idempotent', () => {
    const once = validateConfig(defaultConfig());
    assert.deepEqual(validateConfig(once), once);
  });

  test('every service points at a configured entity', () => {
    const config = defaultConfig();
    const ids = new Set(config.entities.map((e) => e.id));
    for (const [name, service] of Object.entries(config.services)) {
      assert.ok(ids.has(service.entity), `service ${name} points at unknown entity`);
    }
    assert.ok(ids.has(TREASURY_ID));
  });

  test('loads from disk through loadConfig', () => {
    const path = configFile(defaultConfig());
    assert.deepEqual(loadConfig(path), defaultConfig());
  });
});

describe('config — entities', () => {
  test('a config without a treasury throws', () => {
    const noTreasury = withDefaults({
      entities: [{ id: 'hospital' }],
      services: { hospital_full_heal: { entity: 'hospital', price: '200' } },
    });

    throwsWithCode(
      () => validateConfig(noTreasury),
      'INVALID_INTENT',
      'treasury is the mint source — its absence must be fatal',
    );
    assert.throws(() => validateConfig(noTreasury), /treasury/);
  });

  test('a config without a treasury throws at load time too', () => {
    const path = configFile(
      withDefaults({
        entities: [{ id: 'hospital' }],
        services: { hospital_full_heal: { entity: 'hospital', price: '200' } },
      }),
    );
    throwsWithCode(() => loadConfig(path), 'INVALID_INTENT', 'loadConfig must reject it too');
  });

  test('empty, non-array and duplicate entities are rejected', () => {
    throwsWithCode(
      () => validateConfig(withDefaults({ entities: [] })),
      'INVALID_INTENT',
      'empty entity list',
    );
    throwsWithCode(
      () => validateConfig(withDefaults({ entities: 'treasury' })),
      'INVALID_INTENT',
      'entities must be an array',
    );
    throwsWithCode(
      () =>
        validateConfig(
          withDefaults({ entities: [{ id: TREASURY_ID }, { id: TREASURY_ID }], services: {} }),
        ),
      'INVALID_INTENT',
      'duplicate entity id',
    );
    throwsWithCode(
      () => validateConfig(withDefaults({ entities: [{ id: '' }], services: {} })),
      'INVALID_INTENT',
      'empty entity id',
    );
  });
});

describe('config — services must resolve to a real entity AT LOAD TIME', () => {
  const broken = withDefaults({
    services: {
      taxi_ride: { entity: 'taxi-co-typo', price: '40' },
    },
  });

  test('validateConfig throws for a service pointing at an unconfigured entity', () => {
    throwsWithCode(
      () => validateConfig(broken),
      'INVALID_INTENT',
      'a mistyped payee must be a startup failure, never a runtime mispayment',
    );
  });

  test('the error names the offending service and the unknown entity', () => {
    assert.throws(() => validateConfig(broken), /taxi_ride/);
    assert.throws(() => validateConfig(broken), /taxi-co-typo/);
  });

  test('loadConfig throws for the same file — the failure is at load, not at use', () => {
    const path = configFile(broken);
    throwsWithCode(() => loadConfig(path), 'INVALID_INTENT', 'loadConfig must reject it');

    // And nothing partial escapes: there is no config object to call serviceOf on.
    let loaded: unknown;
    assert.throws(() => {
      loaded = loadConfig(path);
    });
    assert.equal(loaded, undefined);
  });

  test('a service pointing at a configured entity is accepted', () => {
    const ok = withDefaults({
      services: { taxi_ride: { entity: 'taxi-co', price: '40' } },
    });
    const config = validateConfig(ok);
    assert.deepEqual(serviceOf(config, 'taxi_ride'), { entity: 'taxi-co', price: 40n });
  });

  test('a malformed service entry is rejected', () => {
    for (const services of [
      { taxi_ride: 'taxi-co' },
      { taxi_ride: { price: '40' } },
      { taxi_ride: { entity: '', price: '40' } },
      { taxi_ride: { entity: 'taxi-co' } },
      { '': { entity: 'taxi-co', price: '40' } },
    ]) {
      throwsWithCode(
        () => validateConfig(withDefaults({ services })),
        'INVALID_INTENT',
        `malformed service entry ${JSON.stringify(services)}`,
      );
    }
  });
});

describe('config — rentalEntity must resolve to a real entity AT LOAD TIME', () => {
  test('validateConfig throws for a rentalEntity pointing at an unconfigured entity', () => {
    throwsWithCode(
      () => validateConfig(withDefaults({ rentalEntity: 'bike-rental-co-typo' })),
      'INVALID_INTENT',
      'a mistyped rental payee must be a startup failure, never a runtime mispayment',
    );
  });

  test('a server owner can point vehicle rentals at a different, custom entity', () => {
    const custom = withDefaults({
      entities: [...defaultConfig().entities, { id: 'crystal-bikes', name: 'Crystal Bikes' }],
      rentalEntity: 'crystal-bikes',
    });
    const config = validateConfig(custom);
    assert.equal(config.rentalEntity, 'crystal-bikes');
  });

  test('a malformed rentalEntity is rejected', () => {
    for (const rentalEntity of ['', '   '] as unknown[]) {
      throwsWithCode(
        () => validateConfig(withDefaults({ rentalEntity })),
        'INVALID_INTENT',
        `malformed rentalEntity ${JSON.stringify(rentalEntity)}`,
      );
    }
  });
});

describe('config — walletBuckets defaults to cash everywhere, overridable per key', () => {
  test('validateConfig applies the cash-everywhere default when walletBuckets is absent', () => {
    const config = validateConfig(withDefaults({}));
    for (const value of Object.values(config.walletBuckets)) {
      assert.equal(value, 'cash');
    }
  });

  test('a partial override merges with the defaults rather than replacing them', () => {
    const config = validateConfig(withDefaults({ walletBuckets: { payout: 'bank' } }));
    assert.equal(config.walletBuckets.payout, 'bank');
    assert.equal(config.walletBuckets.rental, 'cash', 'untouched keys keep their default');
  });

  test('an invalid bucket value is rejected', () => {
    throwsWithCode(
      () => validateConfig(withDefaults({ walletBuckets: { payout: 'crypto' } })),
      'INVALID_INTENT',
      'only cash | bank | dirty are valid buckets',
    );
  });

  test('an unknown walletBuckets key is rejected rather than silently ignored', () => {
    throwsWithCode(
      () => validateConfig(withDefaults({ walletBuckets: { rent: 'cash' } })), // typo for "rental"
      'INVALID_INTENT',
      'a typo\'d key must fail loudly, not be silently ignored',
    );
  });
});

describe('config — laundering must resolve to a real entity AT LOAD TIME', () => {
  test('defaults to a 10% cut paid to the treasury', () => {
    const config = validateConfig(withDefaults({}));
    assert.equal(config.laundering.cutPercent, '10');
    assert.equal(config.laundering.feeEntity, 'treasury');
  });

  test('feeEntity must be a configured entity id', () => {
    throwsWithCode(
      () => validateConfig(withDefaults({ laundering: { feeEntity: 'laundromat-that-does-not-exist' } })),
      'INVALID_INTENT',
      'a mistyped fee entity must be a startup failure',
    );
  });

  test('cutPercent accepts the edges (0 and 100) and rejects out-of-range or malformed values', () => {
    for (const cutPercent of ['0', '100']) {
      const config = validateConfig(withDefaults({ laundering: { cutPercent } }));
      assert.equal(config.laundering.cutPercent, cutPercent);
    }
    for (const cutPercent of ['101', '-5', '5.5', 'ten', '']) {
      throwsWithCode(
        () => validateConfig(withDefaults({ laundering: { cutPercent } })),
        'INVALID_INTENT',
        `cutPercent ${JSON.stringify(cutPercent)} must be rejected`,
      );
    }
  });
});

describe('config — loans', () => {
  test('defaults to 15% simple interest, repaid from cash', () => {
    const config = validateConfig(withDefaults({}));
    assert.equal(config.loans.interestPercent, '15');
    assert.equal(config.loans.repaymentBucket, 'cash');
  });

  test('interestPercent follows the same 0-100 whole-percent grammar as laundering.cutPercent', () => {
    throwsWithCode(
      () => validateConfig(withDefaults({ loans: { interestPercent: '101' } })),
      'INVALID_INTENT',
      'interestPercent must not exceed 100',
    );
  });

  test('repaymentBucket must be a real bucket', () => {
    throwsWithCode(
      () => validateConfig(withDefaults({ loans: { repaymentBucket: 'crypto' } })),
      'INVALID_INTENT',
      'only cash | bank | dirty are valid buckets',
    );
  });

  test('walletBuckets.loan defaults to cash and is overridable like every other key', () => {
    const config = validateConfig(withDefaults({ walletBuckets: { loan: 'bank' } }));
    assert.equal(config.walletBuckets.loan, 'bank');
  });
});

describe('config — shares.businesses must resolve to a real entity AT LOAD TIME', () => {
  test('defaults to no tradeable businesses at all', () => {
    const config = validateConfig(withDefaults({}));
    assert.deepEqual(config.shares.businesses, {});
  });

  test('a business key that is not a configured entity id is rejected', () => {
    throwsWithCode(
      () => validateConfig(withDefaults({ shares: { businesses: { 'not-an-entity': {} } } })),
      'INVALID_INTENT',
      'a mistyped business id must be a startup failure',
    );
  });

  test('totalShares, when present, follows the same money grammar as any other amount', () => {
    for (const totalShares of ['0', '-5', '1.5', 'abc']) {
      throwsWithCode(
        () => validateConfig(withDefaults({ shares: { businesses: { 'car-dealer': { totalShares } } } })),
        'INVALID_INTENT',
        `totalShares ${JSON.stringify(totalShares)} must be rejected`,
      );
    }
  });

  test('a business with no totalShares is accepted (the unlimited mint/burn model)', () => {
    const config = validateConfig(withDefaults({ shares: { businesses: { 'car-dealer': {} } } }));
    assert.deepEqual(config.shares.businesses, { 'car-dealer': {} });
  });

  test('a business with a valid totalShares is accepted (the fixed-float model)', () => {
    const config = validateConfig(withDefaults({ shares: { businesses: { 'car-dealer': { totalShares: '1000000' } } } }));
    assert.deepEqual(config.shares.businesses, { 'car-dealer': { totalShares: '1000000' } });
  });
});

describe('config — an entity id may not contain "#"', () => {
  test('validateConfig rejects it — "#" is reserved for internal bucket wallet keys', () => {
    throwsWithCode(
      () =>
        validateConfig(
          withDefaults({ entities: [...defaultConfig().entities, { id: 'player-1#bank', name: 'Oops' }] }),
        ),
      'INVALID_INTENT',
      'an entity id with "#" could collide with a player bucket wallet',
    );
  });
});

describe('config — money is never a JSON number', () => {
  test('a numeric welcomeGrant is rejected', () => {
    throwsWithCode(
      () => validateConfig(withDefaults({ welcomeGrant: 500 })),
      'INVALID_INTENT',
      'JSON numbers are floats — money must be quoted',
    );
  });

  test('a numeric price is rejected', () => {
    throwsWithCode(
      () => validateConfig(withDefaults({ prices: { bike_rental: 10 } })),
      'INVALID_INTENT',
      'prices.bike_rental as a number',
    );
  });

  test('a numeric rental rate is rejected', () => {
    throwsWithCode(
      () => validateConfig(withDefaults({ rentalPerMinute: { bike: 1 } })),
      'INVALID_INTENT',
      'rentalPerMinute.bike as a number',
    );
  });

  test('a numeric service price is rejected', () => {
    throwsWithCode(
      () =>
        validateConfig(
          withDefaults({ services: { hospital_full_heal: { entity: 'hospital', price: 200 } } }),
        ),
      'INVALID_INTENT',
      'services.hospital_full_heal.price as a number',
    );
  });

  test('the rejection survives a real JSON file — this is where floats would sneak in', () => {
    // 9007199254740993 cannot be represented as a double; JSON.parse would round it.
    const path = configFile({
      ...defaultConfig(),
      welcomeGrant: 9007199254740993,
    });
    throwsWithCode(() => loadConfig(path), 'INVALID_INTENT', 'numeric welcomeGrant on disk');
  });

  test('a quoted amount beyond 2^53 survives loading exactly', () => {
    const huge = '9007199254740993000';
    const path = configFile({ ...defaultConfig(), welcomeGrant: huge });
    const config = loadConfig(path);
    assert.equal(config.welcomeGrant, huge);
    assert.equal(parseAmount(config.welcomeGrant, 'welcomeGrant'), 9007199254740993000n);
  });
});

describe('config — fractional and malformed amounts', () => {
  test('a fractional price is rejected', () => {
    throwsWithCode(
      () => validateConfig(withDefaults({ prices: { bike_rental: '10.5' } })),
      'INVALID_INTENT',
      'HD is indivisible',
    );
    assert.throws(() => validateConfig(withDefaults({ prices: { bike_rental: '10.5' } })), /whole/);
  });

  test('a fractional service price is rejected', () => {
    throwsWithCode(
      () =>
        validateConfig(
          withDefaults({ services: { hospital_full_heal: { entity: 'hospital', price: '199.99' } } }),
        ),
      'INVALID_INTENT',
      'fractional service price',
    );
  });

  test('a fractional rental rate and welcome grant are rejected', () => {
    throwsWithCode(
      () => validateConfig(withDefaults({ rentalPerMinute: { bike: '0.5' } })),
      'INVALID_INTENT',
      'fractional rental rate',
    );
    throwsWithCode(
      () => validateConfig(withDefaults({ welcomeGrant: '500.01' })),
      'INVALID_INTENT',
      'fractional welcome grant',
    );
  });

  test('a zero fractional part is tolerated, as documented', () => {
    const config = validateConfig(withDefaults({ prices: { bike_rental: '10.00' } }));
    assert.equal(priceOf(config, 'bike_rental'), 10n);
  });

  test('negative and non-numeric amounts are rejected', () => {
    for (const bad of ['-1', '1e3', 'ten', '', ' ', '0x10', '1_000']) {
      throwsWithCode(
        () => validateConfig(withDefaults({ prices: { bike_rental: bad } })),
        'INVALID_INTENT',
        `price ${JSON.stringify(bad)}`,
      );
    }
  });
});

describe('config — lookups', () => {
  test('parseAmount reads whole values and rejects the rest', () => {
    assert.equal(parseAmount('0', 'x'), 0n);
    assert.equal(parseAmount('500', 'x'), 500n);
    assert.equal(parseAmount(' 500 ', 'x'), 500n);
    assert.equal(parseAmount('500.000', 'x'), 500n);
    assert.equal(parseAmount('9007199254740993000', 'x'), 9007199254740993000n);
    throwsWithCode(() => parseAmount('-1', 'x'), 'INVALID_INTENT', 'negative');
    throwsWithCode(() => parseAmount('1.5', 'x'), 'INVALID_INTENT', 'fractional');
  });

  test('unknown lookup keys throw rather than defaulting to zero', () => {
    const config = defaultConfig();
    throwsWithCode(() => serviceOf(config, 'nope'), 'UNKNOWN_ENTITY', 'unknown service');
    throwsWithCode(() => priceOf(config, 'nope'), 'INVALID_INTENT', 'unknown price key');
    throwsWithCode(() => rentalRateOf(config, 'nope'), 'INVALID_INTENT', 'unknown vehicle');
  });

  test('known lookup keys return bigints', () => {
    const config = defaultConfig();
    assert.equal(priceOf(config, 'bike_rental'), 10n);
    assert.equal(rentalRateOf(config, 'bike'), 1n);
    assert.equal(rentalRateOf(config, 'helicopter'), 25n);
    assert.deepEqual(serviceOf(config, 'gas_per_liter'), { entity: 'gas-station-1', price: 2n });
  });
});

describe('config — backend and dbPath', () => {
  test('an unknown backend is rejected', () => {
    throwsWithCode(
      () => validateConfig(withDefaults({ backend: 'mongodb' })),
      'INVALID_INTENT',
      'unknown backend name',
    );
  });

  test('the sqlite backend requires a dbPath', () => {
    throwsWithCode(
      () => validateConfig(withDefaults({ backend: 'sqlite' })),
      'INVALID_INTENT',
      'sqlite without dbPath',
    );
    const config = validateConfig(withDefaults({ backend: 'sqlite', dbPath: './heist.db' }));
    assert.equal(config.backend, 'sqlite');
    assert.equal(config.dbPath, './heist.db');
  });

  test('dbPath is omitted rather than set to undefined when absent', () => {
    const config = validateConfig(defaultConfig());
    assert.equal(Object.prototype.hasOwnProperty.call(config, 'dbPath'), false);
  });
});

describe('config — file errors', () => {
  test('an unreadable file throws CONFIG_UNREADABLE', () => {
    throwsWithCode(
      () => loadConfig(join(tmpdir(), 'definitely-not-here-heist.config.json')),
      'CONFIG_UNREADABLE',
      'missing file',
    );
  });

  test('malformed JSON throws CONFIG_MALFORMED', () => {
    const dir = mkdtempSync(join(tmpdir(), 'heist-config-'));
    tempDirs.push(dir);
    const path = join(dir, 'heist.config.json');
    writeFileSync(path, '{ not json', 'utf8');
    throwsWithCode(() => loadConfig(path), 'CONFIG_MALFORMED', 'bad JSON');
  });

  test('a non-object config throws', () => {
    throwsWithCode(() => loadConfig(configFile([1, 2, 3])), 'INVALID_INTENT', 'array config');
    throwsWithCode(() => loadConfig(configFile('nope')), 'INVALID_INTENT', 'string config');
  });

  test('the checked-in heist.config.json is valid', () => {
    const config = loadConfig(new URL('../src/config/heist.config.json', import.meta.url).pathname);
    assert.equal(config.currency.length > 0, true);
    const ids = new Set(config.entities.map((e) => e.id));
    assert.ok(ids.has(TREASURY_ID));
    for (const service of Object.values(config.services)) {
      assert.ok(ids.has(service.entity));
    }
  });
});

describe('config — admins', () => {
  test('default to none and round-trip', () => {
    assert.deepEqual(validateConfig({}).admins, []);
    assert.deepEqual(validateConfig(withDefaults({ admins: ['staff-1', ' staff-2 '] })).admins, [
      'staff-1',
      'staff-2',
    ]);
  });

  test('a non-array, non-string entry, duplicate or entity-id admin is rejected', () => {
    throwsWithCode(() => validateConfig(withDefaults({ admins: 'staff' })), 'INVALID_INTENT', 'non-array');
    throwsWithCode(() => validateConfig(withDefaults({ admins: [5] })), 'INVALID_INTENT', 'non-string');
    throwsWithCode(() => validateConfig(withDefaults({ admins: [''] })), 'INVALID_INTENT', 'empty');
    throwsWithCode(() => validateConfig(withDefaults({ admins: ['a', 'a'] })), 'INVALID_INTENT', 'dup');
    throwsWithCode(() => validateConfig(withDefaults({ admins: ['treasury'] })), 'INVALID_INTENT', 'entity');
    throwsWithCode(() => validateConfig(withDefaults({ admins: ['Treasury'] })), 'INVALID_INTENT', 'entity, other case');
  });
});

describe('config — zero is not a price', () => {
  test('a zero welcomeGrant, price, rental rate or service price is rejected at load', () => {
    for (const bad of ['0', '0.00', '000']) {
      throwsWithCode(() => validateConfig(withDefaults({ welcomeGrant: bad })), 'INVALID_INTENT', `grant ${bad}`);
    }
    throwsWithCode(
      () => validateConfig(withDefaults({ prices: { bike_rental: '0' } })),
      'INVALID_INTENT',
      'price 0',
    );
    throwsWithCode(
      () => validateConfig(withDefaults({ rentalPerMinute: { bike: '0' } })),
      'INVALID_INTENT',
      'rate 0',
    );
    throwsWithCode(
      () => validateConfig(withDefaults({ services: { heal: { entity: 'hospital', price: '0' } } })),
      'INVALID_INTENT',
      'service price 0',
    );
  });

  test('the error names the field and says why', () => {
    assert.throws(() => validateConfig(withDefaults({ welcomeGrant: '0' })), /welcomeGrant must be greater than zero/);
  });

  test('parseAmount itself still parses zero: only the config validators refuse it', () => {
    assert.equal(parseAmount('0', 'x'), 0n);
  });
});

describe('config — lookups only see own keys', () => {
  test('own() does not find Object.prototype members', () => {
    const record: Record<string, string> = { bike: '1' };
    assert.equal(own(record, 'bike'), '1');
    for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
      assert.equal(own(record, name), undefined, name);
    }
  });

  test('a service, price or vehicle named like a prototype member is simply unknown', () => {
    const config = defaultConfig();
    for (const name of ['constructor', 'toString', '__proto__']) {
      throwsWithCode(() => serviceOf(config, name), 'UNKNOWN_ENTITY', `service ${name}`);
      throwsWithCode(() => priceOf(config, name), 'INVALID_INTENT', `price ${name}`);
      throwsWithCode(() => rentalRateOf(config, name), 'INVALID_INTENT', `rate ${name}`);
    }
  });

  test('a "__proto__" key in a map is rejected at load instead of silently dropped', () => {
    const viaJson = (text: string): unknown => JSON.parse(text);
    throwsWithCode(
      () => validateConfig(viaJson('{"prices": {"__proto__": "5"}}')),
      'INVALID_INTENT',
      'prices',
    );
    throwsWithCode(
      () => validateConfig(viaJson('{"rentalPerMinute": {"__proto__": "5"}}')),
      'INVALID_INTENT',
      'rentalPerMinute',
    );
    throwsWithCode(
      () => validateConfig(viaJson('{"services": {"__proto__": {"entity": "hospital", "price": "5"}}}')),
      'INVALID_INTENT',
      'services',
    );
  });
});

describe('parseAmountText — the intent-facing parser', () => {
  test('failures are INVALID_AMOUNT with no "config:" prefix', () => {
    for (const bad of ['-1', '1.5', 'abc', '', '1e3', 5, null, undefined, {}]) {
      assert.throws(
        () => parseAmountText(bad, 'amount'),
        (error: unknown) => {
          assert.ok(error instanceof EngineError);
          assert.equal(error.code, 'INVALID_AMOUNT', String(bad));
          assert.doesNotMatch(error.message, /config/i, String(bad));
          assert.match(error.message, /^amount /);
          return true;
        },
      );
    }
  });

  test('accepts the same values parseAmount does, and refuses absurdly long numbers', () => {
    assert.equal(parseAmountText('500', 'x'), 500n);
    assert.equal(parseAmountText(' 500.00 ', 'x'), 500n);
    assert.equal(parseAmountText('9'.repeat(30), 'x'), BigInt('9'.repeat(30)));
    throwsWithCode(() => parseAmountText('9'.repeat(31), 'x'), 'INVALID_AMOUNT', '31 digits');
    assert.equal(parseAmountText('0'.repeat(500) + '7', 'x'), 7n, 'leading zeros do not count as digits');
  });

  test('config parseAmount keeps its "config:" prefix and INVALID_INTENT code', () => {
    throwsWithCode(() => parseAmount('-1', 'welcomeGrant'), 'INVALID_INTENT', 'negative');
    assert.throws(() => parseAmount('-1', 'welcomeGrant'), (e: unknown) => (e as Error).message.startsWith('config: welcomeGrant'));
  });
});
