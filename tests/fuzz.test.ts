// Differential fuzz: the SAME seeded random intent stream is run through an engine over the memory
// backend and an engine over the sqlite backend. Every step must give the same answer on both, and at
// the end the ledger invariants must hold. Deterministic (seeded), so a failure names its seed and
// step and can be replayed.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { defaultConfig } from '../src/config/config.ts';
import { Custody } from '../src/engine/custody.ts';
import { EconomyEngine } from '../src/engine/engine.ts';
import type { LedgerBackend } from '../src/ledger/backend.ts';
import { MemoryBackend } from '../src/ledger/memory.ts';
import { SqliteBackend } from '../src/ledger/sqlite.ts';
import type { EngineResponse, Intent } from '../src/types.ts';

/** Small, fast, seedable PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PLAYERS = ['p1', 'p2', 'p3', 'p4'];
const ENTITIES = defaultConfig().entities.map((e) => e.id);
/** Mostly real ids, with entity ids, unknown ids and junk mixed in. */
const ACTORS = [...PLAYERS, ...PLAYERS, ...PLAYERS, 'ghost', 'treasury', 'Hospital', ' p1', ''];
const AMOUNTS = ['1', '5', '10', '50', '200', '1000', '0', '-3', '2.5', 'abc', '', '1e3', '99999999999'];
const VEHICLES = ['bike', 'car', 'helicopter', 'scooter', 'constructor'];
const SERVICES = ['hospital_full_heal', 'gas_per_liter', 'nope', '__proto__'];

interface Run {
  engine: EconomyEngine;
  backend: LedgerBackend;
  /** rental ids handed out, by index of the RentVehicle step that made them */
  rentals: string[];
  /** bet ids handed out, by index of the PlaceBet step that made them */
  bets: string[];
  minted: bigint;
}

async function makeRun(backend: LedgerBackend): Promise<Run> {
  const engine = new EconomyEngine({
    backend,
    custody: new Custody('memory'),
    config: { ...defaultConfig(), admins: ['admin-1'] },
    onInternalError: (cause) => {
      throw new Error(`unexpected internal error during fuzz: ${String(cause)}`);
    },
  });
  await engine.init();
  return { engine, backend, rentals: [], bets: [], minted: 0n };
}

/** Same step index -> same intent, on both runs. Rental ids are looked up per run by ordinal. */
function stepIntent(random: () => number, step: number, run: Run): Intent | { fund: [string, string, string] } {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const nonce = random() < 0.08 && step > 0 ? `n${Math.floor(random() * step)}` : `n${step}`; // sometimes a reused nonce
  const actor = pick(ACTORS);
  const kind = Math.floor(random() * 14);
  switch (kind) {
    case 0:
      return { type: 'OpenAccount', nonce, actor };
    case 1:
      return { type: 'RentVehicle', nonce, actor, vehicle: pick(VEHICLES), minutes: 1 + Math.floor(random() * 90) };
    case 2: {
      const rentalId = run.rentals.length > 0 && random() < 0.9 ? Math.floor(random() * run.rentals.length) : -1;
      return {
        type: 'ReturnVehicle',
        nonce,
        actor,
        rentalId: rentalId === -1 ? 'no-such-rental' : `#${rentalId}`, // resolved per run below
        minutesUnused: 1 + Math.floor(random() * 95),
      };
    }
    case 3:
      return { type: 'BuyService', nonce, actor, service: pick(SERVICES), units: 1 + Math.floor(random() * 5) };
    case 4:
      return { type: 'Payout', nonce, actor, employer: pick(ENTITIES), amount: pick(AMOUNTS) };
    case 5:
      return { type: 'Fine', nonce, actor, amount: pick(AMOUNTS), reason: random() < 0.5 ? 'speeding\n' : 'x'.repeat(300) };
    case 6:
      return { type: 'Transfer', nonce, actor, to: pick(ACTORS), amount: pick(AMOUNTS) };
    case 7:
      return {
        type: 'Theft',
        nonce,
        actor,
        victim: pick(ACTORS),
        amount: pick(AMOUNTS),
        authorizedBy: pick(['admin-1', 'nobody', pick(PLAYERS)]),
      };
    case 8:
      return { type: 'DepositToSociety', nonce, actor, entity: pick(ENTITIES), amount: pick(AMOUNTS) };
    case 9:
      return {
        type: 'RobEntity',
        nonce,
        actor,
        entity: pick(ENTITIES),
        amount: pick(AMOUNTS),
        authorizedBy: pick(['admin-1', 'nobody', pick(PLAYERS)]),
      };
    case 10:
      return { type: 'PlaceBet', nonce, actor, casino: pick(ENTITIES), amount: pick(AMOUNTS) };
    case 11: {
      const betId = run.bets.length > 0 && random() < 0.9 ? Math.floor(random() * run.bets.length) : -1;
      return {
        type: 'SettleBet',
        nonce,
        actor,
        betId: betId === -1 ? 'no-such-bet' : `#${betId}`, // resolved per run below
        payout: pick(AMOUNTS),
      };
    }
    default:
      return { fund: [pick(ENTITIES), pick(AMOUNTS), nonce] };
  }
}

