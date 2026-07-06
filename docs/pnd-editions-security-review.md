# PND Editions security review

> **SUPERSEDED (2026-07-06).** The Editions contract was reworked into the
> SovereignCollection system (OZ ERC721 core, four slots, id modes); see
> docs/pnd-collection-system.md and docs/pnd-collection-contracts-plan.md.
> This document describes the pre-rework ERC721A design; payment-split,
> hook, and graph concepts carry over, token-layer specifics do not.
> Contracts now live in contracts/src/collection/ (src/editions/ was
> removed).

> Independent adversarial review of the PND Editions protocol
> (`contracts/src/editions/`). Findings are prioritized; each carries a
> location, impact, a proof or precise reasoning, and a recommended fix. High
> findings have a failing-style Foundry PoC under
> `contracts/test/editions/PNDEditionsSecurity.t.sol` (every PoC is a green test
> that asserts the undesirable-but-true behavior, so a passing run reproduces
> the finding). The contract is the source of truth; `docs/pnd-editions-spec.md`
> is stale (see I3).

## How this was reviewed

- Read every editions contract, interface, and type, plus the four web surfaces
  that consume them (`apps/web/src/lib/pnd-editions.ts`,
  `apps/web/src/lib/editions-onchain.ts`,
  `apps/web/src/components/editions/MintEditionCTA.tsx`) and the deploy +
  indexing runbook (`docs/pnd-editions-integration.md`).
- Re-derived the storage model from the vendored deps: ERC721A-Upgradeable
  v4.x uses diamond storage (`keccak256('ERC721A.contracts.storage.ERC721A')`)
  and OpenZeppelin v5 uses ERC-7201 namespaced storage, so the contract's own
  state occupies sequential slots with no collision (relevant to upgrade safety,
  I1).
- Built and ran the suite: the original 46 tests pass, plus 12 new PoC /
  confirmation tests (58 total).
- Ran Slither 0.11.5. It reports no exploitable reentrancy on the ETH path
  (only `arbitrary-send-eth` on the intentional pull-payment `withdraw` and a
  `reentrancy-benign` on `_mintCore` that the `nonReentrant` guard covers). See
  the Tooling section.

## Findings at a glance

