# ADR 0003 — Signing ledger rows, authenticating adapters, persisting custody keys

Date: 2026-09-24
Status: **Decided 2026-10-20 — all four questions answered (see the end). Part 3 (custody
persistence) is implemented: `src/engine/masterSeed.ts`, `Custody` constructor option
`masterSeed`, `Custody.reconcileExistingWallet`, wired into `EconomyEngine.init()`. Parts 1 and 2
(signing, adapter auth/HTTP) are still not implemented — next per the rollout order below.**

## Context

Three things the SPEC and README implied are not true today, and they are one problem seen from three
sides:

1. **Ledger rows are not signed.** `Tx.signature` is always `null` (`src/ledger/memory.ts`,
   `src/ledger/sqlite.ts`). `Custody.sign` / `Custody.verify` exist and are tested, but nothing calls
   them. The hash chain detects *edits* to history; it cannot stop someone with write access to the
   database from appending a forged, correctly hashed row (ADR 0006, last table row).
2. **The engine cannot tell who is calling it.** `submit()` trusts `actor` and any `authorizedBy`
   claim. Anything that can reach the engine can `Payout` itself money or `Fine` someone (ADR 0004,
   "What this does NOT fix").
3. **Custody keys die with the process.** `Custody` keeps keys in a `Map`. After a restart every
   wallet still has its `pubkey` in the ledger but the engine holds no private key for it. This is
   harmless only because nothing is signed. The moment rows are signed it becomes a hard failure.

The design below fixes them in that dependency order: keys must persist before rows can be signed, and
rows should be signed before the adapter surface is exposed on a network.

Constraints carried over from the project rules: this is an **off-chain signing scheme for a
non-redeemable in-game currency, not a wallet**. The on-chain custody guard (`ONCHAIN_CUSTODY_BLOCKED`)
stays exactly as it is; nothing here relaxes it, and keys created for this scheme must never be reused
on any chain. Only the maintainer writes the key-handling code.

## What a signature does and does not buy here

Server-custodial means the server holds every player's key and players never sign. So a signature does
**not** prove a player consented. It proves that *something holding the key material authorized this
exact row at this exact position in the chain*. That is valuable against a specific attacker:

- **Protects against:** someone who can write the database or its backups but does not have the keys
  (a leaked backup, a DBA, a compromised host that only got the DB file, a stray script). They can no
  longer append or rewrite rows and have them verify. This closes the last gap in ADR 0006.
- **Does not protect against:** compromise of the running engine process, or of wherever the keys live.
  That attacker signs whatever they like. Where keys live is therefore the whole security question
  (part 3).
- **Does not prove player consent.** Only an authenticated channel from the player's own client could,
  and that is out of scope.

## Part 1 — Signing inside the atomic append

### The problem

The signable payload (`canonicalTxPayload`) includes `prevHash`, `seq` and `createdAt`. Those are only
known inside the backend, while it holds the write lock, immediately before the insert. The engine
cannot sign earlier without guessing them, and signing *after* the insert means updating an append-only
row (the triggers forbid it) and leaves a window where an unsigned row exists.

### Options

**A. Signer callback inside the append.** The write takes a synchronous `sign(payload) => hexSig`. The
backend builds the payload under its lock, calls `sign`, verifies the result against the payer's stored
pubkey, and inserts the row and signature in the same transaction.

- Simple; atomic; one code path; a signer that throws rolls the whole write back cleanly.
- The signer must be **synchronous**, because `node:sqlite` transactions are synchronous. Fine for
  in-process ed25519 (tens of microseconds). It rules out a remote KMS/HSM/MPC signer.
- The signature is produced while the database write lock is held. At friends-server volume that is
  irrelevant; it would matter with a network signer.

**B. Reserve-then-commit.** Two calls: `prepare(op) -> { payload, expectedHead }` (no lock kept), the
engine signs the payload wherever it likes (async, remote), then `commit(op, signature, expectedHead)`
which re-checks that the head is unchanged and fails with `HEAD_MOVED` if not.

- Supports async and remote signers. This is the shape MPC/KMS needs.
- Two states to reason about, a retry path, and a larger interface every backend (including future
  Postgres and on-chain ones) must implement correctly.
- The *pessimistic* variant (hold the chain head between the calls) blocks every other write for the
  duration of a network round trip and needs reservation expiry and crash recovery. Not recommended.
- The *optimistic* variant above is cheap **here**: the engine already serializes intents behind a
  mutex (ADR 0005), so within one process the head cannot move between `prepare` and `commit`, and
  `HEAD_MOVED` only fires for a second writer, which is unsupported anyway.

**C. Sign after the append and update the row.** Rejected: violates append-only, leaves unsigned rows
visible, and an unsigned row is indistinguishable from a tampered one.

