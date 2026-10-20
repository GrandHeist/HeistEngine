# Heist Engine

[![CI](https://github.com/GrandHeist/HeistEngine/actions/workflows/ci.yml/badge.svg)](https://github.com/GrandHeist/HeistEngine/actions/workflows/ci.yml)

[@GTAHeistEngine](https://x.com/GTAHeistEngine)

An economy engine for GTA RP servers built around a swappable ledger backend. Every economic action in
the world (rent a bike, pay the hospital, get a payout, fines) is a typed intent that the engine turns
into a transfer, mint or burn on an append-only, hash-chained ledger of player and entity wallets.

The in-game currency is **HD** — Heist Dollars.

## What exists today

| | Status |
|---|---|
| Economy engine (8 intents + an admin funding call), config-driven prices and entities | **works** |
| **Memory** ledger backend (tests, dry runs) | **works** |
| **SQLite** ledger backend (`node:sqlite`, file-backed, hash-chained, tamper-checked) | **works** |
| **Postgres** ledger backend (`pg`, schema-isolated, same conformance suite as the other two) | **works** |
| Standalone CLI simulator (`npm run sim`) | **works** |
| **Solana** backend | *not written, and gated on purpose.* Custody refuses on-chain modes until a human signs off (see `src/engine/custody.ts`) |
| **Signed transactions** | *designed, not implemented.* Ledger rows are hash-chained but their `signature` column is empty. See [ADR 0003](docs/adr/0003-signing-design.md) |
| **Adapter authentication**, HTTP/WS server | *not written.* The engine is a library; only the CLI drives it |
| **FiveM** (Lua) and **RageMP** (JS) adapters | *not written* |
| Persistent custody keys | **library-level, not yet wired to the CLI.** HKDF-derived per-wallet keys from one master seed (ADR 0003 part 3) — `Custody` derives and reconciles, `EconomyEngine.init()` enforces a restart reproduces every key or refuses to start. No `--master-seed-path` flag on `npm run sim` yet |

So the honest pitch today: a tested, off-chain economy ledger you can drive from a CLI. Its transaction history is hash-chained, so edits to it are detectable; it is not yet tamper-proof (no signatures, and the wallet registry is not covered: see ADR 0006).
Everything else in the spec is design.

## Try it

Node 24 or newer (`node:sqlite` is built in; there are no required runtime dependencies — `pg` is an
optionalDependency, only needed for the Postgres backend).

```sh
npm install        # dev dependencies, plus pg for the postgres backend
npm run check      # typecheck + the full test suite (needs a local Postgres — see below)
npm run sim        # interactive simulator, in-memory ledger
npm run sim -- --backend=sqlite --db=./heist.sqlite                          # persistent ledger
npm run sim -- --backend=postgres --database-url=postgres://localhost/heist  # or Postgres
```

The Postgres backend's conformance tests need a real local Postgres reachable at
`TEST_DATABASE_URL` (defaults to `postgres://localhost/heist_engine_test`) — they run for real against
it, not a mock, same as the sqlite tests run against a real file. If nothing is listening there, that
one backend's conformance suite is skipped (reported in the test output) rather than failing the run.

In the sim, `seed` funds the payout entities and opens two demo players; `help` lists the commands.
The sim verifies the ledger on every start and refuses to run on one that fails. See
[ADR 0006](docs/adr/0006-store-hardening-and-checkpoints.md) for exactly what that check does and does
not catch.

## How money moves

- An adapter sends an **intent** (`OpenAccount`, `RentVehicle`, `ReturnVehicle`, `BuyService`, `Payout`,
  `Fine`, `Transfer`, `Theft`). It never names a ledger operation and never touches balances.
- The engine validates it against the world rules, then writes one ledger row. Money is `bigint` end to
  end; amounts are decimal strings on the wire ([ADR 0002](docs/adr/0002-money-as-bigint-stored-as-text.md)).
- Entity accounts (`treasury`, `hospital`, ...) are funded by an admin call on the engine object, which is
  deliberately not an intent.
- Who may do what, and what still needs adapter authentication: [ADR 0004](docs/adr/0004-engine-authority-and-welcome-grant.md).

## For server owners

The goal is a drop-in engine: install an adapter for your framework, point it at the engine, and your
economy becomes an auditable ledger instead of a number in a database. **That goal is not met yet.** There
are no adapters and no network interface, so today this is for developers. Status: in development.

See [`docs/SPEC.md`](docs/SPEC.md) for the architecture and intent catalog (each section says what is built and
what is planned) and [`docs/adr/`](docs/adr/) for decisions that are expensive to reverse.
