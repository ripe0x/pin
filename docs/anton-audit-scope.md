# anton work — audit scope

The anton work is an onchain generative **Surface** collection that is
**chain-live and owner-reactive**: a token's rendered document depends on the
token's minted identity (palette + tone), its seed, and the *current owner*. The
image legitimately changes over time and on transfer. This scope covers the
bespoke contracts that make that work; the Surface core, factory, and the
external scripty/EthFS infrastructure are out of scope (audited / external).

## In scope

`contracts/src/surface/works/anton/`

| Contract | Role | Surface |
| --- | --- | --- |
| `AntonParams.sol` | owner-mutable per-token identity (palette, tone) | writes: `initParams` (minter, once), `setParams` (token owner); read: `paramsOf` |
| `AntonMinter.sol` | fixed-price minter, records the pick at mint | payable `mint`, pull-payment `withdraw`, owner-gated config |
| `AntonRenderer.sol` | chain-live `ScriptyRenderer` fork | view-only `tokenURI` / `previewURI` |
| `AntonScriptStore.sol` | SSTORE2 store serving `base64(gzip(anton.js))` | immutable, `getContent` |

Plus one shared change, in scope for the diff:

- `contracts/src/surface/templates/ScriptyRenderer.sol` — `_contextJs` and
  `_attributes` changed from `private` to `internal virtual` so a chain-live
  fork can extend them. Additive; the base behavior and `ExampleScriptyWork` are
  unchanged (full suite green). Confirm no behavioral change to existing
  subclasses.

## Out of scope

- Surface core / factory / `FixedPriceMinter` (separately audited protocol).
- ScriptyBuilderV2 (`0xD758…F022`) and EthFS (`0x8FAA…3245`) — external,
  deployed, widely used; trusted dependencies.
- `works/anton/anton.js` — the artwork (client-side render), not a contract. Its
  determinism/parity is verified separately (browser + injection convention),
  not a contract-security concern.

## Trust model

- **Collection owner** is trusted: grants/revokes minters, sets minter price /
  window / payout. Cannot read or move mint proceeds except as the payout
  recipient (pull payment).
- **Authorized minters** are trusted to call `mintTo` and `AntonParams.initParams`.
  This work grants exactly one (`AntonMinter`).
- **Token owner** controls only their own token's params (`setParams` is gated on
  `ownerOf`).
- Scripty/EthFS behave per their public interfaces.

## Key invariants

1. A stored token identity is always in range: `palette < paletteCount`,
   `tone < toneCount` (validated on every write).
2. `AntonParams` is writable only by (a) an authorized minter of the collection,
   once per token (`initParams`), or (b) the current token owner (`setParams`).
3. `tokenURI` / `previewURI` never mutate state and never revert for a minted
   token (owner read is try/catch; params fall back to defaults when unset).
4. `AntonMinter`: total ETH received over the minter's life == sum of pending
   withdrawals ever accrued; no path lets ETH be stranded or double-withdrawn.
   Reentrancy cannot mint more than paid for or misroute proceeds.
5. Supply is bounded by the core's `supplyCap` (the minter does not itself cap).
6. No field injected into the rendered JSON/HTML can break out of its string
   context (all injected values are numeric, hex, or fixed-vocabulary enum
   names; `name` is `escapeJSON`'d by the base).

## Specific items to review

- **`AntonParams.initParams` does not check the token exists.** It is a mint-time
  write and once-only. Consider: a *second* authorized minter (if one were ever
  granted) could pre-`initParams` a not-yet-minted id; because the write is
  once-only, the legitimate mint's `initParams` would then revert
  `AlreadyInitialized`, bricking that id. Single-minter today (moot), but a
  recommended hardening is to require the token to exist (or restrict to the
  minter assigning the id). Decide whether to add the guard.
- **`AntonMinter` reentrancy** around `ISurface.mintTo` (does the core use a
  receiver callback?) and the pull-payment `withdraw` (`call`). `mint` and
  `withdraw` are `nonReentrant`; confirm that is sufficient given the core's mint
  path.
- **`AntonMinter` payment exactness** (`msg.value == price`), `price == 0`
  behavior, and the referrer being folded into payout (no split).
- **`AntonRenderer`** JSON/HTML assembly for injection safety across all injected
  fields, and that `previewURI` (inherited, not faithful for this chain-live
  work) cannot mislead — it returns a document with owner defaulted to zero for a
  nonexistent id.
- **`AntonScriptStore`** immutability and that `getContent` ignores `name` by
  design (single file).
- **Parity discipline (informational):** the renderer's palette/tone name
  vocabularies must match the JS exactly; a mismatch is a correctness bug, not a
  security one, but worth a glance.

## Deployment shape (for context)

Deploy order: `AntonParams` → `AntonScriptStore` → `AntonRenderer` (wired to
scripty + EthFS gunzip, no deps) → collection via `createSurfaceCustom`
(renderer set, empty initial minters) → `AntonMinter` → `setMinter`. Optionally
`lockRenderer` for presentation permanence (note: the renderer reads mutable
state, so "permanent" means the code + rules, not a fixed image). See
`contracts/script/DeployAntonWork.s.sol`. Proven end to end on a mainnet fork and
on sepolia (`works/anton/DEPLOYMENTS.md`).