| ID | Severity | Title | PoC |
|----|----------|-------|-----|
| H1 | High | Edition owner can steal accrued pull-payment balances (incl. the host surface share) via upgrade | yes |
| H2 | High | `freezeMetadata()` advertises a permanence guarantee an unsealed owner can defeat by upgrading | yes |
| M1 | Medium | Any minter can self-deal the 10% surface share; the artist floor is 90%, not the advertised 100% | yes |
| M2 | Medium | `setMintHook` survives `seal()` and `freezeMetadata()`; mints can be blocked or re-conditioned on a "locked" edition | yes |
| M3 | Medium | `renounceOwnership()` silently burns future proceeds to `address(0)` and bricks all admin | yes |
| M4 | Medium | No per-wallet / per-tx cap; one tx buys out a capped edition | yes |
| M5 | Medium | Permissionless factory with caller-chosen `owner` enables indexer scan-ceiling griefing and artist impersonation | yes |
| L1 | Low | `config()` returns stale `renderer` / `mintHook` after `setRenderer` / `setMintHook` | yes |
| L2 | Low | `royaltyBps` capped at 100% rather than a sane maximum |  |
| L3 | Low | Default renderer escapes only `"` and `\`, not JSON control characters |  |
| L4 | Low | No `receive()` and no stray-ETH rescue; force-fed ETH is stuck |  |
| L5 | Low | Single-step `Ownable` (not `Ownable2Step`); a mis-set transfer permanently loses admin |  |
| I1 | Info | No storage gap and no automated upgrade-layout check; safety rests on manual discipline |  |
| I2 | Info | Impl init protection works despite ERC721A's separate init flag (verified, document it) | yes |
| I3 | Info | `docs/pnd-editions-spec.md` is stale vs the shipped API |  |
| I4 | Info | `uint32(indexInEdition)` truncates above ~4.29B tokens (infeasible) |  |
| I5 | Info | Confirm the indexer reads `renderer()` / `mintHook()`, not `config().cfg.*` |  |

No Critical issues were found. The money path itself (exact-value check, fixed
split, pull payments, CEI in `withdraw`, `nonReentrant`) is sound and value-
conserving; I verified the split by reasoning and re-ran the 256-run fuzz. The
highest-severity issues are privileged-actor and disclosure problems that the
always-upgradeable design makes reachable, plus one cross-party theft vector
that matters specifically for PND as the host that accrues the surface share.

## Resolution status (this branch)

All blockers and the cheap Lows are now addressed in the contracts; M1 and M5
are addressed by framing and indexer guidance (no core change) per the project's
decisions. The editions suite is 67 tests, all passing; the former PoCs are now
fix-regression tests in `contracts/test/editions/PNDEditionsSecurity.t.sol`.

| ID | Resolution |
|----|-----------|
| H1 | Settle-before-upgrade: `_totalPending` is tracked and `_authorizeUpgrade` requires it to be zero, so no upgrade can run while any payee is owed. Pull payments kept; `withdraw` is permissionless so anyone can flush every payee first. |
| H2 | `isPermanent()` (sealed && frozen) added; the edition page labels art "Permanent" only when both hold. Freezing alone no longer reads as permanence. |
| M1 | Framing only (open by design): copy says the artist keeps at least 90%, and 100% on a self-hosted surface. |
| M2 | `setMintHook` is gated by `!sealed`, so a sealed edition's mint terms are fixed. |
| M3 | `renounceOwnership()` reverts; `withdraw` rejects `address(0)`. Proceeds can never route to or be burned at the zero address. |
| M4 | `PNDPerWalletCapHook` (reference hook) provides per-wallet caps; the core stays minimal. |
| M5 | Indexer guidance updated (integration runbook Step 3): do not auto-promote the caller-settable `owner` into `known_artists`. Deploy-gated; no core change. |
| L2 | `royaltyBps` capped at `MAX_ROYALTY_BPS` (50%). |
| L3 | Renderer escapes control characters per RFC 8259. |
| L4 | `rescueStrayETH` sweeps only `balance - _totalPending` (owed funds untouchable). |
| L5 | `Ownable2StepUpgradeable` (two-step ownership transfer). |
| I1 | `__gap` plus an append-only discipline comment added. |
| L1 / I3 / I4 / I5 | L1 deferred; I3 spec refreshed; I4 noted (infeasible); I5 folded into the integration runbook. |

---

## High

### H1. An edition owner can steal accrued pull-payment balances, including the host surface share, by upgrading

**Location:** `contracts/src/editions/PNDEditions.sol:167` (`_settle` accrues to
`_pending`), `:182` (`withdraw` pays out later), `:317` (`_authorizeUpgrade` is
`onlyOwner && !sealed`). Root cause is the interaction of pull payments with the
always-upgradeable design.

**Description.** Mint proceeds do not leave the contract at mint time; they
accrue to `_pending[recipient]` and are claimed later via `withdraw`. The ETH
backing those balances sits in the edition contract, which is a UUPS proxy whose
owner (the artist) can upgrade to arbitrary code until they `seal()`. An owner
can therefore upgrade to an implementation that sweeps `address(this).balance`,
taking every un-withdrawn balance, including balances owed to parties other than
the owner.

The cross-party angle is what makes this more than a self-rug. When a mint
happens on PND, the minter passes PND's address as the `surface`, so 10% accrues
to `_pending[PND]` inside the artist's contract (`:171`). Until PND calls
`withdraw(PND)`, that ETH lives in an untrusted, owner-upgradeable contract. Any
edition owner can front-run PND's withdraw with an upgrade-and-sweep and steal
PND's accrued surface fees. The same applies to any `payoutAddress` that differs
from the owner (a collaborator, a split contract): the owner can sweep funds
owed to them.

**Impact.** Theft of third-party funds (the host's surface share, a co-payee's
share) held in the contract between accrual and withdrawal. For PND this means
its protocol revenue is only as safe as its withdrawal latency: every artist
edition is a contract that can take PND's accrued share at will.

**PoC.** `test_PoC_H1_pendingDrainedViaUpgradeAfterFreeze` mints crediting a
surface (0.1 ETH accrues to the surface, 0.9 ETH to the artist), the owner
upgrades to `DrainV2` and sweeps the full 1 ETH to a thief, and the surface's
later `withdraw` reverts because the ledger still owes 0.1 ETH but the contract
is empty.

**Recommended fix (long-term correct, pick one or combine):**
- **Push the surface share at mint time.** The surface set is small and host-
  controlled (PND treasury, the artist's own address), so the "reverting
  recipient bricks the mint" risk that motivated pull payments is low for the
  surface specifically. Pushing the 10% immediately removes the accrual window
  for the most-at-risk party while keeping pull payments for the artist's larger
  cut. If a push must tolerate a hostile surface, wrap it so a failed surface
  push falls back to accrual rather than reverting the mint.
- **Document and enforce immediate host withdrawal.** If the pull model is kept,
  PND must `withdraw(PND)` in the same flow as each mint (or very aggressively),
  and the protocol should treat any un-withdrawn host balance as at-risk. This
  is operationally fragile and should not be the primary defense.
- **Encourage `seal()` for finished drops** and surface "unsealed = the owner
  can still take in-contract funds and change everything" prominently wherever a
  host or co-payee relies on accruals (see H2 for the disclosure side).

The accepted "always upgradeable, owner = artist" decision is fine for the
artist's relationship with their own collectors. It is not fine as the custody
model for a different party's money. That is the gap to close.

### H2. `freezeMetadata()` advertises an art-permanence guarantee that an unsealed owner can defeat by upgrading

**Location:** `contracts/src/editions/PNDEditions.sol:247` (`freezeMetadata`),
`:204`/`:210` (the only paths it gates), `:317` (`_authorizeUpgrade`). README and
UI present `freezeMetadata` and `seal` as independent one-way guarantees.

**Description.** `freezeMetadata()` sets `_metadataFrozen`, which blocks only
`setRenderer` and `setTokenArtwork(Batch)`. It does not block upgrades. On an
unsealed edition the owner can upgrade to an implementation whose `tokenURI`,
`artwork()`, or renderer resolution returns anything, so "frozen" art is not
actually immutable. `isMetadataFrozen()` keeps returning `true` after such an
upgrade, so the onchain flag a marketplace or collector reads to mean
"permanent" is misleading.

The docs make this an explicit guarantee: the README says the owner can
"`freezeMetadata()` to renounce renderer/artwork changes (independent one-way
switches)", and the web `Edition` type carries `isMetadataFrozen` as a first-
class permanence signal. The guarantee only actually holds when the edition is
also sealed and the resolved renderer is either the immutable default or a
genuinely immutable custom renderer. A custom renderer that is itself mutable
also defeats the guarantee even when the renderer address is frozen.

**Impact.** Collectors and marketplaces can be misled into treating mutable art
as permanent. A collector who buys partly on the strength of a visible "metadata
frozen" badge can have the art changed afterward.

**PoC.** `test_PoC_H1_frozenArtRewrittenViaUpgrade` freezes metadata (the default
renderer returns a normal `data:application/json;base64,...` URI), then upgrades
to `ArtRugV2` whose `tokenURI` returns a sentinel string, proving the rendered
art changed after the freeze.

**Recommended fix:**
- Make the permanence guarantee real and legible. The cleanest is to treat true
  art permanence as `sealed && frozen` and only present a "permanent" claim in
  the UI when both hold (and, ideally, when the resolved renderer is the default
  or a known-immutable renderer). Alternatively, have `freezeMetadata()` require
  the edition to be sealed first, so the flag cannot exist in the misleading
  "frozen but upgradeable" state.
- If `freezeMetadata` is meant to be usable before sealing, rename / re-document
  it so it does not read as an immutability guarantee, and make the UI badge
  conditional on seal.
- For custom renderers, document that "frozen" only pins the renderer address,
  not its output, unless the renderer is itself immutable.

---

## Medium

### M1. Any minter can self-deal the 10% surface share; the artist's enforceable floor is 90%, not the advertised 100%

**Location:** `contracts/src/editions/PNDEditions.sol:122` (`mintWithRewards` is
permissionless), `:169` (`surfaceCut` is computed from the caller-supplied
`surface`).

**Description.** The split logic is correct and the surface is intentionally
open. But because `mintWithRewards` is callable directly by anyone with any
`surface`, a sophisticated minter can pass a second address they control and
divert 10% of the price to themselves, out of the artist's cut. The honest
`mint()` path (100% to the artist) is only honored by minters who choose to use
it; nothing enforces it. The artist's contract-enforced revenue floor on a
priced edition is therefore 90% of the sticker price, not the 100% the README
and mint UI present as the direct-mint outcome.

This matches the documented "open surface" intent at the implementation level,
so it is not a bug in the split. It is a gap between what the protocol guarantees
the artist (>= 90%) and what the artist-facing materials imply (100% on direct
mints). The task framed the question as "can a minter harm the artist beyond the
intended model": a minter cannot take more than 10% (confirmed below), but a
minter can unilaterally convert any mint into a 90/10 split keeping the 10%,
which is a real, repeatable revenue leak the artist cannot prevent onchain.

**Impact.** Up to 10% of every priced mint can be siphoned by the minter. Bounded
at 10% (no path diverts more), but available to anyone who reads the ABI.

**PoC.** `test_PoC_M1_minterSelfDealsTenPercent` shows a minter paying 1 ETH and
clawing back 0.1 ETH to their own address (artist nets 0.9 ETH).
`test_PoC_M1_noSurfaceCanEverExceedTenPercent` confirms the 10% bound and value
conservation.

**Recommended fix (the choice is the artist's; give them the lever):**
- The honest framing should be "the artist gets at least 90%; the remaining 10%
  goes to whoever hosts the mint, which can be the artist." Update the README
  and the mint UI so the 100% claim is scoped to "when minted through a surface
  that credits the artist."
- For artists who want a hard 100% floor, offer an opt-in: an artist-set flag
  that disables `mintWithRewards` (forcing `mint()` / surface 0), or a surface
  allowlist. A `surface != msg.sender` check is trivially bypassed with a second
  address and `tx.origin` checks are an anti-pattern, so a real fix is an
  allowlist or a toggle, not naive caller filtering.

### M2. `setMintHook` survives `seal()` and `freezeMetadata()`

**Location:** `contracts/src/editions/PNDEditions.sol:231` (`setMintHook` has no
`!_sealedMode` / `!_metadataFrozen` guard).

**Description.** `seal()` renounces upgrades and `freezeMetadata()` renounces art
changes, but neither gates `setMintHook`. On a sealed and frozen edition the
owner can still install a hook whose `beforeMint` reverts or returns the wrong
selector, blocking all future minting, or one that re-conditions mints (gating by
address, quantity, time) after collectors believed the terms were locked. The
hook cannot steal funds or re-enter (non-payable, `nonReentrant`, split computed
from `msg.value`), so the risk is censorship / changed terms, not theft.

**Impact.** "Sealed and frozen" does not mean "mint terms are fixed". An owner
retains a post-lock lever to halt or re-gate minting.

**PoC.** `test_PoC_M2_mintHookMutableAfterSealAndFreeze` seals and freezes, then
installs a rejecting hook and shows `mint(1)` reverts with `PND: hook rejected`.

**Recommended fix:** decide what "locked" should mean and make the code match.
Either gate `setMintHook` behind a dedicated one-way `freezeMint()` (or behind
`!_sealedMode`), or document explicitly that seal + freeze never covers mint
gating and the UI must not imply mint terms are immutable.

### M3. `renounceOwnership()` silently burns future proceeds and bricks all admin

**Location:** inherited `OwnableUpgradeable.renounceOwnership()` (not overridden);
interacts with `_settle` `:176` (`payoutAddress == 0 ? owner() : payoutAddress`)
and `withdraw` `:182` (no zero-address guard, flagged by Slither
`missing-zero-check`).

**Description.** `renounceOwnership()` is inherited, public, and one-click. An
artist who confuses it with `seal()` (both read as "give up control") can call
it, setting `owner() == address(0)`. With the default `payoutAddress` of 0, every
subsequent mint credits `_pending[address(0)]` (`:176`). `withdraw(address(0))`
is permissionless and the low-level call to `address(0)` succeeds, so the funds
are sent to the zero address and burned. Separately, all admin (`seal`,
`freezeMetadata`, `setPayoutAddress`, `setRenderer`, `setMintHook`, upgrades)
becomes permanently impossible because every gate is `onlyOwner` with owner 0.

**Impact.** Silent, irreversible loss of all future proceeds plus permanent loss
of all admin levers. Triggered by a standard, prominent function many will
assume is the "finalize" button.

**PoC.** `test_PoC_M3_renounceBurnsProceedsAndBricksAdmin` renounces, mints 1 ETH
that lands in `_pending[address(0)]`, burns it via `withdraw(address(0))`, and
shows `seal()` / `setPayoutAddress` now revert for the former owner.

**Recommended fix:** override `renounceOwnership()` to revert (editions are meant
to stay owned; `seal()` is the intended "renounce upgrades" path). Add a zero
check in `withdraw` to refuse `account == address(0)`. Consider M5's note that
`owner()` should never silently become the payout sink.

### M4. No per-wallet / per-tx mint cap

**Location:** `contracts/src/editions/PNDEditions.sol:135` (only the aggregate
`supplyCap` is enforced).

**Description.** The only quantity bound is the edition-wide `supplyCap`. A single
caller can mint the entire cap in one transaction. For a capped drop this lets a
bot or whale buy out the whole supply at once (and, combined with M1, claw back
10% of the entire edition). The artist still gets paid, so this is a distribution
/ fairness issue, not a fund loss, but it removes any chance of a broad
collector base for a capped release.

**Impact.** Capped editions can be monopolized by one address in one tx. No Sybil
resistance is built in; the only mitigation is a custom mint hook.

**PoC.** `test_PoC_M4_oneTxBuysOutCappedEditionAndSelfDeals` mints a 100-supply
capped edition in a single call, closing it, and routes 10% back to the buyer.

**Recommended fix:** add optional `maxPerWallet` / `maxPerTx` config fields (0 =
unlimited), enforced in `_mintCore` (per-wallet via ERC721A `_numberMinted`).
This is the standard primitive collectors expect for fair drops. If it is
deliberately left to the hook, document that clearly in the create flow so an
artist running a capped drop knows the core offers no fairness guarantee.

### M5. Permissionless factory with a caller-chosen `owner` enables indexer cost-griefing and artist impersonation

**Location:** `contracts/src/editions/PNDEditionsFactory.sol:40` (`createEdition`
is permissionless and takes `owner` as an explicit parameter, not bound to
`msg.sender`); `docs/pnd-editions-integration.md` Step 3 (the indexer UNIONs
`pnd_editions.owner` into `known_artists`).

**Description.** Anyone can deploy an edition and name any `owner`. Two abuses
follow:

1. **Indexer scan-ceiling griefing (cost).** The integration runbook promotes
   every `pnd_editions.owner` into `known_artists`, the worker's spend ceiling
   that AGENTS.md describes as deliberately limited to ~155 addresses. Because
   `owner` is attacker-chosen and the factory is permissionless, an attacker can
   spam `createEdition` with many distinct `owner` values (for example addresses
   with large transaction histories) and force the worker to scan all of them
   across every indexed platform. Given the project's standing rule that
   minimizing RPC spend is the top priority, this is a denial-of-wallet vector
   against PND's infrastructure.
2. **Impersonation / feed spam.** An edition can be deployed with
   `owner = a real artist's address` and an official-looking name. The indexer
   and UI attribute editions to `owner`, so junk editions can appear under a real
   artist's identity (and crowd the factory's "recent editions" page). The
   attacker does not control the fake edition's owner functions, so this is
   confusion / phishing, not direct theft.

