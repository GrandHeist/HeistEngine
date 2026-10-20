# Heist Engine — Spec

> **How to read this document.** It began as a design and still describes the target. Corrected
> 2026-09-24 so it no longer claims things the code does not do. Every section is tagged
> **[built]**, **[partly built]** or **[planned]**. When in doubt, the code and the ADRs in
> [`docs/adr/`](adr/) win over this file.

## What it is

A plugin that replaces a GTA RP server's in-game economy with a transparent, auditable ledger of player and NPC-entity wallets. Players spawn with a wallet, and every economic action (rent a bike, pay hospital, get paid for a job, fines, robberies) is a transfer, mint or burn on that ledger. The ledger backend is swappable behind one interface. Today three backends exist: **memory**, **SQLite** and **Postgres** (all off-chain). A **Solana** backend does not exist yet (see below).

This is a private friends server economy. The in-game currency's name is set by the server owner
in config — **HD** ("Heist Dollar") is just this project's own default placeholder, not a
requirement. Everything lives in a ledger, which is what keeps this inside Rockstar/FiveM's rules
around crypto-related content.

## Status at a glance

| Piece | Status |
|---|---|
| Intent router, config, entity wallets, admin funding | **[built]** |
| Memory + SQLite + Postgres backends, hash chain, integrity verification, checkpoints | **[built]** |
| Standalone CLI simulator | **[built]** |
| Solana backend | **[planned]**, not built |
| Signed ledger rows (payer key signs each tx) | **[planned]**, designed in [ADR 0003](adr/0003-signing-design.md); `signature` is always null today |
| Adapter authentication, HTTP/WS surface | **[planned]**, designed in ADR 0003; the engine is a library today |
| FiveM / RageMP adapters | **[planned]**, not written |
| Persistent custody keys | **[built, library-level]**; HKDF from a master seed, ADR 0003 part 3. Not yet wired into the CLI |
| Admin dashboard | **[planned]** |

## Goals

- One engine that a FiveM Lua resource, a RageMP package and the standalone sim can all drive. *(Only the sim exists.)*
- Ledger backend is a swappable adapter behind one interface. *(Proven for two backends by shared conformance and engine suites.)*
- Every economic action is an auditable, append-only, hash-chained transaction. Nothing changes a balance except a transfer, mint, or burn. **[built]**
- Every transaction is *signed* by a wallet key. **[planned]** — the hash chain detects edits to history, but without signatures someone who can write the database and recompute hashes can append forged rows. See ADR 0006 (what is and is not caught) and ADR 0003.
- Server-custodial wallets — players never sign anything in-game. Zero friction. *(Custody generates and holds keys; persistence across restarts is built via a master seed, ADR 0003 part 3.)*
- Talking-point ready: when we meet Cfx.re / RageMP / Take-Two, we can demo the ledger mode today. An on-chain mode is a **future design option**, not a switch — it would need its own backend and real key custody work first.

## Non-goals (v1)

- Everything lives in a ledger, not a blockchain, token or crypto asset — that's what keeps this
  inside Rockstar/FiveM's rules around crypto-related content.
- No DEX, no AMM, no lending — closed economy.
- No NFTs for items (vehicles, houses) in v1. Items live in the game DB. Maybe v2.
- No anti-cheat hardening beyond what the engine can check itself — this is a trusted-friends server. (Note: without adapter authentication, anything that can call the engine can claim any actor. See ADR 0004.)

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Game World (FiveM / RageMP / standalone sim)                │
│  ┌─────────────────────────────────────────────────┐        │
│  │ Game Adapter  (Lua resource for FiveM,           │        │
│  │                JS package for RageMP,            │        │
│  │                CLI sim for standalone)           │        │
│  └────────────────────┬────────────────────────────┘        │
└───────────────────────┼─────────────────────────────────────┘
                        │  Intent   (planned: HTTP/WS with an HMAC envelope, ADR 0003;
                        │            today: a direct call to engine.submit())
                        ▼
┌─────────────────────────────────────────────────────────────┐
│ Economy Engine  (Node.js / TypeScript library)              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ Intent Router│  │ Pricing/Rules│  │ Custody (in-mem) │   │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘   │
│         └── validates, prices; (planned: signs) ┘           │
└────────────────────────────┬────────────────────────────────┘
                             │  Ledger op (transfer/mint/burn)
                             ▼
┌─────────────────────────────────────────────────────────────┐
│ Ledger Backend (swappable, single interface)                │
│  ┌───────────────────────────────────────────────────────┐  │
│  │          memory + sqlite + postgres  —  built          │  │
│  │             Solana  —  planned, not built              │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### 1. Game Adapter (in-game) — [planned; only the CLI sim is built]

