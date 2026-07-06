# PND Collection System: contracts implementation plan

> **Scope: contracts only.** Studio flow, mint surface, capture worker,
> and all other UI/offchain work is explicitly deferred. Companion to
> `docs/pnd-collection-system.md` (the design overview); this document
> is the build plan for section 3 of that doc, with comprehensive
> testing as a first-class deliverable, not a trailing phase.
>
> Naming follows the overview: **SovereignCollection** /
> **SovereignCollectionFactory**, consistent with the existing
> `SovereignAuctionHouse` family in `contracts/src/`.

## Ground rules

- **Directory**: new code in `contracts/src/collection/` (+
  `interfaces/`, `renderers/`, `hooks/`, `minters/` subdirs).
  `contracts/src/editions/` stays untouched until Phase 4, then gets
  supersession banners and removal in the same PR that lands the
  replacement.
- **Toolchain**: solc 0.8.24, Foundry, run from `contracts/` (that is
  where `foundry.toml` lives). `lib/` is gitignored; reconstitute from
  a sibling worktree (OZ 5.1.0). Add solady (LibString, Base64) and
  vendored scripty v2 interfaces. The `erc721a-upgradeable` remapping
  is removed at the end of Phase 1 when nothing imports it.
- **Fork tests**: pinned block via a `FORK_BLOCK` env var (default:
  fork at HEAD) so Foundry's per-block RPC cache compounds across
  runs. Free public RPCs inline in docs and comments, Tenderly public
  gateway for archive reads.
- **Branching**: implementation starts from a fresh branch off updated
  `main` (repo squash-merges; do not build on this design branch).
- **Salvage, not greenfield**: `PNDEditions.sol` and its 7-file test
  suite are the starting material. Every phase below names what
  carries over.

## Phase 0: lock the open decisions (1 to 2 days)

Written up as short decision notes appended to the overview doc before
any code. All three are one-way once deployed.

1. **Immutable clones vs UUPS-until-seal.** Recommendation: immutable
   EIP-1167 clones. The four slots and companions now carry all
   variability; immutability deletes the proxy/upgrade/seal surface
   from the audit and is the stronger trust story. Consequence:
   `PNDEditionsUpgrade.t.sol` is retired rather than ported, and core
   evolution happens by factory-offered versions.
2. **FixedPrice: built-in field vs strategy contract.** Recommendation:
   a stored `price` on the collection used when the strategy slot is
   unset; a set strategy overrides it. Simple collections deploy
   nothing extra; TBAM-shaped pricing plugs in later.
3. **Hook coverage.** Decided in design review, encoded here: hooks run
   on **all** mint paths, built-in and extension `mintTo`, so gating
   composes with custom minters instead of being reimplemented inside
   them.
4. **Interface names**: `ISovereignCollection` (view surface:
   `tokenSeed`, `mintMarkOf`, `workConfig`, `artistOf`, sale state),
   `IRenderer` (`tokenURI(address collection, uint256 tokenId)`),
   `IPriceStrategy` (`priceOf(collection, minter, qty, data)` view),
   `IMintHook` (`beforeMint`/`afterMint`, non-payable, magic-value
   gated, carried from the editions spec).

## Phase 1: core + factory + hooks (the rework, ~2 weeks)

### Contracts

- `SovereignCollection.sol`: OZ ERC721 core.
  - Carries over from `PNDEditions.sol`: payment split math and the
    surface-share flow, sale states, graph refs (`Ref`, Edition Graph,
    Token Path), hook invocation points, per-token artwork override.
  - Deleted: everything ERC721A (packed ownership assumptions,
    `MintBatch`, batch heads, `indexInEdition` derivation, per-batch
    entropy), UUPS machinery (per Phase 0).
  - New: per-token Mint Mark in one packed slot (`mintBlock` uint48,
    `surface` address, `status` uint8); per-token entropy
    (`keccak(prevrandao, address(this), tokenId, minter)`) exposed as
    `tokenSeed`; work config struct set at init and lockable (script
    refs, dep refs, render spec, liveness tier); id mode flag at init
    (sequential | pooled); role-gated `mintTo(recipient, tokenId)` for
    authorized extension minters (pooled mode requires minter-supplied
    ids, sequential mode forbids them); approval-gated `burn`; minter
    authorization (grant/revoke by owner, evented); renderer slot
    switched to the explicit-param `IRenderer`.
- `SovereignCollectionFactory.sol`: EIP-1167 clone + init in one tx
  (id mode, work config, price, payout, renderer, hook, minter grants,
  optional Attribution roster write, single discovery event).
- `CollectionTypes.sol`: port of `PNDEditionsTypes.sol` minus batch
  types.