**Impact.** (1) is the more serious for PND: unbounded, attacker-controlled
expansion of the chain-scanning set, directly translating to RPC cost. (2) is
reputational / phishing. Both are deploy-gated today because discovery is not yet
wired, so they are fix-before-wiring, not live.

**PoC.** `test_PoC_M5_anyoneDeploysEditionOwnedByAVictim` deploys, from an
attacker, an edition owned by a victim address and confirms `isEdition == true`
and `owner() == victim` (the exact `(contract, owner)` pair the indexer ingests).

**Recommended fix (at the indexer layer, since the contract's explicit-`owner`
deploy helper is intended):**
- Do not auto-promote `pnd_editions.owner` into `known_artists`. Promote only on
  a verified signal: `owner == tx.origin` of the deploy, or an explicit onchain
  claim by the owner, or a manual allowlist. Indexing the edition row is fine;
  expanding the chain-scan ceiling from an unauthenticated, attacker-set field is
  not.
- In the UI, treat `owner` as unverified provenance: do not present a factory
  edition as "by <artist>" without a separate verification (ENS, a signed claim,
  or a PND-side allowlist).
- Optionally bound the factory deploy (a small fee, or `owner == msg.sender`
  unless a trusted deployer is calling) if onchain spam itself becomes a
  problem; the indexer fix is the higher-leverage one.

