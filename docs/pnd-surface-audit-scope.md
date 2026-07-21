# Surface: external-audit scope (thin token + modular minter)

> **Baseline for review: pin `main` @ `571a7a1`** (PR #164, the thin-token +
> modular-minter rearchitecture) plus the internal pre-audit remediations on
> branch `chore/surface-audit-baseline-reset` (`7056c77`; merged to `main` as
> PR #167, `65d770e`). This is the deploy gate: nothing here has had external
> review yet. It supersedes `docs/pnd-surface-reaudit-notes.md`, whose
> fat-token `43f4ae7` baseline no longer describes deployed code.
>
> **Post-baseline delta (fold into the same engagement).** Two contract PRs
> landed on `main` after this baseline and are part of the code that deploys;
> see "Changes after the baseline" below: PR #172 (primaryMinter discovery
> pointer) and PR #174 (comment pass + additive integration aliases).

## What changed since the last audited baseline

The system moved from a **fat token** (the ERC721 owned sale economics: paid
mint entrypoints, price/window fields, referral split, value custody by pull
payment, one mint-hook slot) to a **thin token + modular minter**: the ERC721
holds no value and no sale logic, and every mint goes through an authorized
minter. Design record and rationale: `docs/pnd-surface-thin-token-
rearchitecture.md` (decisions locked 2026-07-19, section 7). This is a large
rewrite of the value paths, so the prior audit's coverage of the sale code
does not carry forward; the token's non-sale machinery largely does (see
"Inherited" below).

## Contracts in scope

New or materially rewritten, the review focus:

- `contracts/src/surface/minters/FixedPriceMinter.sol` (new): the canonical
  paid-mint contract and the **only** contract that holds ETH. Per-collection
  EIP-1167 clone, sequential collections only. Value custody by pull payment,
  read-once price strategy, Merkle allowlist + per-wallet cap, referral split,
  borrowed collection authority. This is where external review money should
  concentrate: it is the new value-handling surface.
- `contracts/src/surface/interfaces/IMinter.sol` (new): the uniform mint ABI.
- `contracts/src/surface/SurfaceCore.sol`: stripped of all value custody,
  paid entrypoints, price/window/payout fields, lifecycle status, and the hook
  slot; new minter-gated non-payable `mintTo`/`mintToId`; reshaped `Minted`
  event; `config()` shape change; `rescueStrayETH` now sweeps the full balance
  (the token is non-payable).
- `contracts/src/surface/Surface.sol`, `PooledSurface.sol`: the two finals,
  now carrying only the minter-gated entrypoints.
- `contracts/src/surface/SurfaceFactory.sol`: `createSurface` clones token +
  canonical minter and wires them in one transaction; `createSurfaceCustom`
  (bring-your-own sequential minter) and `createPooledSurface` (BYO pooled);
  `SurfaceCreated(owner, collection, minter, idMode)` is the discovery binding.
- `contracts/src/surface/SurfaceTypes.sol`: `SurfaceConfig` shrunk to six
  fields; `SurfaceStatus` removed.
- `contracts/src/surface/renderers/MetadataJson.sol`: final-mint trait now
  derives from cap state alone.

## Inherited from the two prior reviews (verified intact, lower priority)

These guarantees were established by the two independent reviews of the fat
token and re-verified function-by-function against the audited source during
the internal pre-audit pass; they survived the strip unchanged and are lower
priority for re-review:

- Pooled single-minter enforcement (`TooManyMinters`) at both `initialize`
  and `setMinter`, keyed off the pooled id mode (external finding M-01).
- `lockMinter` one-way freeze; `_requireMinterAuthority` (pooled owner-only,
  sequential owner-or-admin).
