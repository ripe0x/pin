# Releases v1 — decisions made on Dave's behalf

> Dave approved the plan ([releases-v1-plan.md](./releases-v1-plan.md)) and
> told me to implement using my recommendations for the open questions,
> noting them here for his later review. **Everything below is reversible
> for free until the factory is on mainnet.** Review this doc before the
> deploy step.

## The four open questions (plan §13)

### 1. Fee constants

- Initial surface fee: **0.0005 ETH** per token minted (middle of the
  brief's 0.0003–0.0008 band).
- Hard cap (immutable, forever): **0.002 ETH**.
- Both are env-overridable at deploy time (`SURFACE_FEE_WEI`,
  `MAX_SURFACE_FEE_WEI` in `script/DeployReleases.s.sol`) — changing the
  numbers requires editing nothing.

### 2. Factory owner

**The deployer EOA at deploy time**, overridable via
`RELEASES_FACTORY_OWNER`. The factory is `Ownable2Step`, so handing over
to a treasury/multisig later is a safe two-step transfer whenever one
exists. Rationale: the owner's only lever is `setSurfaceFee` under the
bytecode cap (worst case ≈ $7/mint at today's prices) — not worth
blocking deploy on multisig ceremony, and 2Step means the upgrade-of-
custody path stays open. **Recommended follow-up: move ownership to a
PND treasury address once one is settled.**

### 3. Old editions system (`contracts/src/editions/`, `/editions` routes)

**Left untouched on this branch.** Recommendation stands: remove it in a
dedicated PR *before* the Releases mainnet deploy, so there's never a
moment with two create flows in the UI. Not done here because (a) it
would bury this branch's reviewable diff in deletions, and (b) removal
is Dave's explicit call to make, being destructive to merged work. The
old system was never deployed to mainnet, so removal has no onchain
consequences.

### 4. Naming

**Releases** / `Release` / `ReleaseFactory` / `/releases` routes /
`pnd_release_*` indexer tables. Matches the brief's central noun and the
unbranded `SovereignAuctionHouse` style for artist-owned contracts.
Renames are free until deploy; after that the contract names are in
bytecode metadata forever.

## Implementation deltas from the plan

Calls made during the build, consistent with the plan's principles but
not spelled out in it:

1. **`ReleaseCreated` carries the full `ReleaseParams` struct** (plan §8
   had the constructor emitting initial `PayoutSet`/`MetadataSet`/
   `RoyaltySet` instead). One fat event means the indexer builds a
   complete release row from the factory log alone and never depends on
   Ponder's same-block child-contract log ordering. Setters still emit
   delta events; constructors emit nothing.
2. **A free release zeroes its `surfaceFee` immutable at construction.**
   "Free means free" is enforced twice: the immutable is 0 *and* the fee
   formula short-circuits on `price == 0`. A free release cannot owe a
   fee even in some future refactor of the formula.
3. **`withdraw()` and `claimSurfaceFees()` are permissionless triggers.**
   Funds can only ever land at `payout` / the surface itself, so gating
   the caller adds nothing; permissionless lets PND (or anyone) flush
   balances for artists and surfaces.
4. **Zero-balance withdraw/claim reverts** ("nothing to withdraw"/"nothing
   owed") rather than silently no-oping — explicit feedback over empty
   events.
5. **Royalty receiver defaults to `payout`** (which itself defaults to the
   artist) when `royaltyBps > 0` and no receiver is given.
6. **Gate claims require ownership, not approval** (`ownerOf == caller`),
   and duplicate source ids in one call revert (HOLD via the used-mark,
   BURN via the second burn failing). Approval moves tokens; it doesn't
   spend their rights.
7. **Verified onchain: Foundation's shared contract cannot be a BURN
   gate** — its `burn` reverts "Caller is not creator" (creator-only, not
   owner-or-approved). It works as a HOLD gate, which is exactly why HOLD
   exists for arbitrary foreign 721s. BURN gates need the de-facto
   owner-or-approved `burn(uint256)`: OZ ERC721Burnable, ERC721A-style
   burns, Manifold creator contracts, and every Release qualify.
8. **ERC721A v4.3.0 vendored** at `contracts/lib/ERC721A` (remapping
   `erc721a/`). `lib/` is gitignored per repo convention — reconstitute
   with: copy OZ + forge-std from a sibling worktree, then
   `git clone --depth 1 --branch v4.3.0
   https://github.com/chiru-labs/ERC721A contracts/lib/ERC721A` (and
   delete its `.git`).
9. **Measured actuals** (optimizer 200): `Release` runtime 13,647 B,
   `ReleaseFactory` runtime 18,812 B — 5.7KB of EIP-170 headroom, with a
   suite test alarming at 23,000 B. `createRelease` ≈ 3.07M gas; `mint`
   ≈ 69k execution gas (≈ 90k with base tx cost). The plan's full-deploy
   bet holds without trimming.

## Verification status (contracts phase)

- 90 unit/fuzz/invariant/reentrancy tests pass; fuzz suites re-run at
  2,000 runs; invariant suite ghost-checks every wei
  (`balance == artistBalance + Σ owed`, artist leg exact, surface leg
  exact, cap never exceeded).
- Mainnet fork suite passes against publicnode: HOLD gate on BAYC with
  the impersonated real holder, cross-release BURN, deploy-script dry
  run, end-to-end economics (PND-served + direct mints, both legs
  drained exactly).