---

## Low

### L1. `config()` returns stale `renderer` / `mintHook`

**Location:** `contracts/src/editions/PNDEditions.sol:365` (`config` returns
`_cfg`), versus `setRenderer` `:206` (writes `_renderer`, not `_cfg.renderer`)
and `setMintHook` `:232` (writes `_mintHook`, not `_cfg.mintHook`).

**Description.** `setRenderer` and `setMintHook` update the dedicated `_renderer`
/ `_mintHook` slots, but `_cfg.renderer` / `_cfg.mintHook` keep their deploy-time
values. `config()` returns `_cfg`, so `config().cfg.renderer` and
`config().cfg.mintHook` are stale after either setter. The live values are only
available via `renderer()` and `mintHook()`. The web `Edition.cfg` inherits the
staleness (`editions-onchain.ts` decodes `config()` into `cfg`), so any consumer
reading `cfg.renderer` / `cfg.mintHook` sees the wrong address.

**Impact.** Integrators and the indexer that read `config().cfg.renderer` /
`.mintHook` get incorrect data. No fund impact; behavior uses the correct slots.

**PoC.** `test_PoC_L1_configReturnsStaleRendererAndHook`.

**Recommended fix:** keep `_cfg.renderer` / `_cfg.mintHook` in sync inside the
setters, or drop those two fields from the `config()` return and direct all
consumers to `renderer()` / `mintHook()` (see I5).