async function applyStep(run: Run, intent: ReturnType<typeof stepIntent>): Promise<EngineResponse> {
  if ('fund' in intent) {
    const [entity, amount, nonce] = intent.fund;
    const response = await run.engine.fundEntity(entity, amount, nonce);
    if (response.ok && response.replayed !== true) run.minted += BigInt(amount);
    return response;
  }
  let resolved: Intent = intent;
  if (intent.type === 'ReturnVehicle' && intent.rentalId.startsWith('#')) {
    resolved = { ...intent, rentalId: run.rentals[Number(intent.rentalId.slice(1))] ?? 'missing' };
  }
  if (intent.type === 'SettleBet' && intent.betId.startsWith('#')) {
    resolved = { ...intent, betId: run.bets[Number(intent.betId.slice(1))] ?? 'missing' };
  }
  const response = await run.engine.submit(resolved);
  if (response.ok && response.replayed !== true) {
    if (intent.type === 'OpenAccount') run.minted += 500n;
    if (intent.type === 'RentVehicle') run.rentals.push(response.txId);
    if (intent.type === 'PlaceBet') run.bets.push(response.txId);
  }
  return response;
}

/** What must agree between backends: the outcome, not the ids and timestamps. */
function shape(response: EngineResponse): string {
  return response.ok
    ? `ok balance=${String(response.newBalance)} replayed=${String(response.replayed === true)}`
    : `fail ${response.code}`;
}

async function balances(backend: LedgerBackend): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  for (const w of await backend.listWallets()) out.set(w.ownerId, await backend.getBalance(w.id));
  return out;
}

/** How many of each kind of step settled (ok) across every seed: proves the fuzz moves real money. */
const settled = new Map<string, number>();
function tally(intent: ReturnType<typeof stepIntent>, response: EngineResponse): void {
  if (!response.ok || response.replayed === true) return;
  const kind = 'fund' in intent ? 'AdminFund' : intent.type;
  settled.set(kind, (settled.get(kind) ?? 0) + 1);
}

describe('fuzz — memory and sqlite agree, and the ledger stays sound', () => {
  for (const seed of [1, 2, 3, 7, 42, 2026]) {
    test(`seed ${seed}: 400 random intents`, async () => {
      const [a, b] = await Promise.all([makeRun(new MemoryBackend()), makeRun(new SqliteBackend(':memory:'))]);
      // separate PRNGs with the same seed keep the two runs' choices identical
      const randomA = rng(seed);
      const randomB = rng(seed);

      for (let step = 0; step < 400; step++) {
        const intentA = stepIntent(randomA, step, a);
        const intentB = stepIntent(randomB, step, b);
        const [ra, rb] = [await applyStep(a, intentA), await applyStep(b, intentB)];
        tally(intentA, ra);
        assert.equal(shape(ra), shape(rb), `seed ${seed} step ${step}: ${JSON.stringify(intentA)}`);
        assert.ok(ra.ok || ra.code !== 'INTERNAL', `seed ${seed} step ${step}: INTERNAL`);
      }

      const [balA, balB] = [await balances(a.backend), await balances(b.backend)];
      assert.deepEqual([...balA].sort(), [...balB].sort(), `seed ${seed}: final balances differ`);

      for (const run of [a, b]) {
        // conservation: everything in the world was minted by a grant or admin funding
        let supply = 0n;
        for (const balance of (await balances(run.backend)).values()) {
          assert.ok(balance >= 0n, 'no wallet may be negative');
          supply += balance;
        }
        assert.equal(supply, run.minted, `seed ${seed} ${run.backend.name}: supply != minted`);

        const report = await run.backend.verifyIntegrity();
        assert.equal(report.ok, true, `seed ${seed} ${run.backend.name}: ${JSON.stringify(report, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))}`);
      }
      assert.equal((await a.backend.verifyIntegrity()).checked, (await b.backend.verifyIntegrity()).checked);
      await Promise.all([a.backend.close(), b.backend.close()]);
    });
  }

  test('the fuzz actually settles every kind of intent (it is not vacuously green)', () => {
    console.log('  settled per kind:', JSON.stringify(Object.fromEntries(settled)));
    for (const kind of [
      'OpenAccount',
      'RentVehicle',
      'ReturnVehicle',
      'BuyService',
      'Payout',
      'Fine',
      'Transfer',
      'Theft',
      'DepositToSociety',
      'RobEntity',
      'PlaceBet',
      'SettleBet',
      'AdminFund',
    ]) {
      assert.ok((settled.get(kind) ?? 0) >= 5, `only ${settled.get(kind) ?? 0} settled ${kind} steps across all seeds`);
    }
  });
});