A thin layer that runs inside the GTA server framework. Its only job: turn in-game events into typed economy **Intents** and hand them to the Economy Engine.

| Event | Intent |
|---|---|
| Player joins | `OpenAccount(player)` → welcome grant, **once per player** (repeat calls return `ACCOUNT_EXISTS`) |
| Player interacts with bike rental NPC | `RentVehicle(player, "bike", minutes)` → returns a `txId`, which is the rental id |
| Player returns the bike | `ReturnVehicle(player, rentalId, minutesUnused)` |
| Player enters hospital | `BuyService(player, "hospital_full_heal")` |
| Player completes a paying job | `Payout(employer="taxi-co", player, amount)` |
| Player robs another player | `Theft(victim, robber, amount, authorizedBy)` — `authorizedBy` must be the victim (consent) or a configured admin |
| Cop fines player | `Fine(player, amount, reason)` → pays the treasury |
| `/pay 02 50` | `Transfer(from, to, amount)` |

Adapter implementations (none written yet):
- **FiveM**: Lua resource. Would use `PerformHttpRequest` once the engine has an HTTP surface.
- **RageMP**: JavaScript package, native `fetch`. Same intent contracts.
- **Standalone sim** **[built]**: a CLI (`npm run sim`) that simulates player events. Useful for dev, demos, and arguing with companies without booting a real GTA server.

The adapter never touches balances directly. It only emits intents and renders the engine's response (e.g., "✓ Paid 10 HD. Bike spawning…"). It must treat `ok: true` as final: the ledger write has settled even if `newBalance` is `null`.

### 2. Economy Engine — [built, as a library]

The brain. Owns:
- **Intent router** **[built]** — validates each intent against the world rules (does the player have enough? Is the entity real? Is the price right? Is this an entity id pretending to be a player?). Intents run one at a time behind a mutex (ADR 0005).
- **Pricing/rules** **[built]** — config-driven prices and entities, JSON (`heist.config.json`), validated at load. Not hot-reloadable yet.
- **Custody** **[built]** — generates and holds ed25519 keys, refuses on-chain backends. Persistence via HKDF from a master seed is **[built]** (ADR 0003 part 3; not yet wired into the CLI). Signing itself (part 1) and MPC (v2) remain **[planned]**.
- **Settlement** **[built]** — produces a ledger operation and hands it to the backend, atomically with the nonce and key guards.

Intent flow, as built:
```
1. Caller invokes engine.submit(intent {type, nonce, actor, ...})
2. Engine validates: schema, ids, entity/player separation, balance, price, authorization claims
3. Engine calls LedgerBackend.transfer / mint / burn (atomic: row + balances + nonce + key)
4. Engine returns {ok, txId, hash, newBalance, message}, or {ok:false, code, message}
5. The adapter triggers the in-game effect (spawn bike, restore health)
```

Planned additions to that flow (ADR 0003): authenticate the adapter envelope before step 2, and sign the canonical payload with the payer's custodial key inside step 3.

If the ledger op fails, the in-game effect does NOT happen. Atomicity is engine-side: don't spawn the bike before the transfer settles. A retry of an already-settled intent (same nonce, same actor, same type) returns the original result with `replayed: true`.

### 3. Ledger Backend (swappable)

The interface in `src/ledger/backend.ts` (summarised):

```ts
interface LedgerBackend {
  init(): Promise<void>;  close(): Promise<void>;
  createWallet(ownerId, key: { pubkey, address }, opts?): Promise<Wallet>;   // idempotent per owner
  getWallet(id) / getWalletByOwner(ownerId) / listWallets();
  getBalance(walletId): Promise<bigint>;
  transfer(from, to, amount: bigint, memo): Promise<TxRef>;
  mint(to, amount, memo): Promise<TxRef>;      // money enters the world
  burn(from, amount, memo): Promise<TxRef>;
  history(walletId, cursor?, limit?): Promise<HistoryPage>;
  getTx(txId) / getTxByNonce(nonce) / hasNonce(nonce);
  verifyIntegrity(expected?: Checkpoint): Promise<IntegrityReport>;
  checkpoint(): Promise<Checkpoint | null>;
}
```

Backends receive only the *public* half of a wallet's keypair; they never generate or store private keys.

**Memory backend** [built]: reference implementation, for tests and dry runs.