### L2. `royaltyBps` capped at 100% rather than a sane maximum

**Location:** `contracts/src/editions/PNDEditions.sol:89`
(`require(cfg.royaltyBps <= BPS)`), `:414` (`royaltyInfo`).

**Description.** Royalty can be set to the full 10000 bps (100% of sale price).
EIP-2981 is advisory so marketplaces may ignore it, but a 100% royalty is a clear
footgun, and because the factory takes `owner` and `royaltyReceiver` explicitly,
a deployer could set 100% to a third-party receiver on an edition nominally owned
by someone else.

**Recommended fix:** cap at a sane maximum (for example 1000-5000 bps) in
`initialize`.

### L3. Default renderer escapes only `"` and `\`, not JSON control characters

**Location:** `contracts/src/editions/PNDDefaultRenderer.sol:97` (`_escape`
handles only `"` and `\`).

**Description.** `_escape` prevents structural JSON injection (a `"` cannot break
out of a string), which is the important case, and all injectable fields (`name`,
`artwork`, per-token CID) are owner-set, so there is no third-party injection.
But RFC 8259 requires control characters U+0000-U+001F to be escaped. An owner-
set name or artwork URI containing a raw newline or other control byte produces
JSON that strict parsers reject, breaking `tokenURI` for that edition on some
marketplaces.