- `hooks/`: port `HookBase`, `AllowlistHook`, `HoldsCollectionHook`
  (rename of `PNDHoldsEditionHook`), `PerWalletCapHook`. These are
  near-mechanical ports; the interface is unchanged.

### Tests (unit + fuzz, ported and new)

Port the editions suite as the baseline, then extend. Target suites:

- `Collection.t.sol` (port of `PNDEditions.t.sol`): mint lifecycle,
  sale states, payment split correctness on the built-in path, payout
  routing, per-token artwork override, graph refs.
- `CollectionHooks.t.sol` (port): all three stock hooks on the
  built-in path, plus new coverage proving hooks fire on the `mintTo`
  path (Phase 0 decision 3).
- `CollectionSecurity.t.sol` (port + extend): reentrancy via malicious
  hook, malicious receiver (`RevertingReceiver` and
  `NonReceivingBidder` mocks already exist in `contracts/test/`),
  malicious price strategy (absurd or zero price, reverting strategy),
  malicious minter (unauthorized `mintTo`, wrong id mode), access
  control matrix for every owner/minter/approval-gated function.
- `CollectionIdModes.t.sol` (new): sequential mode rejects supplied
  ids; pooled mode requires them; **burn then re-mint of the same id
  succeeds in pooled mode** with fresh mark, fresh entropy; sequential
  ids never recycle; supply accounting across mint/burn/re-mint.
- `CollectionEntropy.t.sol` (new, fuzz): seed nonzero and stored,
  distinct across tokens in one tx and across txs, stable after
  transfer, re-roll on pooled re-mint.
- Fuzz targets: split math over price and quantity ranges (no wei lost,
  artist + surface always sum to msg.value), work-config lock
  semantics, minter grant/revoke sequences.
- `CollectionContinuity.t.sol` (port): the editions-behavior
  continuity suite, proving the editions preset (sequential + stored
  price + static renderer) behaves identically to `PNDEditions` from a
  collector's perspective.

**Exit criteria**: full suite green; the editions preset passes the
ported continuity and split tests; `forge snapshot` baseline recorded
for mint paths.

## Phase 2: renderers + Attribution (~1 week)

### Contracts

- `renderers/DefaultRenderer.sol`: port of `PNDDefaultRenderer.sol`
  (155 lines) to the explicit-param interface. Static artwork + Mint
  Mark provenance attributes. This is the editions-preset renderer.
- `renderers/SVGRenderer.sol` (abstract): JSON envelope, base64,
  attributes; concrete renderers implement
  `svg(tokenId, seed, state)`. Plus a `TestSVGRenderer` fixture.
- `renderers/GenerativeRenderer.sol` (singleton): reads work config +
  `tokenSeed` from the collection, assembles the HTML data URI via
  ScriptyBuilderV2 (gzipped deps from EthFS + injected context +
  artist script), wraps in tokenURI JSON with `animation_url`.
- `Attribution.sol` (singleton, Catalog idiom): `setArtists(collection,
  address[])` writable by the collection's owner or the collection
  itself, lockable, evented, slice getters. Deployed via the same
  deterministic CREATE2 discipline documented in `Catalog.sol`.
- `docs/injection-convention.md`: the context object shape
  (`tokenId`, `seed`, declared live values), determinism rules for
  `pure` works, the provider-bridge convention for chain-live HTML.
  Written in this phase because renderer tests assert against it.

### Tests

- `GenerativeRendererFork.t.sol`: mainnet fork at pinned `FORK_BLOCK`
  against the real deployed scripty v2 + EthFS. Assemble a real p5
  sketch: assert tokenURI is valid JSON, base64 decodes, HTML contains
  the injection payload with the correct seed, dependency tags
  present. Decode via `vm.ffi` to node where string asserts are not
  enough.
- `SVGRenderer.t.sol`: envelope validity, attribute assembly, a
  chain-live fixture (renderer reads a mock companion and the owner).
- `DefaultRenderer.t.sol`: parity against `PNDDefaultRenderer` output
  for identical state (continuity of the editions preset).
- `Attribution.t.sol`: authority (owner, collection self, not
  strangers), lock semantics, roster mutation, event shape, and an
  integration case: factory-deployed collection writes its roster at
  init; a second wallet's Catalog claim completes the handshake
  (assert the confirmed-attribution intersection reads true onchain).

**Exit criteria**: fork suite green against pinned block with the
cache warm; injection convention doc merged; renderer outputs
validated end to end.

## Phase 3: system-level verification (~1 week)

No new product code. This phase exists to prove the design claims made
in the overview doc, as tests.