### Who signs what, and what is covered

| Op | Signed by | Verified against |
|---|---|---|
| `transfer`, `burn` | the payer wallet's key | `wallets.pubkey` of `from` |
| `mint` (welcome grant, admin funding) | the **treasury** entity's key (the "mint authority") | `wallets.pubkey` of the treasury wallet |

The signature is ed25519 over the exact canonical payload string, so it binds `prevHash` and `seq`: a
valid signed row cannot be replayed at a different position. The row `hash` continues to cover the
payload only (not the signature), so existing hashes are unchanged and signing is additive.

### Verification and rollout

- `verifyIntegrity` verifies every signature against the wallet pubkeys already stored in the ledger.
  That needs public data only: an auditor needs no key access.
- Existing rows have `signature = NULL`. To stop an attacker simply appending *unsigned* rows, the
  ledger records a write-once `signed_from_seq` (in a small append-only `ledger_meta` table, and
  exported with the checkpoint). Rows at or after it must carry a valid signature; earlier rows are
  legacy. There is no released data, so the pragmatic path is to start new databases signed from seq 0.
- Key rotation needs `wallet_keys(wallet_id, pubkey, valid_from_seq)` rather than one pubkey per wallet.
  Left open; v1 can defer rotation as long as the HKDF epoch (part 3) is reserved in the design.

### Recommendation

**Option A for v1**, exposed as a `Signer` type so callers never see which option is behind it, with the
backend verifying every signature it is handed. Move to **B (optimistic)** only when an async signer
(KMS/HSM/MPC) is actually needed. That upgrade is contained in the backend interface and the engine's
write path; the payload, the signatures on disk and `verifyIntegrity` do not change.

## Part 2 — Authenticating the adapter

### What it fixes

Today `Payout`, `Fine` and `Theft` are callable by anything that can call `submit`. The fix is to
authenticate *which adapter* is calling and to scope each adapter to the intents it may send. A FiveM
resource gets `OpenAccount`, `RentVehicle`, `ReturnVehicle`, `BuyService`, `Transfer`; only a payroll
process gets `Payout`; only a police resource gets `Fine`; `Theft` needs a consent-capable adapter.

### Options

| Option | For | Against |
|---|---|---|
| Static bearer token | trivial in any language | replayable, ends up in logs, no body integrity |
| **HMAC envelope** (per-adapter `kid` + shared secret) | body integrity, timestamped, one primitive available everywhere | shared secret on both sides; Lua has no built-in HMAC (see below) |
| Ed25519-signed envelope | engine holds only public keys, so an engine leak does not leak adapter secrets | Lua/RageMP need an ed25519 library; more moving parts |
| mTLS | strongest transport-level identity | certificate issuance and rotation is real ops work for a friends server |

### Proposed envelope (HMAC-SHA256)

```
POST /v1/intents
X-Heist-Kid: fivem-main
X-Heist-Ts:  <unix seconds>
X-Heist-Mac: hex( HMAC-SHA256( secret[kid],
                    "heist-intent-v1\n" + kid + "\n" + ts + "\n" + sha256hex(body) ) )
body: canonical JSON of the intent (UTF-8, keys sorted, amounts as decimal strings)
```

Engine checks, in order: known and active `kid`; MAC equal in constant time; `|now - ts| <= 30s`;
`intent.type` is in that adapter's scope; only then `submit()`. The intent `nonce` is inside the MAC'd
body and the ledger already refuses reuse, so replaying a captured envelope inside the window returns
the original result (ADR 0005) and can do nothing new.

Scopes live in config; secrets do not (`secretEnv` names an environment variable or a `chmod 600` file
outside the repo). The engine binds to loopback or a unix socket; HMAC gives integrity and identity, not
confidentiality, so anything crossing a network needs TLS as well.

**Lua caveat (unverified, check before building).** As far as we know FiveM's Lua has no built-in HMAC.
Either the FiveM resource carries a small pure-Lua SHA-256/HMAC, or a tiny server-side JS resource does
the signing on the Lua resource's behalf; FiveM also supports JavaScript server resources, but whether
its runtime exposes `node:crypto` should be confirmed on a real FiveM server first. RageMP is JS and has
no issue.

### What it still does not fix

A compromised adapter host can claim any actor *within its scope*, and "the victim consented" is still
the adapter's word. Real consent needs the player's own client in the loop. That is a product decision
(is a friends server worth it?), not something to hide in this layer.

### Recommendation

HMAC envelope with per-adapter `kid`s and intent scopes, loopback-only by default. Revisit Ed25519 if the
engine and adapters ever run on different trust domains.

## Part 3 — Persisting custody keys