**Recommended fix:** escape control characters (`\n`, `\r`, `\t`, and `\u00XX`
for the rest) in `_escape`, per RFC 8259. Low priority because it is owner-
inflicted and non-structural, but cheap to make robust.

### L4. No `receive()` and no stray-ETH rescue

**Location:** `contracts/src/editions/PNDEditions.sol` (no `receive` / `fallback`,
no sweep).

**Description.** Plain ETH transfers revert (good), but `selfdestruct` and block-
reward force-feeds can still push ETH in. There is no rescue path, so force-fed
ETH is stuck forever. Accounting is unaffected: `withdraw` pays exactly
`_pending[account]`, and the sum of `_pending` never exceeds funds received
through mints, so the contract is always solvent and force-fed ETH only sits idle
(no insolvency, no theft).

**Recommended fix:** optional. An owner-only `rescueETH(to)` that sweeps only
`address(this).balance - totalPending` would recover stray ETH without touching
owed balances; this requires tracking `totalPending`. Given the small amounts
typically involved, documenting the behavior is also acceptable.

### L5. Single-step `Ownable` rather than `Ownable2Step`

**Location:** `OwnableUpgradeable` (`__Ownable_init` at
`PNDEditions.sol:92`); `transferOwnership` is single-step.

**Description.** Ownership transfer is single-step, so a transfer to a mistyped or
uncontrollable address immediately and permanently loses all admin (upgrade,
seal, freeze, config). Mints continue and proceeds still route to the separate
`payoutAddress`, so funds are not directly lost, but the edition becomes
unmanageable. For a contract whose owner holds upgrade power, two-step transfer
is the safer default.