- **Invariant suites** (`Invariants.t.sol`):
  - supply: minted minus burned equals totalSupply, across random
    mint/burn/re-mint sequences in both id modes
  - funds: contract ETH balance is zero after every settled operation
    on the built-in path; sum of payouts equals sum of payments
  - ids: no duplicate live ids ever, pooled or sequential
  - roles: `mintTo` never succeeds from an unauthorized address across
    randomized grant/revoke sequences
- **Reference-work fixtures** (the design-claim tests):
  - `MiniTBAM.t.sol`: a `FrameLock` companion (lock a recent
    blockhash, age-weighted `effectiveLocks`), a dynamic
    `IPriceStrategy` reading basefee and the companion, a chain-live
    renderer serving frozen vs live frames. Proves: companions need no
    core support, the price slot expresses TBAM's curve, no hooks
    required, per-block liveness works through an onchain view.
  - `PooledBacked.t.sol`: a mock backed minter (mock ERC20, direct
    deposit escrow, no DEX) on a pooled-mode collection driving the
    full Homage-shape cycle: draw id, mint with escrow, redeem, burn,
    id returns, re-mint same id with fresh escrow and seed. Proves the
    v1 core supports the fast-follow form before the real BackedMinter
    exists.
- **Security pass**: slither run (clean or findings triaged in the
  PR), access-control matrix reviewed against the interfaces doc,
  griefing review (hook that always reverts, strategy that reverts,
  renderer that reverts must never block transfers or burns).
- **Gas**: `forge snapshot` diffed against the Phase 1 baseline and
  against the old `PNDEditions` mint for the editions preset; document
  the delta in the PR.

**Exit criteria**: invariants run at meaningful depth (documented
runs/depth in the profile comment per repo convention), both
reference fixtures green, slither triaged, gas documented.

## Phase 4: deploy readiness (~2 to 3 days, execution gated)

- `script/DeployCollectionSystem.s.sol`: Attribution via the canonical
  CREATE2 proxy with pinned toolchain (same discipline as `Catalog.sol`
  documents; it has no constructor args, so the deterministic address
  holds cross-chain). The renderers deploy via plain CREATE: constructor
  args (GenerativeRenderer) and no cross-chain-parity requirement make
  CREATE2 ceremony there cost without benefit. Then implementation +
  factory.
- Etherscan verification wired through the existing `foundry.toml`
  config.
- Docs landing in the same PR: supersession banners on
  `docs/pnd-editions-*.md`, `contracts/src/editions/` removed, spec
  doc revised to the as-built interfaces, AGENTS.md pointer updated.
- **Not in scope here**: the mainnet broadcast itself (per-transaction
  confirm protocol, separately) and external review scheduling. The
  overview doc marks BackedMinter as where external review money goes;
  the core rework should get at least a second-pair-of-eyes pass
  before mainnet regardless.

## Phase 5: fast-follow minters (demand-gated, ~2 weeks when triggered)

Explicitly out of the v1 critical path; gated on Homage proving the
backed form. Scoped now so the v1 tests above (PooledBacked fixture)
already guarantee the core supports it.

- `minters/BackedMinter.sol` + escrow vault: ETH via configured swap
  route or direct coin deposit, per-token escrow, redeem = burn +
  principal minus exit fee. Launch guardrails per the overview
  (vetted-coin list or liquidity checks).
- `minters/PooledIdMinter.sol`: id pool, Fisher-Yates draw, redeem
  returns id.
- `ISourceReader` + adapters (CryptoPunks, vanilla ERC721).
- Tests: unit + fuzz on pool math (no duplicate draws, exhaustion,
  return-then-redraw), vault accounting invariants (escrow in equals
  escrow out plus fees, per token and in aggregate), fee-on-transfer
  and rebasing-coin rejection tests, and a mainnet-fork swap test
  against a real pool at pinned block. This is the audit-focus
  deliverable.

## Summary

| Phase | Deliverable | Time |
|---|---|---|
| 0 | Decisions locked, written into the overview | 1 to 2 days |
| 1 | Core + factory + hooks, ported and new unit/fuzz suites | ~2 weeks |
| 2 | Three renderers + Attribution + injection spec, fork tests | ~1 week |
| 3 | Invariants + MiniTBAM + PooledBacked fixtures, security, gas | ~1 week |
| 4 | Deploy scripts, verification, doc migration | 2 to 3 days |
| 5 | BackedMinter + PooledIdMinter + adapters (gated) | ~2 weeks |

Roughly **4.5 to 5 weeks** of focused contract work to
deploy-readiness for v1, with the fast-follow adding about two more
when demand triggers it.
