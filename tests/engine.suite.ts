// Engine tests, written once and run against EVERY backend (see engine.test.ts). The conformance
// suite proves the backends agree at the ledger level; running the intent router over each of them
// proves the engine's behaviour (races, replay, refunds, error mapping) does not secretly depend
// on MemoryBackend's in-process shortcuts. This file is deliberately not named *.test.ts so the
// runner does not pick it up on its own.

import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { defaultConfig, TREASURY_ID } from '../src/config/config.ts';
import { Custody } from '../src/engine/custody.ts';
import { EconomyEngine } from '../src/engine/engine.ts';
import { LedgerCorrupt } from '../src/errors.ts';
import type { LedgerBackend } from '../src/ledger/backend.ts';
import type { EngineResponse, Intent, IntentFailure, IntentResult } from '../src/types.ts';

export interface BackendFactory {
  readonly label: string;
  create(): LedgerBackend;
}

export function engineSuite(factory: BackendFactory): void {

  const RENTAL_ENTITY = 'bike-rental-co';
  const WELCOME_GRANT = 500n;
  const ADMIN = 'admin-42';

  function testConfig() {
    return { ...defaultConfig(), admins: [ADMIN] };
  }

  let backend: LedgerBackend;
  let custody: Custody;
  let engine: EconomyEngine;
  let nonceCounter = 0;
  /** Causes the engine hid from the adapter, per test. */
  let internalErrors: unknown[] = [];

  function nonce(tag: string): string {
    nonceCounter += 1;
    return `${tag}-${nonceCounter}`;
  }

  function expectOk(response: EngineResponse): IntentResult {
    assert.equal(
      response.ok,
      true,
      `expected success, got ${response.ok ? '' : `${response.code}: ${response.message}`}`,
    );
    assert.ok(response.ok);
    return response;
  }

  function expectFail(response: EngineResponse, code: string): IntentFailure {
    assert.equal(response.ok, false, `expected failure with code ${code}, got success`);
    assert.ok(!response.ok);
    assert.equal(response.code, code, `wrong failure code (message: ${response.message})`);
    assert.ok(response.message.length > 0, 'a failure must carry a human-readable message');
    return response;
  }

  async function balanceOf(owner: string): Promise<bigint> {
    const wallet = await backend.getWalletByOwner(owner);
    assert.ok(wallet !== null, `no wallet for ${owner}`);
    return await backend.getBalance(wallet.id);
  }

  /** Puts money into an entity's wallet directly, so payouts/refunds have a source. */
  async function fundEntity(owner: string, amount: bigint): Promise<void> {
    const wallet = await backend.getWalletByOwner(owner);
    assert.ok(wallet !== null, `no wallet for entity ${owner}`);
    await backend.mint(wallet.id, amount, { intent: 'TestFunding', nonce: nonce('fund') });
  }

  async function openAccount(actor: string): Promise<IntentResult> {
    return expectOk(await engine.submit({ type: 'OpenAccount', nonce: nonce('open'), actor }));
  }

  /** Rent and return the rental id — the RentVehicle tx id, which is what ReturnVehicle names. */
  async function rent(actor: string, vehicle: string, minutes: number): Promise<string> {
    return expectOk(
      await engine.submit({ type: 'RentVehicle', nonce: nonce('rent'), actor, vehicle, minutes }),
    ).txId;
  }

  function giveBack(actor: string, rentalId: string, minutesUnused: number): Promise<EngineResponse> {
    return engine.submit({
      type: 'ReturnVehicle',
      nonce: nonce('return'),
      actor,
      rentalId,
      minutesUnused,
    });
  }

  beforeEach(async () => {
    internalErrors = [];
    backend = factory.create();
    custody = new Custody('memory');
    engine = new EconomyEngine({
      backend,
      custody,
      config: testConfig(),
      onInternalError: (cause) => internalErrors.push(cause),
    });
    await engine.init();
  });

  describe(`EconomyEngine — init [${factory.label}]`, () => {
    test('creates an entity wallet for every configured entity', async () => {
      for (const entity of defaultConfig().entities) {
        const wallet = await backend.getWalletByOwner(entity.id);
        assert.ok(wallet !== null, `missing wallet for ${entity.id}`);
        assert.equal(wallet.isEntity, true);
        assert.equal(await backend.getBalance(wallet.id), 0n);
      }
    });

    test('is idempotent — a second init creates no duplicate wallets', async () => {
      const before = (await backend.listWallets()).length;
      await engine.init();
      assert.equal((await backend.listWallets()).length, before);
    });
  });

  describe(`EconomyEngine — happy paths for all 8 intents [${factory.label}]`, () => {
    test('OpenAccount mints the welcome grant to a new player', async () => {
      const result = await openAccount('player-1');
      assert.equal(result.newBalance, WELCOME_GRANT);
      assert.match(result.hash, /^[0-9a-f]{64}$/);
      assert.ok(result.message.includes('500'));

      const tx = await backend.getTx(result.txId);
      assert.equal(tx?.kind, 'mint');
      assert.equal(tx?.from, null);
      assert.equal(tx?.memo.intent, 'OpenAccount');
      assert.equal(await balanceOf('player-1'), WELCOME_GRANT);
    });

    test('RentVehicle charges rate * minutes to the rental entity', async () => {
      await openAccount('player-1');

      const result = expectOk(
        await engine.submit({
          type: 'RentVehicle',
          nonce: nonce('rent'),
          actor: 'player-1',
          vehicle: 'bike',
          minutes: 30,
        }),
      );

      // bike is 1 HD/min in defaultConfig().
      assert.equal(result.newBalance, WELCOME_GRANT - 30n);
      assert.equal(await balanceOf(RENTAL_ENTITY), 30n);

      const tx = await backend.getTx(result.txId);
      assert.equal(tx?.kind, 'transfer');
      assert.equal(tx?.amount, 30n);
      assert.equal(tx?.memo.detail, 'bike — 30min');
    });

    test('RentVehicle prices a helicopter at its own rate', async () => {
      await openAccount('player-1');
      const result = expectOk(
        await engine.submit({
          type: 'RentVehicle',
          nonce: nonce('rent'),
          actor: 'player-1',
          vehicle: 'helicopter',
          minutes: 4,
        }),
      );
      assert.equal(result.newBalance, WELCOME_GRANT - 100n); // 25 * 4
    });

    test('ReturnVehicle refunds the unused minutes from the rental entity', async () => {
      await openAccount('player-1');
      const rentalId = await rent('player-1', 'bike', 30);

      const result = expectOk(await giveBack('player-1', rentalId, 10));

      assert.equal(result.newBalance, WELCOME_GRANT - 30n + 10n);
      assert.equal(await balanceOf(RENTAL_ENTITY), 20n);

      const tx = await backend.getTx(result.txId);
      assert.equal(tx?.amount, 10n);
      assert.equal(tx?.memo.intent, 'ReturnVehicle');
    });

    test('ReturnVehicle rejects more unused minutes than were rented, and moves nothing', async () => {
      await openAccount('player-1');
      await fundEntity(RENTAL_ENTITY, 10_000n);
      const rentalId = await rent('player-1', 'bike', 10);

      expectFail(await giveBack('player-1', rentalId, 999), 'INVALID_INTENT');
      assert.equal(await balanceOf('player-1'), WELCOME_GRANT - 10n);

      // The rental is still open: a truthful return works afterwards.
      expectOk(await giveBack('player-1', rentalId, 10));
      assert.equal(await balanceOf('player-1'), WELCOME_GRANT);
    });

    test('BuyService pays the configured entity price * units', async () => {
      await openAccount('player-1');

      const heal = expectOk(
        await engine.submit({
          type: 'BuyService',
          nonce: nonce('svc'),
          actor: 'player-1',
          service: 'hospital_full_heal',
        }),
      );
      assert.equal(heal.newBalance, WELCOME_GRANT - 200n);
      assert.equal(await balanceOf('hospital'), 200n);

      const fuel = expectOk(
        await engine.submit({
          type: 'BuyService',
          nonce: nonce('svc'),
          actor: 'player-1',
          service: 'gas_per_liter',
          units: 15,
        }),
      );
      assert.equal(fuel.newBalance, WELCOME_GRANT - 200n - 30n); // 2 * 15
      assert.equal(await balanceOf('gas-station-1'), 30n);
    });

    test('Payout moves money from the employer entity to the player', async () => {
      await openAccount('player-1');
      await fundEntity('pd-payroll', 1000n);

      const result = expectOk(
        await engine.submit({
          type: 'Payout',
          nonce: nonce('pay'),
          actor: 'player-1',
          employer: 'pd-payroll',
          amount: '250',
        }),
      );

      assert.equal(result.newBalance, WELCOME_GRANT + 250n);
      assert.equal(await balanceOf('pd-payroll'), 750n);
    });

    test('Fine moves money from the player to the treasury', async () => {
      await openAccount('player-1');

      const result = expectOk(
        await engine.submit({
          type: 'Fine',
          nonce: nonce('fine'),
          actor: 'player-1',
          amount: '75',
          reason: 'speeding',
        }),
      );

      assert.equal(result.newBalance, WELCOME_GRANT - 75n);
      assert.equal(await balanceOf(TREASURY_ID), 75n);
      assert.ok(result.message.includes('speeding'));
    });

    test('Transfer moves money player to player', async () => {
      await openAccount('player-1');
      await openAccount('player-2');

      const result = expectOk(
        await engine.submit({
          type: 'Transfer',
          nonce: nonce('xfer'),
          actor: 'player-1',
          to: 'player-2',
          amount: '120',
        }),
      );

      assert.equal(result.newBalance, WELCOME_GRANT - 120n);
      assert.equal(await balanceOf('player-2'), WELCOME_GRANT + 120n);
    });

    test('Theft moves money from the victim to the actor when authorized', async () => {
      await openAccount('robber');
      await openAccount('victim');

      const result = expectOk(
        await engine.submit({
          type: 'Theft',
          nonce: nonce('theft'),
          actor: 'robber',
          victim: 'victim',
          amount: '90',
          authorizedBy: ADMIN,
        }),
      );

      assert.equal(result.newBalance, WELCOME_GRANT + 90n);
      assert.equal(await balanceOf('victim'), WELCOME_GRANT - 90n);

      const tx = await backend.getTx(result.txId);
      assert.ok(tx?.memo.detail?.includes(ADMIN));
    });

    test('the whole run leaves the ledger verifiably intact', async () => {
      await openAccount('player-1');
      await openAccount('player-2');
      await fundEntity('pd-payroll', 1000n);
      await engine.submit({
        type: 'RentVehicle',
        nonce: nonce('rent'),
        actor: 'player-1',
        vehicle: 'car',
        minutes: 5,
      });
      await engine.submit({
        type: 'Transfer',
        nonce: nonce('xfer'),
        actor: 'player-1',
        to: 'player-2',
        amount: '10',
      });

      const report = await backend.verifyIntegrity();
      assert.equal(report.ok, true);
      assert.deepEqual(report.brokenAt, []);
      assert.deepEqual(report.balanceMismatches, []);
    });
  });

  describe(`EconomyEngine — concurrency [${factory.label}]`, () => {
    test('concurrent ReturnVehicle intents cannot double-refund one rental', async () => {
      await openAccount('player-1');
      await fundEntity(RENTAL_ENTITY, 10_000n);
      const rentalId = await rent('player-1', 'bike', 10);

      const returns = await Promise.all([1, 2, 3].map(() => giveBack('player-1', rentalId, 10)));

      assert.equal(returns.filter((r) => r.ok).length, 1, 'exactly one refund may settle');
      for (const r of returns.filter((r) => !r.ok)) assert.equal(r.code, 'RENTAL_CLOSED');
      assert.equal(await balanceOf('player-1'), WELCOME_GRANT, 'rented 10, refunded 10, once');
    });
  });

  describe(`EconomyEngine — rentals are explicit records [${factory.label}]`, () => {
    test('a rental is returned once', async () => {
      await openAccount('player-1');
      const rentalId = await rent('player-1', 'bike', 30);
      expectOk(await giveBack('player-1', rentalId, 10));
      expectFail(await giveBack('player-1', rentalId, 10), 'RENTAL_CLOSED');
      assert.equal(await balanceOf('player-1'), WELCOME_GRANT - 20n);
    });

    test('a flat-fee vehicle is refunded pro rata, not the whole fee', async () => {
      await openAccount('player-1');
      const rentalId = await rent('player-1', 'scooter', 60); // no per-minute rate: flat 10 HD
      assert.equal(await balanceOf('player-1'), WELCOME_GRANT - 10n);

      const refund = expectOk(await giveBack('player-1', rentalId, 30));
      assert.equal(refund.newBalance, WELCOME_GRANT - 5n, '30 of 60 minutes unused -> half of 10');
    });

    test('a refund too small to be a whole HD is rejected and leaves the rental open', async () => {
      await openAccount('player-1');
      const rentalId = await rent('player-1', 'scooter', 60);
      expectFail(await giveBack('player-1', rentalId, 1), 'INVALID_AMOUNT'); // 10 * 1 / 60 = 0
      expectOk(await giveBack('player-1', rentalId, 6));
    });

    test('the refund is at the price actually paid, not today\'s config', async () => {
      await openAccount('player-1');
      const rentalId = await rent('player-1', 'bike', 30); // paid 30 at 1 HD/min

      const repriced = { ...testConfig(), rentalPerMinute: { ...testConfig().rentalPerMinute, bike: '5' } };
      const later = new EconomyEngine({ backend, custody, config: repriced });
      await later.init();
      const result = await later.submit({
        type: 'ReturnVehicle',
        nonce: nonce('return'),
        actor: 'player-1',
        rentalId,
        minutesUnused: 10,
      });
      assert.equal(expectOk(result).newBalance, WELCOME_GRANT - 20n, 'refund is 10, not 5 * 10');
    });

    test('only the renter can return it, and only a real RentVehicle tx counts', async () => {
      await openAccount('player-1');
      await openAccount('player-2');
      const rentalId = await rent('player-1', 'bike', 30);
      const grant = expectOk(await engine.submit({ type: 'OpenAccount', nonce: nonce('o'), actor: 'player-3' }));

      expectFail(await giveBack('player-2', rentalId, 10), 'UNKNOWN_RENTAL'); // someone else's
      expectFail(await giveBack('player-1', grant.txId, 10), 'UNKNOWN_RENTAL'); // not a rental
      expectFail(await giveBack('player-1', 'no-such-tx', 10), 'UNKNOWN_RENTAL');
      assert.equal(await balanceOf('player-2'), WELCOME_GRANT);
      assert.equal(await balanceOf('player-1'), WELCOME_GRANT - 30n);
    });

    test('memo text is never read: a payment that only looks like a rental is not one', async () => {
      await openAccount('player-1');
      await fundEntity(RENTAL_ENTITY, 1000n);
      const player = await backend.getWalletByOwner('player-1');
      const entity = await backend.getWalletByOwner(RENTAL_ENTITY);
      assert.ok(player !== null && entity !== null);
      const fake = await backend.transfer(player.id, entity.id, 100n, {
        intent: 'RentVehicle',
        detail: 'bike — 100min',
        nonce: nonce('fake'),
      });
      expectFail(await giveBack('player-1', fake.txId, 100), 'UNKNOWN_RENTAL');
    });

    test('a refund the rental entity cannot cover fails and leaves the rental open', async () => {
      await openAccount('player-1');
      const rentalId = await rent('player-1', 'bike', 30);
      // Drain the entity through the (test-only) backend so it cannot pay back.
      const entity = await backend.getWalletByOwner(RENTAL_ENTITY);
      assert.ok(entity !== null);
      await backend.burn(entity.id, 30n, { intent: 'TestDrain', nonce: nonce('drain') });

      expectFail(await giveBack('player-1', rentalId, 10), 'INSUFFICIENT_FUNDS');
      await fundEntity(RENTAL_ENTITY, 30n);
      expectOk(await giveBack('player-1', rentalId, 10));
    });
  });

  /** Sum of every wallet balance: the money supply. Only mints and burns may change it. */
  async function totalSupply(): Promise<bigint> {
    let total = 0n;
    for (const wallet of await backend.listWallets()) total += await backend.getBalance(wallet.id);
    return total;
  }

  describe(`EconomyEngine — OpenAccount grants once per owner [${factory.label}]`, () => {
    test('repeating OpenAccount with fresh nonces does not mint again', async () => {
      const first = await openAccount('player-1');
      assert.equal(first.newBalance, WELCOME_GRANT);

      for (let i = 0; i < 3; i++) {
        const again = await engine.submit({ type: 'OpenAccount', nonce: nonce('open'), actor: 'player-1' });
        const failure = expectFail(again, 'ACCOUNT_EXISTS');
        assert.ok(failure.message.includes('player-1'));
      }

      assert.equal(await balanceOf('player-1'), WELCOME_GRANT);
      assert.equal(await totalSupply(), WELCOME_GRANT, 'no extra HD may have been minted');
      const wallet = await backend.getWalletByOwner('player-1');
      assert.ok(wallet !== null);
      assert.equal((await backend.history(wallet.id)).txs.length, 1, 'exactly one grant on the ledger');
    });

    test('concurrent OpenAccount calls for one new owner grant exactly once', async () => {
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          engine.submit({ type: 'OpenAccount', nonce: nonce('open'), actor: 'racer' }),
        ),
      );

      assert.equal(results.filter((r) => r.ok).length, 1, 'exactly one call may win');
      for (const r of results.filter((r) => !r.ok)) assert.equal(r.code, 'ACCOUNT_EXISTS');
      assert.equal(await balanceOf('racer'), WELCOME_GRANT);
      assert.equal(await totalSupply(), WELCOME_GRANT);
      assert.equal((await backend.listWallets()).filter((w) => w.ownerId === 'racer').length, 1);
    });

    test('an interrupted open (wallet written, no grant) is completed, once', async () => {
      const key = custody.createKeypair('half-open');
      await backend.createWallet('half-open', { pubkey: key.pubkey, address: key.address });

      const done = expectOk(
        await engine.submit({ type: 'OpenAccount', nonce: nonce('open'), actor: 'half-open' }),
      );
      assert.equal(done.newBalance, WELCOME_GRANT);
      expectFail(
        await engine.submit({ type: 'OpenAccount', nonce: nonce('open'), actor: 'half-open' }),
        'ACCOUNT_EXISTS',
      );
      assert.equal(await balanceOf('half-open'), WELCOME_GRANT);
    });
  });

  describe(`EconomyEngine — entity ids are not players [${factory.label}]`, () => {
    const ENTITY_IDS = defaultConfig().entities.map((e) => e.id);

    /** Every player-intent shape, parameterised by the id put in the position under test. */
    function intentsWithActor(id: string): Intent[] {
      return [
        { type: 'OpenAccount', nonce: nonce('e'), actor: id },
        { type: 'RentVehicle', nonce: nonce('e'), actor: id, vehicle: 'bike', minutes: 5 },
        { type: 'ReturnVehicle', nonce: nonce('e'), actor: id, rentalId: 'x', minutesUnused: 5 },
        { type: 'BuyService', nonce: nonce('e'), actor: id, service: 'hospital_full_heal' },
        { type: 'Payout', nonce: nonce('e'), actor: id, employer: 'pd-payroll', amount: '50' },
        { type: 'Fine', nonce: nonce('e'), actor: id, amount: '50' },
        { type: 'Transfer', nonce: nonce('e'), actor: id, to: 'player-1', amount: '50' },
        { type: 'Theft', nonce: nonce('e'), actor: id, victim: 'player-1', amount: '50', authorizedBy: ADMIN },
      ];
    }

    test('no entity id may be the actor of any player intent, and no HD moves', async () => {
      await openAccount('player-1');
      for (const id of ENTITY_IDS) await engine.fundEntity(id, '1000', nonce('fund'));
      const supply = await totalSupply();
      const before = new Map<string, bigint>();
      for (const w of await backend.listWallets()) before.set(w.id, await backend.getBalance(w.id));

      for (const id of ENTITY_IDS) {
        for (const intent of intentsWithActor(id)) {
          expectFail(await engine.submit(intent), 'NOT_AUTHORIZED');
        }
      }

      assert.equal(await totalSupply(), supply);
      for (const w of await backend.listWallets()) {
        assert.equal(await backend.getBalance(w.id), before.get(w.id), `${w.ownerId} balance moved`);
      }
    });

    test('no entity id may be the recipient of a Transfer or the victim of a Theft', async () => {
      await openAccount('player-1');
      for (const id of ENTITY_IDS) {
        await engine.fundEntity(id, '1000', nonce('fund'));
        expectFail(
          await engine.submit({ type: 'Transfer', nonce: nonce('e'), actor: 'player-1', to: id, amount: '10' }),
          'NOT_AUTHORIZED',
        );
        expectFail(
          await engine.submit({
            type: 'Theft',
            nonce: nonce('e'),
            actor: 'player-1',
            victim: id,
            amount: '10',
            authorizedBy: ADMIN,
          }),
          'NOT_AUTHORIZED',
        );
        assert.equal(await balanceOf(id), 1000n, `${id} must not have been drained or credited`);
      }
      assert.equal(await balanceOf('player-1'), WELCOME_GRANT);
    });

    test('a different casing of an entity id is reserved too', async () => {
      for (const id of ['Treasury', 'TREASURY', 'Bike-Rental-Co']) {
        expectFail(await engine.submit({ type: 'OpenAccount', nonce: nonce('e'), actor: id }), 'NOT_AUTHORIZED');
      }
      assert.equal((await backend.listWallets()).filter((w) => !w.isEntity).length, 0);
    });

    test('padded and control-character ids are rejected as malformed', async () => {
      for (const id of [' treasury', 'treasury ', 'a\nb', 'x'.repeat(129)]) {
        expectFail(await engine.submit({ type: 'OpenAccount', nonce: nonce('e'), actor: id }), 'INVALID_INTENT');
      }
    });

    test('init refuses to start over a player wallet that sits on an entity id', async () => {
      const otherBackend = factory.create();
      await otherBackend.init();
      const key = custody.createKeypair('casino-house');
      await otherBackend.createWallet('casino-house', { pubkey: key.pubkey, address: key.address });
      const config = { ...testConfig(), entities: [...testConfig().entities, { id: 'casino-house' }] };
      const clashing = new EconomyEngine({ backend: otherBackend, custody, config });
      await assert.rejects(clashing.init(), (e: unknown) => {
        assert.equal((e as { code?: string }).code, 'ENTITY_ID_CONFLICT');
        return true;
      });
    });
  });

  describe(`EconomyEngine — free text that reaches a memo [${factory.label}]`, () => {
    test('a fine reason is flattened to one line and capped, never rejected', async () => {
      await openAccount('player-1');
      const nasty = `speeding\n\u0000  through\r\nthe  city ${'x'.repeat(400)}`;
      const result = expectOk(
        await engine.submit({ type: 'Fine', nonce: nonce('fine'), actor: 'player-1', amount: '10', reason: nasty }),
      );
      const detail = (await backend.getTx(result.txId))?.memo.detail ?? '';
      assert.match(detail, /^fine — speeding through the city x+…$/);
      assert.doesNotMatch(detail, /[\u0000-\u001f]/);
      assert.ok(detail.length <= 'fine — '.length + 120);
    });

    test('a reason truncated right at a surrogate pair stays well-formed', async () => {
      await openAccount('player-1');
      // 118 plain chars + one astral emoji (two UTF-16 units) + more text: the old
      // code-unit slice(0, 119) cut the emoji in half and left a lone surrogate, which
      // validateMemo rejects outright — the whole Fine then failed for an unrelated reason.
      const reason = `${'x'.repeat(118)}\u{1F600}${'y'.repeat(10)}`;
      const result = expectOk(
        await engine.submit({ type: 'Fine', nonce: nonce('fine'), actor: 'player-1', amount: '10', reason }),
      );
      const detail = (await backend.getTx(result.txId))?.memo.detail ?? '';
      assert.ok(detail.isWellFormed(), `detail must be well-formed Unicode, got ${JSON.stringify(detail)}`);
      assert.ok(detail.endsWith('\u2026'), 'a truncated reason still ends in the ellipsis marker');
    });

    test('an all-whitespace reason is treated as no reason', async () => {
      await openAccount('player-1');
      const result = expectOk(
        await engine.submit({ type: 'Fine', nonce: nonce('fine'), actor: 'player-1', amount: '10', reason: ' \n ' }),
      );
      assert.equal((await backend.getTx(result.txId))?.memo.detail, 'fine');
    });

    test('vehicle and service names must be short, single-line and unpadded', async () => {
      await openAccount('player-1');
      for (const vehicle of ['x'.repeat(65), 'bi\nke', ' bike', 'bike ', '']) {
        expectFail(
          await engine.submit({ type: 'RentVehicle', nonce: nonce('rent'), actor: 'player-1', vehicle, minutes: 5 }),
          'INVALID_INTENT',
        );
      }
      for (const service of ['x'.repeat(65), 'a\tb']) {
        expectFail(
          await engine.submit({ type: 'BuyService', nonce: nonce('svc'), actor: 'player-1', service }),
          'INVALID_INTENT',
        );
      }
      assert.equal(await balanceOf('player-1'), WELCOME_GRANT);
    });
  });

  describe(`EconomyEngine — amounts and lookups [${factory.label}]`, () => {
    test('a bad intent amount is INVALID_AMOUNT and never mentions config', async () => {
      await openAccount('player-1');
      await openAccount('player-2');
      for (const amount of ['10.5', '-10', 'abc', '', '1e3', '9'.repeat(40)]) {
        const failure = expectFail(
          await engine.submit({ type: 'Transfer', nonce: nonce('x'), actor: 'player-1', to: 'player-2', amount }),
          'INVALID_AMOUNT',
        );
        assert.doesNotMatch(failure.message, /config/i, amount);
        assert.match(failure.message, /^amount /);
      }
      // a non-string amount too (the adapter sent a JSON number)
      const numeric = expectFail(
        await engine.submit({
          type: 'Transfer',
          nonce: nonce('x'),
          actor: 'player-1',
          to: 'player-2',
          amount: 10 as unknown as string,
        }),
        'INVALID_AMOUNT',
      );
      assert.doesNotMatch(numeric.message, /config/i);
      assert.equal(await balanceOf('player-1'), WELCOME_GRANT);
    });

    test('a zero intent amount is rejected as INVALID_AMOUNT', async () => {
      await openAccount('player-1');
      await openAccount('player-2');
      expectFail(
        await engine.submit({ type: 'Transfer', nonce: nonce('x'), actor: 'player-1', to: 'player-2', amount: '0' }),
        'INVALID_AMOUNT',
      );
    });

    test('vehicle and service names that are Object.prototype members are just unknown names', async () => {
      await openAccount('player-1');
      for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
        // not a configured per-minute vehicle -> the flat fee, exactly like any unlisted vehicle
        const rented = expectOk(
          await engine.submit({ type: 'RentVehicle', nonce: nonce('rent'), actor: 'player-1', vehicle: name, minutes: 5 }),
        );
        const tx = await backend.getTx(rented.txId);
        assert.equal(tx?.amount, 10n, `${name} is charged the flat fee, not a config lookup error`);

        expectFail(
          await engine.submit({ type: 'BuyService', nonce: nonce('svc'), actor: 'player-1', service: name }),
          'UNKNOWN_ENTITY',
        );
      }
    });
  });

  describe(`EconomyEngine — ids and nonces the ledger cannot store faithfully [${factory.label}]`, () => {
    const wallets = async (): Promise<number> => (await backend.listWallets()).filter((w) => !w.isEntity).length;

    test('lone surrogates are rejected in ids and nonces, and the ledger still verifies', async () => {
      for (const actor of ['x\ud800', '\udc00y']) {
        expectFail(await engine.submit({ type: 'OpenAccount', nonce: nonce('s'), actor }), 'INVALID_INTENT');
      }
      expectFail(await engine.submit({ type: 'OpenAccount', nonce: 'ok\ud800', actor: 'p1' }), 'INVALID_INTENT');
      assert.equal(await wallets(), 0);
      await openAccount('p1');
      assert.equal((await backend.verifyIntegrity()).ok, true);
    });

    test('one player cannot collect several grants through look-alike ids', async () => {
      await openAccount('café'); // NFC
      for (const actor of ['cafe\u0301', 'alice\u200b', 'a\u0085b', 'a\u2028b']) {
        expectFail(await engine.submit({ type: 'OpenAccount', nonce: nonce('n'), actor }), 'INVALID_INTENT');
      }
      assert.equal(await wallets(), 1);
    });

    test('a rejected OpenAccount leaves no orphan wallet behind', async () => {
      for (const n of ['n'.repeat(129), 'bad\nnonce', ' ']) {
        expectFail(await engine.submit({ type: 'OpenAccount', nonce: n, actor: 'p1' }), 'INVALID_INTENT');
      }
      assert.equal(await wallets(), 0, 'no wallet may exist for a grant the ledger refused');
    });
  });

  describe(`EconomyEngine — serialization is load-bearing [${factory.label}]`, () => {
    test('concurrent retries of one nonce: one settles, the rest are replays of it', async () => {
      await openAccount('player-1');
      await openAccount('player-2');
      const intent: Intent = { type: 'Transfer', nonce: 'same', actor: 'player-1', to: 'player-2', amount: '10' };
      const results = await Promise.all(Array.from({ length: 5 }, () => engine.submit(intent)));
      assert.ok(results.every((r) => r.ok), 'every retry is an ok (first or replayed), none a DUPLICATE_NONCE');
      assert.equal(results.filter((r) => r.ok && r.replayed !== true).length, 1);
      assert.equal(new Set(results.map((r) => (r.ok ? r.txId : ''))).size, 1);
      assert.equal(await balanceOf('player-1'), WELCOME_GRANT - 10n);
    });

    test('concurrent transfers that together overdraw: exactly the affordable ones settle', async () => {
      await openAccount('player-1');
      await openAccount('player-2');
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          engine.submit({ type: 'Transfer', nonce: nonce('t'), actor: 'player-1', to: 'player-2', amount: '100' }),
        ),
      );
      assert.equal(results.filter((r) => r.ok).length, 5);
      for (const r of results.filter((r) => !r.ok)) assert.equal(r.code, 'INSUFFICIENT_FUNDS');
      assert.equal(await balanceOf('player-1'), 0n);
    });
  });

  describe(`EconomyEngine — only a real rental counts [${factory.label}]`, () => {
    test('a RentVehicle-shaped payment to the wrong entity, or with the wrong intent, is not a rental', async () => {
      await openAccount('player-1');
      const player = await backend.getWalletByOwner('player-1');
      const hospital = await backend.getWalletByOwner('hospital');
      const rentalCo = await backend.getWalletByOwner(RENTAL_ENTITY);
      assert.ok(player !== null && hospital !== null && rentalCo !== null);
      await fundEntity(RENTAL_ENTITY, 1000n);
      const meta = { vehicle: 'bike', minutes: '10' };
      const wrongPayee = await backend.transfer(player.id, hospital.id, 10n, { intent: 'RentVehicle', nonce: nonce('a'), meta });
      const wrongIntent = await backend.transfer(player.id, rentalCo.id, 10n, { intent: 'BuyService', nonce: nonce('b'), meta });
      expectFail(await giveBack('player-1', wrongPayee.txId, 5), 'UNKNOWN_RENTAL');
      expectFail(await giveBack('player-1', wrongIntent.txId, 5), 'UNKNOWN_RENTAL');
    });
  });

  describe(`EconomyEngine — Theft authorization [${factory.label}]`, () => {
    async function steal(authorizedBy: string, actor = 'robber'): Promise<EngineResponse> {
      return await engine.submit({
        type: 'Theft',
        nonce: nonce('theft'),
        actor,
        victim: 'victim',
        amount: '50',
        authorizedBy,
      });
    }

    test('free-text authorization is refused; only the victim or a configured admin counts', async () => {
      await openAccount('robber');
      await openAccount('victim');

      expectFail(await steal('me-trust-me'), 'NOT_AUTHORIZED');
      expectFail(await steal('robber'), 'NOT_AUTHORIZED');
      assert.equal(await balanceOf('victim'), WELCOME_GRANT);

      expectOk(await steal('victim'));
      expectOk(await steal(ADMIN));
      assert.equal(await balanceOf('victim'), WELCOME_GRANT - 100n);
    });
  });

  describe(`EconomyEngine — admin funding [${factory.label}]`, () => {
    test('mints into an entity wallet so a fresh world can pay out', async () => {
      await openAccount('player-1');
      const funded = expectOk(await engine.fundEntity('pd-payroll', '1000', nonce('fund')));
      assert.equal(funded.newBalance, 1000n);

      const tx = await backend.getTx(funded.txId);
      assert.equal(tx?.kind, 'mint');
      assert.equal(tx?.memo.intent, 'AdminFund');

      const paid = expectOk(
        await engine.submit({
          type: 'Payout',
          nonce: nonce('pay'),
          actor: 'player-1',
          employer: 'pd-payroll',
          amount: '250',
        }),
      );
      assert.equal(paid.newBalance, WELCOME_GRANT + 250n);
    });

    test('is not an intent: submit cannot name it', async () => {
      const response = await engine.submit({
        type: 'AdminFund',
        nonce: nonce('x'),
        actor: 'player-1',
        entity: 'treasury',
        amount: '1000',
      } as unknown as Intent);
      expectFail(response, 'INVALID_INTENT');
      assert.equal(await balanceOf(TREASURY_ID), 0n);
    });

    test('only configured entities can be funded; players cannot', async () => {
      await openAccount('player-1');
      expectFail(await engine.fundEntity('player-1', '10', nonce('fund')), 'UNKNOWN_ENTITY');
      expectFail(await engine.fundEntity('nobody', '10', nonce('fund')), 'UNKNOWN_ENTITY');
      assert.equal(await balanceOf('player-1'), WELCOME_GRANT);
    });

    test('is replay-protected (never funds twice) and validates the amount', async () => {
      expectOk(await engine.fundEntity('treasury', '100', 'fund-once'));
      expectOk(await engine.fundEntity('treasury', '100', 'fund-once')); // replay: original result
      expectFail(await engine.fundEntity('hospital', '100', 'fund-once'), 'DUPLICATE_NONCE'); // reuse
      for (const amount of ['0', '-5', '1.5', 'abc', '']) {
        assert.equal((await engine.fundEntity('treasury', amount, nonce('fund'))).ok, false, amount);
      }
      assert.equal(await balanceOf('treasury'), 100n);
    });
  });

  describe(`EconomyEngine — replay protection [${factory.label}]`, () => {
    test('a replayed OpenAccount nonce returns the original result and does not double-grant', async () => {
      const first = expectOk(
        await engine.submit({ type: 'OpenAccount', nonce: 'fixed-nonce', actor: 'player-1' }),
      );
      assert.equal(first.newBalance, WELCOME_GRANT);
      assert.equal(first.replayed, undefined);

      const replay = expectOk(
        await engine.submit({ type: 'OpenAccount', nonce: 'fixed-nonce', actor: 'player-1' }),
      );
      assert.equal(replay.txId, first.txId, 'the adapter gets the original tx back');
      assert.equal(replay.hash, first.hash);
      assert.equal(replay.replayed, true);

      assert.equal(await balanceOf('player-1'), WELCOME_GRANT, 'the grant must not be paid twice');
      assert.equal((await backend.listWallets()).filter((w) => !w.isEntity).length, 1);
    });

    test('a replayed Transfer, Payout and Theft each return their original tx once', async () => {
      await openAccount('player-1');
      await openAccount('player-2');
      await engine.fundEntity('pd-payroll', '1000', nonce('fund'));

      const intents: Intent[] = [
        { type: 'Transfer', nonce: 'r-xfer', actor: 'player-1', to: 'player-2', amount: '10' },
        { type: 'Payout', nonce: 'r-pay', actor: 'player-1', employer: 'pd-payroll', amount: '20' },
        { type: 'Theft', nonce: 'r-theft', actor: 'player-1', victim: 'player-2', amount: '30', authorizedBy: 'player-2' },
      ];
      for (const intent of intents) {
        const first = expectOk(await engine.submit(intent));
        const again = expectOk(await engine.submit(intent));
        assert.equal(again.txId, first.txId, intent.type);
        assert.equal(again.replayed, true);
      }
      assert.equal(await balanceOf('player-1'), WELCOME_GRANT - 10n + 20n + 30n);
      assert.equal(await balanceOf('player-2'), WELCOME_GRANT + 10n - 30n);
    });

    test('a replayed admin funding returns the original tx', async () => {
      const first = expectOk(await engine.fundEntity('treasury', '100', 'fund-once'));
      const again = expectOk(await engine.fundEntity('treasury', '100', 'fund-once'));
      assert.equal(again.txId, first.txId);
      assert.equal(again.replayed, true);
      assert.equal(await balanceOf('treasury'), 100n);
    });

    test('a replayed nonce from a different actor is still rejected', async () => {
      await openAccount('player-1');
      await openAccount('player-2');

      expectOk(
        await engine.submit({
          type: 'Transfer',
          nonce: 'shared-nonce',
          actor: 'player-1',
          to: 'player-2',
          amount: '10',
        }),
      );

      // player-2 is the RECIPIENT of the settled tx; that does not make them its initiator.
      expectFail(
        await engine.submit({
          type: 'Transfer',
          nonce: 'shared-nonce',
          actor: 'player-2',
          to: 'player-1',
          amount: '10',
        }),
        'DUPLICATE_NONCE',
      );

      assert.equal(await balanceOf('player-1'), WELCOME_GRANT - 10n);
      assert.equal(await balanceOf('player-2'), WELCOME_GRANT + 10n);
    });

    test('a nonce reused for a different intent type is rejected, not answered', async () => {
      await openAccount('player-1');
      await openAccount('player-2');
      expectOk(
        await engine.submit({ type: 'Transfer', nonce: 'reused', actor: 'player-1', to: 'player-2', amount: '10' }),
      );
      expectFail(
        await engine.submit({ type: 'Fine', nonce: 'reused', actor: 'player-1', amount: '10' }),
        'DUPLICATE_NONCE',
      );
      assert.equal(await balanceOf('player-1'), WELCOME_GRANT - 10n);
    });
  });

  describe(`EconomyEngine — rejections [${factory.label}]`, () => {
    test('an unknown service reports UNKNOWN_ENTITY', async () => {
      await openAccount('player-1');
      expectFail(
        await engine.submit({
          type: 'BuyService',
          nonce: nonce('svc'),
          actor: 'player-1',
          service: 'not-a-real-service',
        }),
        'UNKNOWN_ENTITY',
      );
      assert.equal(await balanceOf('player-1'), WELCOME_GRANT);
    });

    test('an unknown employer reports UNKNOWN_ENTITY', async () => {
      await openAccount('player-1');
      expectFail(
        await engine.submit({
          type: 'Payout',
          nonce: nonce('pay'),
          actor: 'player-1',
          employer: 'no-such-employer',
          amount: '10',
        }),
        'UNKNOWN_ENTITY',
      );
    });

    test('Theft with an empty authorizedBy reports NOT_AUTHORIZED', async () => {
      await openAccount('robber');
      await openAccount('victim');

      for (const authorizedBy of ['', '   ']) {
        expectFail(
          await engine.submit({
            type: 'Theft',
            nonce: nonce('theft'),
            actor: 'robber',
            victim: 'victim',
            amount: '50',
            authorizedBy,
          }),
          'NOT_AUTHORIZED',
        );
      }

      assert.equal(await balanceOf('victim'), WELCOME_GRANT, 'no money may move without authority');
      assert.equal(await balanceOf('robber'), WELCOME_GRANT);
    });

    test('a Transfer to yourself reports INVALID_INTENT', async () => {
      await openAccount('player-1');
      expectFail(
        await engine.submit({
          type: 'Transfer',
          nonce: nonce('xfer'),
          actor: 'player-1',
          to: 'player-1',
          amount: '10',
        }),
        'INVALID_INTENT',
      );
      assert.equal(await balanceOf('player-1'), WELCOME_GRANT);
    });

    test('stealing from yourself reports INVALID_INTENT', async () => {
      await openAccount('player-1');
      expectFail(
        await engine.submit({
          type: 'Theft',
          nonce: nonce('theft'),
          actor: 'player-1',
          victim: 'player-1',
          amount: '10',
          authorizedBy: 'admin',
        }),
        'INVALID_INTENT',
      );
    });

    test('non-integer, zero and negative minutes report INVALID_INTENT', async () => {
      await openAccount('player-1');

      for (const minutes of [0, -5, 1.5, 0.1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
        expectFail(
          await engine.submit({
            type: 'RentVehicle',
            nonce: nonce('rent'),
            actor: 'player-1',
            vehicle: 'bike',
            minutes,
          }),
          'INVALID_INTENT',
        );
      }

      assert.equal(await balanceOf('player-1'), WELCOME_GRANT, 'no rental may have been charged');
      assert.equal(await balanceOf(RENTAL_ENTITY), 0n);
    });

    test('non-integer units on BuyService report INVALID_INTENT', async () => {
      await openAccount('player-1');
      expectFail(
        await engine.submit({
          type: 'BuyService',
          nonce: nonce('svc'),
          actor: 'player-1',
          service: 'gas_per_liter',
          units: 2.5,
        }),
        'INVALID_INTENT',
      );
      assert.equal(await balanceOf('player-1'), WELCOME_GRANT);
    });

    test('an unknown actor reports UNKNOWN_WALLET', async () => {
      expectFail(
        await engine.submit({
          type: 'Fine',
          nonce: nonce('fine'),
          actor: 'ghost-player',
          amount: '10',
        }),
        'UNKNOWN_WALLET',
      );
    });

    test('spending more than you hold reports INSUFFICIENT_FUNDS and moves nothing', async () => {
      await openAccount('player-1');
      expectFail(
        await engine.submit({
          type: 'Fine',
          nonce: nonce('fine'),
          actor: 'player-1',
          amount: '100000',
        }),
        'INSUFFICIENT_FUNDS',
      );
      assert.equal(await balanceOf('player-1'), WELCOME_GRANT);
      assert.equal(await balanceOf(TREASURY_ID), 0n);
    });

    test('fractional and non-numeric intent amounts are rejected', async () => {
      await openAccount('player-1');
      await openAccount('player-2');

      for (const amount of ['10.5', '-10', 'abc', '', '1e3', '0']) {
        const response = await engine.submit({
          type: 'Transfer',
          nonce: nonce('xfer'),
          actor: 'player-1',
          to: 'player-2',
          amount,
        });
        assert.equal(response.ok, false, `amount ${JSON.stringify(amount)} should be rejected`);
      }

      assert.equal(await balanceOf('player-1'), WELCOME_GRANT);
      assert.equal(await balanceOf('player-2'), WELCOME_GRANT);
    });
  });

  describe(`EconomyEngine — submit never throws [${factory.label}]`, () => {
    test('every malformed intent comes back as a typed failure, not an exception', async () => {
      await openAccount('player-1');

      const garbage: unknown[] = [
        null,
        undefined,
        {},
        'not an intent',
        42,
        [],
        { type: 'OpenAccount' },
        { type: 'OpenAccount', nonce: '', actor: 'player-1' },
        { type: 'OpenAccount', nonce: 'n', actor: '' },
        { type: 'OpenAccount', nonce: 'n', actor: 42 },
        { type: 'NotARealIntent', nonce: nonce('x'), actor: 'player-1' },
        { type: 'RentVehicle', nonce: nonce('x'), actor: 'player-1' },
        { type: 'RentVehicle', nonce: nonce('x'), actor: 'player-1', vehicle: '', minutes: 5 },
        { type: 'BuyService', nonce: nonce('x'), actor: 'player-1', service: null },
        { type: 'Payout', nonce: nonce('x'), actor: 'player-1', employer: '', amount: '5' },
        { type: 'Payout', nonce: nonce('x'), actor: 'player-1', employer: 'pd-payroll', amount: 5 },
        { type: 'Fine', nonce: nonce('x'), actor: 'player-1', amount: null },
        { type: 'Transfer', nonce: nonce('x'), actor: 'player-1', to: null, amount: '5' },
        { type: 'Theft', nonce: nonce('x'), actor: 'player-1', victim: 'ghost', amount: '5' },
        {
          type: 'ReturnVehicle',
          nonce: nonce('x'),
          actor: 'player-1',
          rentalId: 'r',
          minutesUnused: -1,
        },
        {
          type: 'ReturnVehicle',
          nonce: nonce('x'),
          actor: 'player-1',
          rentalId: 'never-rented',
          minutesUnused: 5,
        },
        { type: 'ReturnVehicle', nonce: nonce('x'), actor: 'player-1', minutesUnused: 5 },
      ];

      for (const candidate of garbage) {
        let response: EngineResponse;
        try {
          response = await engine.submit(candidate as Intent);
        } catch (error) {
          assert.fail(
            `submit() threw for ${JSON.stringify(candidate)}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        assert.equal(
          response.ok,
          false,
          `expected a failure for ${JSON.stringify(candidate)}, got success`,
        );
        assert.ok(!response.ok);
        assert.equal(typeof response.code, 'string');
        assert.ok(response.code.length > 0, 'every failure must carry a stable code');
        assert.equal(typeof response.message, 'string');
      }

      // Nothing above was allowed to move money.
      assert.equal(await balanceOf('player-1'), WELCOME_GRANT);
    });

    test('an unexpected backend error becomes INTERNAL and its message never reaches the adapter', async () => {
      const seen: { cause: unknown; ref: string }[] = [];
      const brokenBackend = factory.create();
      const brokenEngine = new EconomyEngine({
        backend: brokenBackend,
        custody: new Custody('memory'),
        config: defaultConfig(),
        onInternalError: (cause, ref) => seen.push({ cause, ref }),
      });
      await brokenEngine.init();

      // A non-EngineError escaping the backend must still be caught by submit().
      brokenBackend.mint = async () => {
        throw new Error('SQLITE_ERROR: no such column secret_col in table wallets');
      };

      const response = await brokenEngine.submit({
        type: 'OpenAccount',
        nonce: 'internal-1',
        actor: 'player-1',
      });
      expectFail(response, 'INTERNAL');
      assert.doesNotMatch(response.message, /SQLITE|secret_col|wallets/);
      assert.equal(seen.length, 1, 'the real cause is handed to the operator hook');
      assert.match(String(seen[0]?.cause), /secret_col/);
      assert.ok(response.message.includes(seen[0]?.ref ?? 'missing'), 'the ref ties the two together');
    });

    test('ledger corruption is reported with its own code but a generic message', async () => {
      const brokenBackend = factory.create();
      const brokenEngine = new EconomyEngine({
        backend: brokenBackend,
        custody: new Custody('memory'),
        config: defaultConfig(),
        onInternalError: () => undefined,
      });
      await brokenEngine.init();
      brokenBackend.mint = async () => {
        throw new LedgerCorrupt('Column "amount" is not TEXT (got number)');
      };
      const response = await brokenEngine.submit({ type: 'OpenAccount', nonce: 'c-1', actor: 'player-1' });
      expectFail(response, 'LEDGER_CORRUPT');
      assert.doesNotMatch(response.message, /Column|TEXT/);
    });

    test('a throwing operator hook cannot turn a typed failure into an exception', async () => {
      const brokenBackend = factory.create();
      const brokenEngine = new EconomyEngine({
        backend: brokenBackend,
        custody: new Custody('memory'),
        config: defaultConfig(),
        onInternalError: () => {
          throw new Error('logger down');
        },
      });
      await brokenEngine.init();
      brokenBackend.mint = async () => {
        throw new Error('boom');
      };
      expectFail(await brokenEngine.submit({ type: 'OpenAccount', nonce: 'h-1', actor: 'p' }), 'INTERNAL');
    });

    test('a failed balance read-back after settlement is still ok:true, with a null balance', async () => {
      await openAccount('player-1');
      await openAccount('player-2');
      let reads = 0;
      backend.getBalance = async () => {
        reads += 1;
        throw new Error('read replica gone');
      };
      const response = expectOk(
        await engine.submit({
          type: 'Transfer',
          nonce: nonce('xfer'),
          actor: 'player-1',
          to: 'player-2',
          amount: '10',
        }),
      );
      assert.equal(response.newBalance, null);
      assert.ok(reads > 0);
      assert.equal(internalErrors.length, 1, 'the failed read is logged, not swallowed');
      // the money did move
      const tx = await backend.getTx(response.txId);
      assert.equal(tx?.amount, 10n);
    });
  });

}