**Recommended fix:** use `Ownable2StepUpgradeable` so the new owner must accept.
Pair with the M3 fix (block `renounceOwnership`).

---

## Informational

### I1. No storage gap and no automated upgrade-layout check

The contract's own state variables occupy sequential slots starting at 0, which
is safe today only because every base (ERC721A-Upgradeable diamond storage,
OpenZeppelin v5 ERC-7201 namespaced storage) keeps its state out of those slots.
Verified for the vendored versions. There is no `__gap` and no CI check, so
upgrade safety rests entirely on manual append-only discipline: a future edit
that inserts or reorders a variable would corrupt state with no guardrail.
Recommend wiring a storage-layout diff (for example `forge inspect
PNDEditions storage-layout` compared across versions, or the OpenZeppelin
Upgrades plugin) into CI before the first upgrade ships, and documenting the
append-only rule next to the state declarations.

### I2. Implementation init protection works despite ERC721A's separate init flag (verified)

`_disableInitializers()` in the constructor (`PNDEditions.sol:76`) sets
OpenZeppelin's `_initialized` to `type(uint64).max` but does not touch
ERC721A-Upgradeable's independent init flag. The classic UUPS implementation-
takeover (initialize the impl directly, become owner, upgrade to a self-
destructing impl) is still blocked, because `initialize` carries both
`initializerERC721A` and OpenZeppelin's `initializer`: the ERC721A modifier runs
first and would pass, but OpenZeppelin's `initializer` then reverts with
`InvalidInitialization()`, rolling the whole call back. Confirmed by
`test_confirm_implCannotBeInitialized`. Documented here so the dual-modifier
arrangement is not "simplified" later into something unsafe.

### I3. The interface spec is stale

`docs/pnd-editions-spec.md` still shows a single
`mint(quantity, surface, hookData)` entrypoint, no `withdraw` / pull payments, no
`setPayoutAddress`, and no `freezeMetadata`, and is missing the `Withdrawn`,
`PayoutAddressSet`, and `MetadataFrozen` events. The shipped contract splits mint
into `mint(quantity)` + `mintWithRewards(quantity, surface, hookData)`, accrues
to `_pending`, and adds the pull-payment, payout, and freeze surfaces. Update the
spec to match the contract, or add a banner pointing at the contract as the
source of truth.

### I4. `uint32(indexInEdition)` truncates above ~4.29B tokens

`mintMarkOf` casts `tokenId - start` to `uint32` (`PNDEditions.sol:329`). An open
edition minting more than 2^32 tokens would wrap the mint index. Infeasible in
practice (gas), noted for completeness. `mintBlock` as `uint48` is fine for the
foreseeable future.

### I5. Confirm the indexer reads `renderer()` / `mintHook()`, not `config().cfg.*`

Following from L1: when discovery is wired (integration runbook Step 3-5), the
worker enrichment should read the live `renderer()` / `mintHook()` getters, not
`config().cfg.renderer` / `.mintHook`, to avoid persisting stale values. Events
otherwise look complete for discovery: `EditionCreated` (factory),
`EditionConfigured`, `Minted` (carries `firstTokenId` + `quantity`; `firstTokenId`
is not indexed, which is fine since it is decoded from data), `RendererSet`,
`MintHookSet`, `TokenArtworkSet`, `PayoutAddressSet`, `Sealed`, `MetadataFrozen`,
`Withdrawn`, `SurfacePaid`, `EdgeAdded`, `PathSet`, `DefaultPathSet`.

---

## Tooling

**Slither 0.11.5** (`slither src/editions/PNDEditions.sol`): 73 results across 26
contracts, almost all in dependencies or informational. The relevant, in-scope
signals and their dispositions:

- `arbitrary-send-eth` on `withdraw` (`:186`): expected. This is the pull-payment
  pattern; ETH only ever goes to the address the ledger owes (`account`), and the
  amount is exactly `_pending[account]`. Not a vulnerability. (See M3 for the one
  edge: `account == address(0)` should be rejected.)