- Owner-scoped admin grants: `_admins[account]` stores the granting owner, so
  an ownership transfer or renounce invalidates every inherited grant (#150).
- `addAdmin(owner())` rejection (I-01); nonzero-slot contracts-only checks
  (#148); supply-cap floor checks; renderer-lock semantics; ScriptyRenderer
  store-code checks (I-02).
- OZ `_mint` (not `_safeMint`) throughout: no ERC721-receiver reentrancy
  surface from the token side.

Unchanged singletons outside this scope: `Catalog.sol`, `RenderAssets.sol`,
`DefaultRenderer.sol`, the ScriptyRenderer templates (pre-existing; a `slither`
dead-code note on `ScriptyRenderer._headTags`/`_workTraits` is out of this
PR's blast radius and tracked separately).

## Internal pre-audit findings and their remediations

An internal three-lens pass (value/reentrancy, access/regression, static/
coverage) ran over `571a7a1` before external handoff. Findings, all remediated
in `7056c77`, listed so the external review can confirm the fixes rather than
rediscover them:

- **HIGH: renounce + default payout stranded proceeds.** A collection whose
  owner renounced (`owner() == 0`) while its minter's `payout` was left at the
  default (0 = live owner) would credit every subsequent sale's artist cut to
  `_pending[address(0)]`, unclaimable and unrecoverable (confirmed by PoC).
  This was a regression: the fat token blocked `renounceOwnership`; the thin
  token re-enabled it deliberately (design decision, §7) without re-deriving
  the guard the removed live-`owner()` payout resolution relied on.
  **Resolution: the payout target is decoupled from `owner()` entirely.**
  `FixedPriceMinter` stores a dedicated `payoutRecipient` address, enforced
  nonzero at both write points (`initialize`, `setPayoutRecipient`), and
  `_settle` pays it directly with no `owner()` call anywhere in the
  settlement path. `SurfaceFactory.createSurface` defaults an unset
  `SaleConfig.payoutRecipient` to the deploy-time `owner` argument, a stored
  snapshot, not a live read. A renounced collection keeps selling and keeps
  paying its stored recipient; renounce only removes the ability to change
  the recipient going forward (borrowed auth has no live owner/admin), not
  the ability to receive proceeds. This replaces the earlier revert-on-zero
  remediation (`PayoutUnresolved`), which caught the strand downstream but
  left the sale halted on a renounced collection with no explicit payout;
  the required-at-config-time invariant makes that state unreachable instead.
  Renounce availability is preserved.
- **LOW (same root): royalty to the zero address.** `SurfaceCore.royaltyInfo`
  resolved to `address(0)` under the same renounce-with-no-explicit-receiver
  condition. **Fix:** returns `(address(0), 0)` so no marketplace routes
  royalties to a dead address.
- **MEDIUM: `FixedPriceMinter.initialize` had no caller check.** A stranger
  could initialize a directly-cloned minter pointed at a live third-party
  collection with an attacker payout (confirmed by PoC); harmful only on
  non-atomic BYO deployment tooling, since the factory's `createSurface` path
  is atomic. **Fix:** `initialize` permits the call when the collection is not
  yet initialized (`owner() == 0`, the factory's atomic-wiring window) or when
  the caller is the collection's live owner/admin; reverts `NotAuthorized`
  otherwise. The factory path is unaffected (the token is uninitialized at
  minter-init time).
- **Gas (not a security finding).** Batch `mintTo` wrote `_mintedEver` once per
  iteration; hoisted to one write per call, seed derivation proven byte-
  identical.
- **Coverage.** `FixedPriceMinter` config-setter success paths, minter-side
  `rescueStrayETH` success, impl-level `_disableInitializers`, and the
  invariant handler's strategy-priced / config-mutating actions were added.

Accepted, no fix (documented design tradeoffs, called out for the reviewer to
confirm rather than re-flag):

- A bad `referrer` or `payout` address (contract with no payable receiver, or
  the minter's own address) can strand only its own credited balance; it can
  never block another party's mint (pull-payment isolation, tested).
- `IPriceStrategy` is an admin-wired, unaudited-by-the-core extension point: a
  malicious or reverting strategy can self-DoS its own collection's sale only.
  The core reads it once as a STATICCALL and never trusts it with custody.
- Referral is permissionless: a collector minting directly can name themselves
  the referrer and keep the share. This is the platform's stated no-gatekeeper
  position, not a defect.

## Changes after the baseline (PRs #172, #174; on `main`)

Both landed after the baseline above and before deploy, so the audited code
must be `main`'s tip, not the baseline commit. The full diff is
`git diff 65d770e main -- contracts/src/surface/` (~205 lines, 6 files).

- **PR #172, primaryMinter (behavioral, new state + ABI).** One new storage
  slot on the core (`_primaryMinter`), declared a frontend-discovery default
  only: every granted minter in `_minters` stays independently callable
  regardless of the pointer, so it carries no authority. Written at
  `initialize` (validated as a member of `initialMinters`; pooled additionally
  requires it be the sole minter), by `setMinter` (a pooled grant becomes
  primary automatically; revoking the current primary clears it in either
  form), and by the new sequential-only `setPrimaryMinter`
  (owner-or-admin, frozen once `lockMinter` fires). ABI changes:
  `createSurfaceCustom`/`createPooledSurface` gained a `primaryMinter`
  parameter (new selectors), `SurfaceCreated`'s third field is now the
  designated primary instead of always address(0) on the BYO paths (topic
  unchanged), and `primaryMinter()`/`setPrimaryMinter`/`PrimaryMinterSet`/
  two errors were added. Review focus: confirm the pointer can never mint,
  never dangles at a revoked minter, and cannot be set past lockMinter.
- **PR #174, source clarity + aliases (intended no behavior change).**
  `FixedPriceMinter.mint(address,uint256,address,bytes)` body extracted to
  `_executeMint(payer, ...)` with `payer = msg.sender` at both call sites; a
  new `mint(uint256)` convenience overload (mints to caller, no referrer, no
  data) enters the same body under its own `nonReentrant`; two additive view
  aliases `totalMintedByThisMinter()`/`saleCap()`; internal modifier rename.
  Review focus: confirm `_executeMint` is reachable only from the two
  nonReentrant externals and that the excess-refund accrual and `Sold` payer
  field still bind to the true msg.sender.

## Verification state at handoff

- Full suite: **452 passed, 0 failed, 2 skipped** (the two skips are opt-in
  mainnet-fork probes; count includes the payoutRecipient remediation's added
  coverage). Deep invariant profile (`FOUNDRY_PROFILE=invariant`, 512 runs x
  100 depth): `FixedPriceMinterInvariants` and `SurfaceInvariants` green, 0
  reverts across the mint/withdraw/config-mutation action set.
- At `main` post-#174 (2026-07-21, includes the #172/#174 delta above): full
  suite **476 passed, 0 failed, 2 skipped**; deep invariant profile green
  (18 tests, 0 failed); sizes Surface 13,781, PooledSurface 13,698,
  FixedPriceMinter 9,521, SurfaceFactory 5,310 bytes, all under the gate.
- Sizes under the 23,576-byte internal gate: Surface 13,091, PooledSurface
  13,065, FixedPriceMinter 9,122, SurfaceFactory 5,051 bytes.
- `slither` clean on the new minter/factory/token code (triaged; all real
  items are accepted pull-payment/factory patterns).
- `contracts/.gas-snapshot` regenerated at this baseline.

## Out of scope for this engagement

- The Homage launch project (`ripe0x/permanence`), which vendors this Surface
  copy and drives a pooled collection through its own `HomageMinter`. Its
  minter is a separate value-handling surface with its own review history; the
  vendored Surface copy tracks this baseline (permanence PR #13). Homage-side
  findings from the prior reviews (M-02, M-03, L-01..L-03) live in that repo.
- Deploy scripts and the offchain web/indexer, which carry no value.
