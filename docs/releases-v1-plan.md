# PND Releases — v1 protocol plan

> Status: **plan for review, nothing implemented.** This is a fresh-start
> design for PND's open-edition release protocol, built from the product
> brief — deliberately not inherited from `contracts/src/editions/`
> (PND Editions, merged in #103, never deployed to mainnet). Where the two
> happen to agree, that's disclosed at the bottom with the independent
> reasoning. Naming ("Releases", `Release`, `ReleaseFactory`) is a working
> choice flagged for sign-off.

The protocol in three sentences, which every implementation detail must
survive contact with:

1. **Free means gas only.**
2. **The artist gets everything they priced.**
3. **The surface earns only when chosen.**

---

## 1. Architecture

### One contract per release

A *release* is one ERC721 contract: its own name and symbol, its own
window, its own price, its own token ids starting at 1. Not a struct in a
shared singleton, not a row in PND's contract, and not "all of an artist's
releases in one contract."

Why per-release rather than per-artist-multi-release:

- **Vanilla-721 composability is the continuation mechanic.** Gates (§4)
  reference an arbitrary ERC721 address and use only `ownerOf` /
  `balanceOf` / `burn`. If one contract hosted many releases, "hold a
  token from release A" would need a custom interface to scope a balance
  to a release — and every *other* protocol that wants to gate on a PND
  release would need that interface too. Per-release contracts keep PND
  releases gateable by anything that speaks plain 721, including things
  that don't exist yet.
- **Marketplace identity.** Wallets and marketplaces treat contract =
  collection. Each release reads as its own work everywhere, with its own
  ERC-2981 config and its own contractURI, with zero special-casing.
- **It matches the culture being built for.** Checks, Opepen — each drop
  was its own contract, and the contract address became part of the
  work's identity.

### Factory deploys full contracts, not clones

`ReleaseFactory.createRelease(params)` does `new Release{...}(...)` — the
artist's release is a complete, self-contained contract with its own full
bytecode, owned by the artist from construction. No proxy, no
implementation pointer, no initializer, no upgrade path for anyone.

This is a deliberate departure from the auction house factory (EIP-1167
clones), argued on this product's shape:

- **Editions are mint-heavy; clone economics invert.** A clone saves the
  artist ~90% at deploy but charges every mint a delegatecall plus
  storage-reads-instead-of-immutables (~5–10k gas per mint). An auction
  house is deployed once and bid on occasionally; a release is deployed
  once and minted hundreds or thousands of times in a window. Past a few
  hundred mints, full deploy is collectively cheaper — and the mint is
  the product's cheap-open-entry center, so collectors get the savings.
- **Terms in bytecode.** Price, fee, window, supply cap, and gate are
  Solidity `immutable`s — literally compiled into the release's own
  bytecode at creation. "The terms of a release are fixed when it opens"
  becomes a property you can verify by reading the contract account
  itself, with no dependency on any other account's code. That is the
  strongest possible answer to "is this really my contract, fully mine,
  forever," and this protocol's credibility is the product.
- **Cost honesty.** Full deploy is ~2.5–3.5M gas. At 2026-typical
  0.3–1 gwei that's roughly $3–12; at a 5 gwei day ~$50; at a 30 gwei
  spike ~$300. Clones would be ~10× cheaper to create. Releases are
  occasional ceremonies and the artist is deploying *the work's permanent
  home*; I'd spend this. If Dave disagrees, clones are the fallback and
  everything else in this plan survives unchanged.
- **Verification.** Every release shares identical creation code (args
  differ), so after the first release is verified, Etherscan auto-matches
  all subsequent ones. EIP-6780 also removed the historical
  selfdestruct-the-implementation worry that used to haunt both patterns.

One real constraint: the factory's runtime embeds `Release` creation
code, and EIP-170 caps factory runtime at 24,576 bytes. Budget: `Release`
runtime ≤ ~17KB. ERC721A + Ownable + 2981 + this protocol's logic should
land ~12–16KB at `optimizer_runs = 200`. **A `forge build --sizes` check
is a hard CI gate from the first commit**; if it ever busts, the
fallbacks are (in order) trimming, lower optimizer runs for the factory
profile, or reverting to clones — decided then, not silently.

### No protocol singleton in the money path

The factory is discovery + deployment + the fee constant. It never holds
funds, never sits between collector and artist, and cannot touch a
deployed release. If PND's frontend, indexer, and factory all vanished,
every release keeps minting, paying its artist, and serving metadata.

---

## 2. Contract inventory

```
contracts/src/releases/
  Release.sol            One release. ERC721A; window + supply logic;
                         mint + gated-claim paths; pull-payment accrual
                         (artist + per-surface); metadata (uri/renderer,
                         freeze); ERC-2981; burn; status views.
  ReleaseFactory.sol     new Release() per createRelease call. Holds the
                         surface-fee constant (owner-set, hard-capped,
                         snapshotted immutably into each release).
                         Registry: isRelease, allReleases. Fat creation
                         event for discovery.
  IRelease.sol           The external interface + shared types
                         (GateMode, ReleaseParams, Summary). What other
                         protocols import to gate on a release.
  IReleaseRenderer.sol   One function: tokenURI(uint256) → string.
                         The entire rendering "framework."
contracts/script/DeployReleases.s.sol
contracts/test/releases/   (see §10)
```

Roles:

| Contract | Owns | Can never |
|---|---|---|
| `Release` | artist (Ownable2Step from construction) | change price, window, supply, gate, fee; upgrade; touch other releases |
| `ReleaseFactory` | PND (Ownable2Step) | touch a deployed release; hold funds; exceed the fee cap |

---

## 3. Economics and fee flow

### Rules

- Artist sets `price` (in wei, may be 0) at creation. Immutable.
- The factory's current `surfaceFeeWei` is snapshotted into the release
  at creation as immutable `surfaceFee`.
- `mint(to, quantity, surface)` requires exactly:

```
total = price · quantity                        if price == 0  (free is free — fee impossible)
total = price · quantity                        if surface == address(0)  (unserved mint owes no fee)
total = (price + surfaceFee) · quantity         otherwise
```

  Strict equality — no overpay-and-refund path, no refund external call.
- The fee is **per token minted**, not per transaction (a 10-mint through
  a surface owes 10 fees; otherwise batch minting makes the fee
  decorative). Worth one explicit sign-off since the brief says
  "per-mint."

### Position on the no-surface mint

The brief asks this to be pressure-tested, so, taking the philosophical
hint as the position: **the fee exists only when a surface is named.** A
collector minting from Etherscan was served by no one and owes no fee. A
minter passing their own address as `surface` pays the fee to themselves
— net identical to passing zero, minus gas; not worth preventing. A
frontend passing `address(0)` is a surface choosing to work for free —
its prerogative, its loss, unenforceable anyway (you cannot prove which
UI built a transaction). None of these games can touch the artist's
`price · quantity`, which is the only enforcement that matters. PND's
frontend passes PND's treasury; a self-hosted page passes whatever the
artist routes it to (themselves, a split, a charity).

### Pull payments, both legs

No ETH leaves the release during a mint. The mint does accounting only:

```
collector ── msg.value ──▶ Release contract
                            ├─ artistBalance      += price · qty
                            └─ owed[surface]      += surfaceFee · qty   (when fee applies)

later, anyone's gas:
  withdraw()                 sends artistBalance → payout   (artist-set, mutable)
  claimSurfaceFees(surface)  sends owed[surface] → surface  (permissionless trigger,
                                                             funds only ever to the surface itself)
```

Why pull and not push-per-mint:

- **The mint makes zero external calls.** Reentrancy on mint is
  eliminated by construction, not guarded against. A reverting/malicious
  payout or surface address can never brick a live window — the exact
  failure mode that would turn a release event into a support incident.
- Surfaces batch: claiming a hundred 0.0005 ETH fees in one tx instead
  of paying a cold-call stipend inside every collector's mint.
- Withdrawals are zero-before-send (checks-effects-interactions); with
  balances zeroed before the send, reentering reads zero. No global
  reentrancy guard — CEI plus the invariant suite (§10) carries it.

The release's ETH balance always equals `artistBalance + Σ owed[·]`
(force-sent ETH via selfdestruct can exceed it and simply strands —
documented, not "rescued" by any sweep function, because a sweep is an
admin lever).

### The fee constant (flagged decision)

- `ReleaseFactory` is constructed with immutable `MAX_SURFACE_FEE_WEI`
  (propose **0.002 ETH**) and an initial `surfaceFeeWei` (propose
  **0.0005 ETH**, middle of the brief's 0.0003–0.0008 band — Dave picks
  the number).
- Factory owner can `setSurfaceFee(x ≤ MAX_SURFACE_FEE_WEI)`. Each
  release snapshots the value at creation, immutably — a fee change
  never reaches an existing release.
- Why a setter at all, given the auction factory's no-setters ethos: a
  wei-denominated constant ages with the ETH price, and the realistic
  alternative isn't purity — it's redeploying the factory every time the
  number stales, fragmenting discovery across factory addresses and
  turning a parameter tweak into a protocol migration. One bounded knob,
  on a parameter that never touches artist money, with a hard cap baked
  into bytecode (worst case ≈ $7 at today's prices) is the honest trade.
  The ethos-pure alternative (fully immutable fee, new factory to
  change) is workable if Dave prefers it; everything else stands.

---

## 4. Continuation: gates

Minimal mechanic, full capability: a release may name **one gate** at
creation — an ERC721 contract plus a mode. Immutable, like every other
term. Gates live entirely on the *new* release; the source release (or
any external 721) needs nothing, knows nothing, and is never mutated.

```solidity
enum GateMode { NONE, HOLD, BURN }
address gateToken;   // any ERC721. A PND release, or anything else —
                     // including pre-PND work (a Foundation collection, etc.)
```

Two mint paths, mutually exclusive by mode:

- `mint(to, quantity, surface)` — only when `NONE`.
- `mintGated(to, sourceTokenIds[], surface)` — only when `HOLD`/`BURN`;
  `quantity = sourceTokenIds.length`; same pricing rules apply (a gated
  release can still be free, priced, surfaced, or not).

**HOLD** — "hold a token from release A to mint release B":
1. For each `sourceTokenId`: caller must be `ownerOf` on the gate
   (owner, not merely approved — approval is for moving tokens, not
   spending their rights), and the id must be unused on this release.
2. Mark used (`gateUsed[sourceTokenId] = true`), mint, emit
   `Claimed(sourceTokenId, newTokenId)` per pair.
3. Each gate token claims exactly once per release — supply of B is
   bounded by supply of A, the Checks/Opepen continuation shape. The
   claim right travels with the token until spent (sell A#42 unclaimed
   and its buyer can claim — that's provenance working, not a bug).

**BURN** — "burn a token from release A to mint release B":
1. Caller must be `ownerOf` each source; caller must have approved this
   release on the gate contract.
2. Release calls `gate.burn(sourceTokenId)` — the de-facto
   `burn(uint256)` signature (OZ ERC721Burnable, ERC721A, and every PND
   release export it). Then mint + `Claimed` per pair. No
   transfer-to-0xdEaD fallback: a fake burn that leaves supply lying is
   worse than requiring a burnable gate. HOLD covers non-burnable 721s.
3. The burn is the record on A (Transfer → 0); the `Claimed` event is
   the link.

The per-token participation record the brief asks for is **events, not
token state**: A#42's history ("claimed B#7, later burned for C#1") is
the indexed union of `Claimed` events across releases that gated on A,
plus A's own burn Transfer. Nothing about A's tokens ever mutates, so
there is no shared-mutable-state surface between contracts, and the
record is reconstructible by any indexer from logs alone.

Trust note, stated plainly in natspec: a release **trusts the gate it
names**. A malicious gate contract can lie about `ownerOf` or reenter —
which can only corrupt *that release's own* gating, never its funds
accounting (pricing checks are per-call) and never any other contract.
The factory requires `gateToken.code.length > 0` at creation; it cannot
verify a `burn` exists, so a BURN release naming an unburnable gate is
created-but-unclaimable — artist closes it and redeploys (documented
failure, costs one deploy, harms no collector).

What this deliberately is not: no extension modules, no hook registry,
no graph layer, no per-token pointer state. Cross-contract gates between
otherwise-vanilla 721s is the whole machine. v2 can add multi-gate or
new modes by shipping new releases — never by mutating old ones.

---

## 5. Window mechanics

- `startTime` / `endTime` (`uint64`), immutable. Live iff
  `startTime ≤ now < endTime` and not closed and not sold out. Inclusive
  start, exclusive end — tested at exact boundaries.
- `endTime == 0` means open-ended: runs until `close()` (or forever).
  Fixed-supply-no-deadline releases are this plus `maxSupply`.
- `maxSupply` (`uint64`), immutable; `0` = uncapped. A mint whose
  quantity exceeds the remainder reverts whole (strict; minter retries
  smaller — no partial-fill-refund path, which would reintroduce an
  external call into mint).
- `close()` — owner, one-way, any time before or during the window. Ends
  minting forever; emits `Closed`. This is also "cancel" for a
  scheduled-but-not-yet-open release.
- **No extension, ever.** Position, since the brief asks for one: a
  timed open edition's window *is* its supply mechanism. Everyone who
  minted did so against a public closing time; lengthening it
  retroactively dilutes them in a way they cannot exit (no refunds
  exist). Closing early only makes the edition scarcer than promised —
  the asymmetry is the fairness. An artist who genuinely needs more time
  closes and releases again, on the record.
- No per-wallet caps, no anti-bot gates (cut — see §11).

`status()` view returns `Scheduled | Live | SoldOut | Closed | Ended`,
and `summary()` returns one struct (terms + counters + status) so a
static self-hosted page can render a complete, correct mint UI from a
single `eth_call`.

---

## 6. Metadata

- `tokenURI(id)`:
  1. if `renderer != address(0)` → `IReleaseRenderer(renderer).tokenURI(id)`
  2. else if `uriPerToken` → `string.concat(uri, toString(id))`
  3. else → `uri` (every token identical — the default open-edition shape)
- Owner may `setMetadata(uri, uriPerToken, renderer)` until
  `freezeMetadata()` — one-way, emits `MetadataFrozen`, after which
  tokenURI is fixed forever (renderer pointer included: frozen means the
  *pointer* is frozen; a renderer that is itself a mutable contract is
  the artist's published choice, visible onchain).
- The **default path end-to-end**: artist pins one image + one metadata
  JSON to IPFS (self-pinned — PND's pin tooling can assist but never
  custodies), pastes `ipfs://…/metadata.json` into the create form,
  `uriPerToken = false`, renderer zero. Done. Generative/onchain work
  sets `renderer` to its own contract; the protocol neither knows nor
  cares what's behind it, and v1 ships **no** renderer implementations.
  The slot exists only because immutable contracts can't grow one later.
- `contractURI()` (ERC-7572) — collection-level metadata for
  marketplaces; same mutability and freeze as token metadata.
- EIP-4906 `BatchMetadataUpdate` emitted on metadata changes so
  marketplaces re-pull.

## 7. Royalties and standards

- **ERC-2981**, artist-set at creation (receiver + bps), owner-mutable
  after (royalty preferences legitimately change; it's advisory
  signaling either way — no enforcement illusions). Cap `≤ 5_000` bps as
  a fat-finger guard, not an opinion.
- ERC-165: 721, 721-Metadata, 2981, 4906.
- **No operator filter.** Dead technology; against the open-composability
  grain of the gate design.
- **ERC721A v4** (non-upgradeable, audited, battle-proven at exactly this
  workload) for near-O(1) batch mints — quantity minting is core open
  edition UX. Sequential ids from 1; `_mint` rather than `_safeMint`
  (no receiver-hook call → no reentrancy vector, no contract-recipient
  brick; a contract that can't handle a 721 receiving one is its
  deployer's documented problem). Public `burn(tokenId)`
  (owner-or-approved), which is also what makes every release
  BURN-gateable by future releases.
- New vendored dep: `chiru-labs/ERC721A` (repo currently vendors only
  the Upgradeable variant; `lib/` is gitignored and reconstituted per
  the standing memory note).

---

## 8. Events (complete list)

Factory:

| Event | Indexer use |
|---|---|
| `ReleaseCreated(address indexed release, address indexed artist, string name, string symbol, uint256 price, uint256 surfaceFee, uint64 startTime, uint64 endTime, uint64 maxSupply, address gateToken, uint8 gateMode)` | One row in `pnd_releases` with every immutable term — **zero follow-up RPC reads**. `artist` indexed = Canon's future attribution hook. |
| `SurfaceFeeSet(uint256 feeWei)` | Audit trail of the constant. |

Release (beyond standard `Transfer`, which gives supply/owners/burns):

| Event | Indexer use |
|---|---|
| `Minted(address indexed to, address indexed surface, uint256 firstTokenId, uint256 quantity, uint256 pricePaid, uint256 feePaid)` | Mint feed; live counts; per-surface earnings by SQL aggregate. |
| `Claimed(uint256 indexed sourceTokenId, uint256 indexed tokenId)` | Participation graph: which gate token claimed/burned for which new token (gate address is an immutable of the emitting release). |
| `Closed()` | Window state. |
| `PayoutSet(address payout)` | Current payout (constructor emits initial). |
| `MetadataSet(string uri, bool uriPerToken, address renderer)` + `MetadataFrozen()` + 4906 | Metadata state without reads (constructor emits initial). |
| `ContractURIUpdated()` (7572) | Re-pull contractURI. |
| `RoyaltySet(address receiver, uint96 bps)` | 2981 state (constructor emits initial). |
| `ArtistWithdrawn(address to, uint256 amount)` / `SurfaceFeesClaimed(address indexed surface, uint256 amount)` | Claimable-balance display = aggregate(Minted) − aggregate(withdrawals); no balance reads. |

Design rule applied throughout: anything mutable announces itself with
its own event type and the constructor emits initial values — the
indexer has exactly one code path per field and never issues an
`eth_call`.

## 9. Indexing and web integration

### Indexer (Ponder — and no worker involvement)

`ReleaseFactory` is precisely the case AGENTS.md reserves Ponder for: a
fixed, shared, PND-owned contract. Children via the established
`factory()` pattern (same as `SovereignAuctionHouse`):

```ts
ReleaseFactory: { address: RELEASE_FACTORY, startBlock: DEPLOY_BLOCK }
Release: { address: factory({ address, event: ReleaseCreated, parameter: "release" }) }
```

Bounded by construction — only contracts our factory deployed, the
opposite of the long-tail scanning the v2 rebuild removed. The worker is
untouched. drpc free tier already serves the multi-address `eth_getLogs`
this pattern needs (per `ponder.config.ts` notes). Wiring is deploy-gated
exactly like the auction house was: address + startBlock land in the
config after mainnet deploy.

Tables (`ponder_v1`, `pnd_*` family conventions):

```
pnd_releases            release pk; artist, name, symbol, price, surfaceFee,
                        startTime, endTime, maxSupply, gateToken, gateMode;
                        payout, uri, uriPerToken, renderer, frozen,
                        royaltyReceiver, royaltyBps, closed;
                        minted, burned (running); createdAt block/time/tx
pnd_release_mints       id pk; release, to, surface, firstTokenId, quantity,
                        pricePaid, feePaid, block/time/tx
pnd_release_claims      id pk; release, sourceTokenId, tokenId, claimer,
                        gateMode, block/time/tx
pnd_release_tokens      (release, tokenId) pk; owner, burned, mintedAt
pnd_release_withdrawals id pk; release, kind(artist|surface), account,
                        amount, block/time/tx
```

### Web (`apps/web`) — built only after contracts are done and tested

- `/releases` — landing: live and recent releases (Postgres only).
- `/releases/new` — create flow: form → `createRelease` tx (one tx, like
  the existing create-edition flow); metadata URI pasted or produced via
  the existing self-pin tooling.
- `/releases/[release]` — the release page: countdown, live count,
  open/closed state, mint CTA (`surface = NEXT_PUBLIC_PND_SURFACE_ADDRESS`),
  price + fee shown as two visible lines ("0.01 ETH to the artist +
  0.0005 ETH to PND" / "free — gas only"); claim UI for gated releases
  (pick your source tokens; indexer supplies eligibility); artist panel
  (withdraw, close, metadata + freeze) when connected as owner.
- `/releases/[release]/[tokenId]` — token + its participation history
  (claims/burns from `pnd_release_claims`).
- Live-chain reads stay within the `onchain.ts` budget: current window
  state + minted count on the release page; everything else Postgres.
- ABIs via `scripts/emit-*` convention into `packages/abi`; factory
  address into `packages/addresses`.
- Copy rules apply (ETH not Ξ, "onchain", no em/en dashes in site copy).
- Local dev + e2e: `dev:releases` fork harness + Playwright spec
  mirroring the existing `dev:editions` setup.

A self-host note for the docs (post-v1 nicety, not scoped): a release is
fully drivable from Etherscan (`summary()` + `mint`), and the
`templates/artist-page` template can later grow a static mint widget that
reads `summary()` and calls `mint` with the artist's own surface address.

## 10. Testing strategy

Foundry, `contracts/test/releases/`, mirroring repo conventions
(`forge-std`, fork tests via `MAINNET_RPC_URL`, named mock contracts).

**Unit** — the full matrix:
- Window: mint at `start−1` (revert), `start`, `end−1`, `end` (revert);
  scheduled/ended/closed states; `endTime = 0` open-ended; `close()`
  before open, while live, idempotency (revert on second), non-owner.
- Pricing: every cell of {price 0, price > 0} × {surface 0, surface set,
  surface = self, surface = contract} × {qty 1, qty N} — exact-value
  required, over/under reverts, **price-0 requires msg.value 0 on every
  surface input** (free is free is the most-tested sentence in the
  suite).
- Supply: exact-remainder mint, remainder+1 revert, uncapped, sold-out
  status.
- Gates: HOLD — non-owner revert, approved-but-not-owner revert, unused
  → used, double-claim revert, transfer-then-claim-by-new-owner,
  per-token `Claimed` events; BURN — unapproved revert, burn-then-mint
  atomicity, gate without `burn` reverts cleanly, can't burn someone
  else's token; mode exclusivity (mint vs mintGated); gated + priced +
  surfaced combinations.
- Funds: accrual correctness, withdraw to payout, payout mutation,
  `claimSurfaceFees` permissionless trigger, zero-balance no-ops,
  double-withdraw, reverting-payout (withdraw fails, mint unaffected),
  reverting-surface (their claim fails, everyone else unaffected).
- Metadata: identical/per-token/renderer paths, freeze one-way, 7572,
  4906 emissions. Royalty set/cap. Ownable2Step handover. 165 surface.
- Factory: snapshot semantics (fee change doesn't reach existing
  releases), cap enforcement, owner gating, param validation (end > now
  or 0, gate code check, royalty cap), registry views, event contents.

**Fuzz** — fee math (`price`, `qty`, `surface` randomized: required
value exact, accruals exact, artist total never depends on surface
games); window boundaries (random timestamps vs immutable window);
HOLD/BURN with random id sets (duplicates in one call must revert).

**Invariant** — handler-based: random mints/claims/withdraws/closes;
`address(release).balance == artistBalance + Σ owed` (ghost sum), artist
cumulative receipts `== price · totalMinted` minus pending, fee receipts
only ever to named surfaces, `totalMinted ≤ maxSupply`, no mint outside
an open window.

**Reentrancy** — malicious payout/surface contracts attempting reentry
during withdraw/claim (zeroed-before-send proves harmless); malicious
gate contract reentering `mintGated` (per-call pricing makes reentry
just another paid mint or a revert); `_mint`-not-`_safeMint` documented
by a test minting to a non-receiver contract.

**Fork** (pinned `FORK_BLOCK` per the standing RPC-cache discipline,
public RPC): HOLD gate against a real mainnet 721 someone actually
holds; BURN against a real burnable 721; `DeployReleases.s.sol` dry-run.

**Gas + size** — `forge snapshot` for mint qty 1/5/10, gated claim, and
`createRelease`; `forge build --sizes` asserted under EIP-170 with
headroom. Mint qty 1 target < 100k gas.

## 11. v1 scope line

**In:** everything above. **Out, deliberately:**

- ERC1155 (per-token identity is the point), referrals/rewards of any
  kind, first-minter anything (the brief's three-party rule is load-
  bearing).
- Allowlists/Merkle (the holder-gate *is* the gate feature), multi-gate
  (one gate per release; compose with more releases), per-wallet caps and
  anti-bot/EOA gates (unenforceable theater that breaks composability;
  open editions defend themselves by being open; capped releases are
  first-come, as the 2023 reference points were).
- Price changes, tiered/dutch pricing, window extension (positions in
  §3/§5).
- Splits machinery (point `payout` at any split contract — composition,
  not protocol).
- Renderer implementations (slot only), Canon registry (only its
  attribution hooks: indexed `artist` + immutable `artist()`),
  upgradeability of anything, operator filters, cross-chain, signature
  mints, ERC20 pricing.

## 12. Decisions that are expensive to reverse — explicit sign-off list

Once a factory is on mainnet, these are forever (per release, or until a
factory redeploy):

1. **Full deploys, not clones** (§1) — and its 24KB factory-size
   commitment.
2. **Fee semantics**: per-token-minted; charged only when `surface ≠ 0`;
   zero when `price = 0`; strict `msg.value` equality.
3. **Fee constant handling**: factory-owner-settable under immutable
   `MAX_SURFACE_FEE_WEI = 0.002 ETH`, snapshotted immutably per release.
   Initial value (propose 0.0005 ETH) is Dave's number. The
   no-setter/redeploy-to-change alternative is viable if preferred.
4. **Immutable per release**: price, window, maxSupply, gate, fee.
   Mutable forever: payout, royalty, metadata-until-frozen. One-way:
   close, freeze.
5. **Gate trust + `burn(uint256)` signature** dependency for BURN mode;
   owner-not-approved claim rule; one-claim-per-source-token.
6. **No extension of live windows** (close-early only).
7. **`_mint` not `_safeMint`**; token ids from 1; ERC721A.
8. **Pull payments** with permissionless `claimSurfaceFees`.
9. **Naming**: protocol "Releases", contracts `Release`/`ReleaseFactory`,
   routes `/releases` — distinct from the undeployed `editions`
   namespace. Renames are free until deploy.

## 13. Open questions for Dave

1. The fee number (0.0003–0.0008; plan assumes 0.0005) and the 0.002 cap.
2. Factory owner address (deployer EOA vs a PND treasury/multisig — it
   only ever controls `setSurfaceFee`).
3. Disposition of the undeployed `contracts/src/editions/` system + its
   `/editions` routes: archive/remove before Releases ships to mainnet
   (my recommendation — two parallel create flows would be confusing), or
   keep until Releases is proven?
4. Naming sign-off (§12.9).

## 14. Implementation order (after plan sign-off)

1. Contracts + full test suite (unit/fuzz/invariant/fork/gas/size), on
   this branch.
2. Deploy script + fork dry-run; ABI emit + addresses plumbing.
3. Indexer: schema + handlers (config wiring stays deploy-gated).
4. Web: routes/components + `dev:releases` harness + e2e.
5. Mainnet deploy is its own explicitly-confirmed step (per-broadcast
   protocol), then: factory address + start block into addresses/config,
   Etherscan verify, first release end-to-end on prod.

---

## Appendix: relationship to the prior editions build

Read for repo conventions only; designed from the brief. Where the
designs converge, the independent path that led there:

| Converges | Independent reasoning |
|---|---|
| One contract per release | Vanilla-721 gate composability + marketplace identity (§1) |
| ERC721A | Batch-mint economics of open editions (§7) |
| Pull payments | Zero-external-call mints; unbrickable windows (§3) |
| Renderer pointer + metadata freeze | Immutable contracts can't grow hooks later (§6) |
| Factory + fat discovery event | The bounded-indexing rule + auction house precedent (§8–9) |
| 50% royalty fat-finger cap | Same guard, same non-opinion (§7) |

| Diverges | This plan |
|---|---|
| UUPS + `seal()` | No upgradeability, ever — immutability is constructional, not a renounceable option |
| 10% surface share carved from price | Flat fee **added on top**; artist's price untouchable by routing |
| Share folded to artist on direct mint | No surface → no fee exists at all |
| Hook framework (allowlist/cap/holds) | No hooks; one built-in gate (HOLD/BURN) is the continuation capability |
| Mint Marks / Edition Graph / Token Path | Events-only participation record; no token state |
| Clone-or-proxy deploy modes | One pattern: full deploy |