- `reentrancy-benign` on `_mintCore` (`:131`): the hook's `beforeMint` external
  call precedes the `_mint` / `_settle` state writes, so strict CEI is not
  followed, but the function is `nonReentrant` and the hook is owner-set and non-
  payable, so re-entry is blocked and the hook cannot skim. Confirmed safe;
  `test_confirm_withdrawReentrancyBlocked` shows the guard holds on the withdraw
  path too. No `reentrancy-eth` was reported.
- `missing-zero-check` on `withdraw.account`: folded into M3.
  `missing-zero-check` on `setRenderer` / `setMintHook`: intentional (0 = default
  renderer / no hook).
- `timestamp` on the mint-window comparisons: acceptable; miner timestamp
  influence (~seconds) does not matter for mint windows.
- `shadowing-local` (`IPNDEditions.setRenderer(address).renderer` shadows the
  `renderer()` getter name) and `pragma` (mixed `^0.8.x` across deps): cosmetic.

Aderyn was not available in the environment.

## Test status

- Original suite: 46 tests pass (`forge test --match-path "test/editions/*"`).
- Added `contracts/test/editions/PNDEditionsSecurity.t.sol`: 12 tests (8 PoCs +
  4 confirmations, including a 256-run provenance fuzz), all green.
- Total: 58 pass, 0 fail. Reproduce with:
  ```
  cd contracts && forge test --match-path "test/editions/*" -vv
  ```

---

## Mainnet-readiness verdict

**Not ready to deploy as-is, but close.** The core money path is sound: exact-
value enforcement, a fixed and value-conserving split, pull payments with proper
CEI and a shared `nonReentrant` guard, and a correctly-protected UUPS
implementation. I found no Critical issue and no way for an unprivileged third
party to drain funds or brick minting.

What blocks a clean deploy is a cluster of privileged-actor and disclosure
problems that the always-upgradeable design makes reachable, plus one genuine
cross-party theft vector (H1) that matters specifically because PND is the host
that accrues the surface share into contracts other people control. None of these
require re-architecting the protocol; they require closing custody and disclosure
gaps and adding a couple of standard guards.

### Must-fix before mainnet

1. **H1 (surface-share custody).** Do not leave PND's (or any non-owner payee's)
   accrued share sitting in an owner-upgradeable contract. Push the surface share
   at mint, or enforce immediate host withdrawal, and treat un-withdrawn host
   balances as at-risk until then. This is the one finding with direct third-
   party fund-loss potential.
2. **H2 (false permanence).** Make the "frozen" guarantee honest: gate the
   permanence claim (and ideally the onchain flag) on `sealed && frozen`, and do
   not let the UI show "metadata frozen" as permanence on an unsealed, still-
   upgradeable edition.
3. **M3 (renounce footgun).** Override `renounceOwnership()` to revert and add a
   zero-address guard to `withdraw`. One-click, silent, irreversible loss of
   funds and admin is not acceptable on a contract artists will operate
   themselves.
4. **M5 (indexer promotion).** Before wiring discovery, do not auto-promote the
   attacker-controllable `owner` field into `known_artists`. Gate scan-ceiling
   expansion on a verified signal. (Deploy-gated, so it blocks the discovery
   step, not the contract deploy, but it must be settled before Step 3 ships.)

### Strongly recommended before mainnet

5. **M1 (honest pricing copy + opt-out).** Correct the "100% to the artist"
   framing to "at least 90%", and give artists who want a hard floor an opt-in to
   disable `mintWithRewards`.
6. **M2 (post-seal hook).** Decide what "locked" means and make `setMintHook`
   match it (gate behind seal or a dedicated freeze, or document the carve-out).
7. **M4 (per-wallet / per-tx cap).** Add optional caps for fair capped drops, or
   document that the core offers no fairness guarantee and the hook is the
   mechanism.
8. **L5 / I1.** Move to `Ownable2Step` and add a storage-layout CI check before
   the first upgrade.

### Fine to defer

L1, L2, L3, L4, I3, I4, I5 are quality and robustness items that do not block a
deploy but should be tracked. L1 / I5 should be resolved before the indexer
persists `config().cfg.*` anywhere.