**SQLite backend** [built]: the default for a real local server. `node:sqlite`, file-backed, WAL, `synchronous=FULL`.
- `wallets`, `transactions` (hash-chained: `seq`, `prev_hash`, `hash`, `signature` — **always null today**), a maintained `balances` table (not a SQL view; amounts are TEXT, see ADR 0002), and replay-guard tables `nonces` and `memo_keys`.
- Append-only triggers, `CHECK` constraints, foreign keys (ADR 0006).
- `verifyIntegrity` checks hashes, ledger rules, balances, replay guards and an optional external checkpoint.

**Postgres backend** [built]: the same SQL shape as SQLite, using the `pg` package (an
optionalDependency, loaded lazily so memory/sqlite-only users never need it installed). Schema-isolated
per instance — `config.databaseUrl` points at the server, and each backend instance gets its own
Postgres schema, auto-generated and self-dropping unless a stable name is pinned for a real deployment.
Runs the identical conformance suite as memory and sqlite. One real difference from sqlite: `node:sqlite`
is synchronous, so sqlite's append/createWallet get atomicity "for free" from never `await`-ing mid-write;
`pg` cannot be synchronous, so this backend wraps its own write paths in the engine's `Mutex` class to get
the same guarantee independent of any caller (see the file's header comment for why that matters).

**Solana backend** [planned]: not built. Would be HD as an SPL token, server multisig mint authority, server-custodied player keypairs — making the engine a custodian of real transferable on-chain assets. That would need a backend implementation and an ADR covering key generation, encryption, recovery and blast radius first.

## Entity wallets (NPC accounts) — [built]

The economy has wallets that aren't players:

| Entity | Purpose |
|---|---|
| `treasury` | Mint authority for welcome grants (a grant is a mint attributed to the treasury, ADR 0004). Also receives fines. |
| `bike-rental-co` | Receives rental fees, pays refunds. |
| `hospital` | Receives medical fees. |
| `gas-station-N` | One per gas station. |
| `taxi-co`, `pd-payroll`, etc. | Job-based payouts. |
| `pd-impound` | Vehicle impound release fees (via `BuyService`). |
| `car-dealer` | Vehicle purchases (via `BuyService`). |
| `realty-office` | Property purchases and rent (via `BuyService`/`DepositToSociety`). |
| `casino-house` | Gambling sink — wagers in, payouts out (via `PlaceBet`/`SettleBet`). Same ledger currency throughout; nothing here ever moves money outside this ledger. |

Entity wallets are owned by the server but each is a real, addressable ledger account, so you can see the full flow of money — e.g., "the hospital made 12,400 HD this week." Entity ids are **reserved**: a player intent can never name one as actor, recipient or victim. Entities start empty; an operator funds them with `EconomyEngine.fundEntity` (admin only, not an intent; the sim's `fund` command).

## Intent catalog (v1) — [built]

| Intent | Payer | Payee | Trigger |
|---|---|---|---|
| `OpenAccount` | mint (treasury authority) | new player | first join; once per owner; welcome grant from config |
| `RentVehicle` | player | `bike-rental-co` | NPC interaction; records `vehicle` and `minutes` in the tx |
| `ReturnVehicle` | `bike-rental-co` | player | return by rental id; refund is `paid × unused / rented`; once per rental |
| `BuyService` | player | service entity | hospital, gas, food, **and any fixed-price catalog item** — impound release, a vehicle, a property, rent, since these are all just a `services` config entry, not a new intent |
| `Payout` | employer entity | player | end-of-shift, job completion, **or any entity paying a player an adapter-decided amount** — a chop-shop buying a stolen vehicle, an NPC drug buyer, recurring wages, are all just `Payout` with a different employer id and memo |
| `Fine` | player | `treasury` | police action |
| `Transfer` | player | player | direct send (`/pay 02 50`), **or a peer-to-peer sale** — a player buying contraband from another player is `Transfer` with a different memo |
| `Theft` | victim | robber | needs the victim's consent or a configured admin |
| `DepositToSociety` | player | any configured entity | the generic "pay a business an adapter-decided amount" primitive — a society/government account deposit, rent paid on a timer, anything without a catalog price |
| `RobEntity` | entity | robber | robbing a store/bank/ATM, not a player — unlike Theft, the source cannot consent, so this is **admin-authorized only** |
| `PlaceBet` | player | casino entity | the wager |
| `SettleBet` | casino entity | player | pays out a WON bet, referencing the `PlaceBet` txId; a loss needs no call at all |
| *(not an intent)* `fundEntity` | mint | entity | operator only |
| *(not an intent)* `taxEntity` | entity | entity | operator/scheduled job only — the one operation with no player on either side (e.g. periodic business-to-government tax) |

**Deliberately not separate intents.** `WithdrawFromSociety`, `PayWage`, `SellStolenVehicle` and `SellContraband` (to an NPC) are mechanically identical to `Payout` — an entity paying a player an amount the adapter decides — so they reuse it with a different employer id and memo rather than duplicating the same code under a new name. `BuyVehicle`, `BuyProperty`, `ImpoundRelease` and `PayRent` (when the rent is a fixed amount) are `BuyService` catalog entries. A peer-to-peer contraband sale is `Transfer`. `SendInvoice`/`PayInvoice` (a bill that is recorded before it's paid) is NOT covered yet — it needs the backend to track an unpaid, not-yet-settled obligation, which none of the three ledger backends currently have a concept for. That is real new backend work, not just a new intent, and deserves its own pass rather than being forced in here.

**What the engine cannot verify.** Until adapter authentication exists (ADR 0003), the engine takes the `actor` and any `authorizedBy` claim at the adapter's word. It checks that they are well-formed, that entities are not players, and that an authorizer is the victim or a configured admin. It cannot check that the adapter is telling the truth. ADR 0004 lists exactly what remains open.

## Config example

The real format is JSON (`heist.config.json`, validated at load; there is no YAML dependency):

```json
{
  "backend": "sqlite",
  "dbPath": "./heist.sqlite",
  "currency": "HD",
  "welcomeGrant": "500",
  "admins": [],
  "prices": { "bike_rental": "10" },
  "rentalPerMinute": { "bike": "1", "car": "3", "helicopter": "25" },
  "services": {
    "hospital_full_heal": { "entity": "hospital", "price": "200" },
    "gas_per_liter": { "entity": "gas-station-1", "price": "2" }
  },
  "entities": [
    { "id": "treasury", "name": "City Treasury" },
    { "id": "bike-rental-co", "name": "Crystal Bikes" },
    { "id": "hospital", "name": "Pillbox Medical" },
    { "id": "gas-station-1", "name": "Xero Gas — Strawberry" }
  ]
}
```

Money values are quoted decimal strings, never JSON numbers, and zero prices are rejected. `backend` is `memory`, `sqlite` or `postgres` today (`postgres` additionally needs `databaseUrl`); `solana` is an accepted name that fails at startup.

## Why this design works for the company conversations

- **The ledger mode is shippable in principle** — it's a server-side ledger, not a blockchain,
  token or crypto asset, which is what keeps it inside Rockstar/FiveM's rules around
  crypto-related content. *(In practice there is no adapter yet, so nothing is shippable to a server today.)*
- The on-chain backends are an **architectural option**, not a feature. The honest statement to Cfx.re is: "the ledger sits behind an interface that could take a Solana backend; we have not written one, and nothing turns it on by itself."
- **The intent layer is the actual innovation** — typed, auditable economic actions. Useful even without crypto.
- If Cfx.re ever opens up to crypto (unlikely soon), a backend, custody and approval are needed first. It is a project, not a flag flip. If they don't, we still have an off-chain economy plugin.

## Open questions

1. Single Economy Engine for all game adapters, or one engine per game? (Default: single, multi-tenant. Not started.)
2. Welcome grant amount, prices, salary rates — needs a balance pass.
3. ~~What happens when a player rage-quits mid-rental?~~ Partly answered: a rental is a ledger record (ADR 0005), so an unreturned rental stays open and can be refunded later. There is no timeout or automatic close, and `minutesUnused` is adapter-reported, not clock-verified.
4. ~~Do we want anti-double-spend / nonce on intents?~~ Yes, built: nonces, replay returns the original result, and business keys make grants and refunds once-only (ADR 0005).
5. Admin UI: web dashboard for minting, viewing entity P&L, banning a wallet. (Planned.)
6. Backup/recovery story for custody keys. **Open and now blocking signing**: see ADR 0003, part 3.
7. Adapter authentication and per-adapter capabilities (who may submit `Payout`, `Fine`, `Theft`). Designed in ADR 0003, not built.
8. Where to keep the head checkpoint so it means something (ADR 0006).

## Build order

1. ✅ Economy Engine + memory, SQLite and Postgres backends + standalone CLI adapter — the full economy works without any GTA server, with a real database option when SQLite stops being enough.
2. ✅ Persistent custody keys (ADR 0003 part 3, decided and built 2026-10-20). Next, in order: signed
   ledger rows (part 1), then adapter authentication + HTTP surface (part 2) — both decided, neither
   built yet. Prerequisite for any real adapter.
3. FiveM Lua adapter — connect to a local FiveM dev server, port one interaction (bike rental).
4. RageMP JS adapter — same interaction, different framework.
5. Solana backend behind explicit approval — same intents, real SPL transfers.
6. Admin dashboard.