Prerequisite for part 1. Today `#keyFor` (engine.ts) mints a fresh random key the first time a wallet is
created *in this process*. After a restart the wallet exists, custody has no key, and a signing engine
would either fail or, worse, mint a new key that does not match `wallets.pubkey`. Whatever is chosen
must make **a missing or wrong key a startup failure**: at boot, for every wallet, the key custody can
produce must reproduce the stored `pubkey`, otherwise refuse to start.

### Options

1. **Derive every key from one master seed.** `seed_w = HKDF-SHA256(masterSeed, salt = "heist-wallet-v1",
   info = ownerId ‖ epoch)`, imported as an ed25519 key. Nothing per-wallet is stored.
   - Backup is one 32-byte secret. Restart and disaster recovery are trivial. Almost no code.
   - One secret compromises every key, and you cannot revoke a single wallet's key (rotate by bumping its
     epoch, which needs the rotation table above).
   - Since the server holds all keys anyway, the blast radius is not larger than any other design that
     keeps keys on that host.
2. **Encrypted key store.** Per-wallet random keys, encrypted with AES-256-GCM under a master key, kept
   in a *separate* store from the ledger (AAD = ownerId ‖ pubkey).
   - Per-wallet keys, and the SPEC's original "encrypted KV" plan. Revocation and rotation are natural.
   - The master key still has to live somewhere; you now also back up and restore a store, and losing
     the store loses signing for every wallet it held.
3. **Plaintext key files, `chmod 600`, git-ignored.** Matches the project rule for dev material.
   Acceptable for a dev machine only: no protection if the disk or a backup leaks.
4. **One ledger authority key, no per-wallet keys.** Because the server signs for everyone anyway,
   per-wallet keys add little on an off-chain ledger.
   - Least to manage; also the least future-proof, since per-wallet identities are what an on-chain or
     self-custody future would want, and `Wallet.pubkey` already exists per wallet.
5. **External KMS / HSM / MPC** (the SPEC's v2). Strongest, and it is what forces part 1 option B.
   Overkill for this deployment now.

### Recommendation

**Option 1 for v1**: HKDF-derived per-wallet keys from one master seed held in a `chmod 600` file (or
environment variable) *outside the repository and outside the database directory*, backed up separately
from ledger backups (a leaked ledger backup must not also leak the seed). Reserve an `epoch` in the
derivation from day one so rotation is possible later without changing the scheme. Move to option 2 only
if per-wallet revocation or more than one operator becomes a real requirement, and to option 5 with B if
the threat model ever includes a compromised engine host.

**Migration.** Wallets created before this change have random, lost keys, so their stored pubkeys cannot
be re-derived. With no released data the answer is to recreate dev databases. If real data ever exists
first, the answer is a signed `rekey` row per wallet, authorized by the treasury key.

## Rollout order

Each step is independently testable and none touches the on-chain guard.

1. **Custody persistence** (part 3, option 1) plus the startup pubkey check. Tests: restart reproduces
   every pubkey; missing or wrong seed refuses to start.
2. **Signing** (part 1, option A): `Signer`, backend verification, `ledger_meta.signed_from_seq`,
   `verifyIntegrity` signature check, signed checkpoint. Tests: tampered/unsigned/wrong-key rows fail
   verification; a signer that throws leaves no row, no nonce, no key consumed.
3. **Adapter envelope and HTTP surface** (part 2), scoped by capability config. Tests: bad MAC, stale
   timestamp, out-of-scope intent, replayed envelope.
4. Only then the FiveM and RageMP adapters.

## Risks and open questions

- **Clock skew** on the 30 s window when the adapter and engine are on different hosts.
- **Master-seed loss** is unrecoverable for signing (history stays readable and verifiable). The backup
  procedure is part of the feature, not an afterthought (SPEC open question 6).
- **Signing cost** is negligible now; measure before assuming so if volume ever changes.
- **Checkpoint placement** is still on the operator (ADR 0006). A signed checkpoint helps with
  authenticity, not with where it is stored.
- The design assumes **one engine process per ledger** (ADR 0005).

## Decision from the project owner (2026-10-20)

1. Part 1: **option A** (sync signer) accepted, B reserved as the later upgrade. Not yet implemented.
2. Part 2: **HMAC envelope** with per-adapter scopes accepted, including a server-side JS shim for
   the Lua resource since Lua has no built-in HMAC. Not yet implemented. The Lua-crypto question
   this ADR flagged as unverified still needs checking against a real FiveM server once one exists.
3. Part 3: **option 1** (HKDF from a master seed) accepted. Seed file lives `chmod 600`, outside
   the repo, same convention as this machine's other secrets. **Implemented** — see `src/engine/masterSeed.ts`.
4. Signatures will require seq 0 (recommended) once Part 1 lands — no released data exists yet.
