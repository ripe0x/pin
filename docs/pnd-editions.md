# PND Editions design plan

> **SUPERSEDED (2026-07-06).** The Editions contract was reworked into the
> Surface system (OZ ERC721 core, four slots, id modes); see
> docs/pnd-surface-system.md and docs/pnd-surface-contracts-plan.md.
> This document describes the pre-rework ERC721A design; payment-split,
> hook, and graph concepts carry over, token-layer specifics do not.
> Contracts now live in contracts/src/collection/ (src/editions/ was
> removed).

> **Status: design plan (historical "why").** Two things were simplified
> after this was written. Where they differ, `docs/pnd-editions-README.md`
> and `docs/pnd-editions-spec.md` are authoritative:
>
> - **One contract == one edition.** The "project holds many releases"
>   two-level model below was collapsed — each edition is its own ERC721A
>   contract, created in one step. Read "release" below as "edition", and
>   "Release Graph" as "Edition Graph".
> - **Surface Share is a fixed 10% protocol constant, not artist-set.** It
>   is paid to whoever hosts the mint: PND on PND, the artist on their own
>   site (self-hosting keeps 100%). So PND does earn on PND-hosted paid
>   mints; the "no mandatory fee" framing below is superseded by this
>   opt-out-by-self-hosting model.
> - **Editions are always upgradeable** (UUPS) with opt-in `seal()`; the
>   immutable-clone option below was dropped.
>
> Everything else (Mint Marks, the graph, Token Path, honest pricing,
> hooks, the swappable renderer) shipped as designed. Read this for the
> "why", the spec for the "what the contract exposes".

## The one sentence thesis

PND Editions is a mainnet only, artist owned **ERC721A** edition
protocol where a release begins as shared artwork under shared mint
conditions, but **every minted token keeps its own identity** so it can
carry provenance now (Mint Marks) and point somewhere later (Token
Path), and where the only money that moves is the price the artist set,
split exactly how the artist chose, with no protocol tax.

Everything below serves that sentence.

---

## 1. What we learned from Zora

**The mechanic that made it fun.** Zora's older 1155 protocol made
collecting feel like a one dollar social gesture. A flat `0.000777 ETH`
mint fee per mint (about a dollar) on top of an often 0 ETH "free" mint.
Cheap enough to be impulsive, repeatable, and positive sum feeling.

**Protocol Rewards is the real innovation, and the real trap.** That
`0.000777 ETH` was split, per mint:

- Creator reward: `0.000333 ETH` (about 42.9%)
- Create referral: `0.000111 ETH` (the platform the drop was created on)
- Mint referral: `0.000111 ETH` (the platform the mint happened on)
- First minter reward: `0.000111 ETH`
- Zora: `0.000111 ETH`

For paid mints the artist also keeps 100% of the sale price, with the
reward fee riding on top. The mint referral line is what grew mint.fun
and the whole referral surface economy: any frontend that routed a mint
earned a cut. Powerful, and also the seed of the rot.

**Architecture worth respecting:**

- `ZoraCreator1155Factory` deploys per creator upgradeable 1155
  contracts. One contract, many token ids, each token with its own
  metadata, royalties, and sale config.
- **Modular sale strategies** as separate permissioned minter contracts:
  `FixedPrice`, `MerkleMinter` (allowlist), `Redeem`, and later
  `TimedSale`. The 1155 grants a minter role to a strategy and mint
  flows through it. Clean separation of "the collection" from "how it
  sells".
- A per token **permission bitmask** (admin, minter, sales, metadata,
  funds).
- A shared `ProtocolRewards` escrow where every party's cut accrues and
  is withdrawn later.
- **Premint:** the creator signs an EIP-712 message and the first
  collector pays the gas to bring the token onchain. Creator gasless
  drops, cross surface minting, and the first minter reward all come
  from this.

**The weak secondary problem and Zora's answer.** Open editions with
unlimited supply have no scarcity, so they have no floor and basically
no secondary market. Collectors ended up holding bags of editions worth
nothing. Zora's 2024 fix was the **Timed Sale Strategy**: drop the mint
fee to `0.000111 ETH`, escrow `0.0000111 ETH` of each mint, and at the
end of a roughly three day sale auto deploy a **Uniswap V3 pool** plus
an **ERC20z** token (a 1:1 wrap/unwrap of the 1155). `launchMarket()`
opens trading. Every edition becomes a tradable coin with bootstrapped
liquidity. This is the logical lead in to the full pivot to **Zora
Coins / content coins**, where every post is a coin. That is the
endpoint of optimizing for mint volume and liquidity, and it is exactly
the place PND must not drift toward.

**The traps, stated plainly:**

1. **Volume became the product.** Rewards plus a rumored token turned
   minting into farming. Wash minting, sybil mints, mint to earn. The
   feed optimized for what got minted most, not what was good.
2. **"Free" was never free.** A "free mint" still cost `0.000777 ETH`.
   The label lied by a dollar, every time, at scale.
3. **The platform sat in the middle of every mint.** Create referral and
   mint referral mean the protocol (or some frontend) always took a
   slice. Convenient, but it makes the surface mandatory and the
   economics opaque.
4. **The global feed flattened everyone.** A serious artist's release
   and a meme were the same card in the same scroll.
5. **Forced liquidity to fix value.** The ERC20z/Uniswap move solved "no
   secondary" by financializing the art into a coin. It manufactured a
   market instead of letting the work earn one.

---

## 2. What we learned from Mint Protocol (Visualize Value)

Mint is the philosophical opposite of late Zora, and it is the closer
ancestor of PND.

**The stated philosophy** (VV's docs):

- "To mint is a human right, and your right is your responsibility."
- It "enforces scarcity through the moment of creation, not volume
  restrictions."
- **"The cost to store and secure the object on the network is mirrored
  as compensation to the artist."**

That last line is the whole pricing model and it is the cleanest idea in
the space.

**Architecture (confirmed by this repo's own integration code, see
`apps/worker/src/tasks/scan-mint-clones.ts`, `packages/abi/src/mintEdition.ts`,
`apps/web/src/components/token/MintEditionCTA.tsx`):**

- A single `MintFactory` (`0xd717Fe677072807057B03705227EC3E3b467b670`,
  deployed at block 21,167,599) deploys per artist **ERC1155** contracts
  as **EIP-1167 minimal proxy clones**. One event, `Created(owner,
  contract)`. Clean, indexable discovery.
- Each artist clone holds many artifacts as token ids.
  `mint(uint256 tokenId, uint256 amount) payable`.
- **Pricing:** `unitPrice = block.basefee * 60_000`, charged per copy.
  No fixed protocol fee. Overpayment is not refunded, it goes to the
  artist. The price literally is "what it costs the network to keep
  this, paid to the artist".
- **Mint window:** a fixed 24 hours from first mint (`MINT_DURATION`),
  then `MintClosed`. Unlimited supply within the window. Scarcity is the
  moment, not the cap.
- **Opinionated minimalism:** standard deploy plus mint, extensible only
  through pluggable metadata renderers. No referral economy, no
  secondary market, no leaderboard, no rewards token. The artifact is
  the product.

**The tradeoffs Mint accepted:**

- Basefee pricing is honest but **unpredictable and not artist chosen in
  absolute terms**. In a calm gas period an artifact is nearly free, in
  a busy one it is expensive. The "value" floats with the network, not
  with the art or the artist's intent.
- **1155 means fungible copies.** Within a token id every copy is
  identical and interchangeable. There is no per token identity, so
  there is nowhere to hang per token provenance or a per token future.
  The moment is shared, the object is not individuated.
- Minimalism means **no continuity primitive.** Each artifact stands
  alone. There is no native way to say "this is phase two of that", or
  "this token can later become something".

---

## 3. What PND should copy, adapt, or avoid

**Copy from Mint:**

- Per artist, artist owned contracts deployed as minimal proxy clones
  from one factory with a single clean discovery event.
- Honesty as the core value. Price is exactly what it says. No hidden
  protocol fee.
- Minimalism and opinionated deployment. A small, legible surface.
- Scarcity through conditions (time, cap, or moment) rather than
  artificial rarity traits.

**Copy from Zora (the good parts):**

- The factory plus per token config pattern, adapted to ERC721A.
- The idea of a referral/surface reward, but **inverted**: artist set,
  opt in, visible, and never owed to the protocol by default.
- Modular thinking (separate "what it is" from "how it sells") without
  Zora's full strategy contract sprawl in v1.

**Adapt:**

- Zora's mint referral becomes PND's **Surface Share**: the artist
  decides whether to give a slice of their own price to whoever
  facilitated the mint, and who that is depends on where the mint
  happened. PND has no privileged claim.
- Mint's basefee pricing becomes PND's **artist set fixed price** (0 ETH
  or any ETH). Same honesty (no hidden fee), but predictable and
  intentional, which fits artists who price with intent.

**Avoid (hard lines):**

- No rewards token, no mint to earn, no referral economy as a behavior.
- No mandatory protocol fee, ever.
- No "free" label on anything that costs more than gas.
- No forced liquidity, no auto AMM, no content coins.
- No global feed as the product.
- No rarity, no reveal hype, no floor price framing, no leaderboard.

**The single most important divergence: ERC721A, not ERC1155.** Both
Mint and Zora editions are 1155, so a copy has no identity. PND chooses
ERC721A precisely so each mint is an individuated object that can carry
a Mint Mark today and a Token Path tomorrow. This is the structural
choice that makes future specificity possible. It costs more gas than
1155, and ERC721A is how we keep that cost sane (see Section 9).

---

## 4. Recommended protocol architecture

Three layers, each independently readable, none depending on the PND
frontend.

**Layer A, Editions (the contracts).**

- One **`PNDEditionsFactory`** deploys **one ERC721A contract per
  project**. Each new project an artist makes is its own contract, owned
  by the artist. One discovery event, `ProjectCreated(owner, project,
  mode)`, shaped like Mint's `Created` so PND's existing indexer pattern
  picks it up without new machinery.
- A **`PNDEditions`** project contract holds one or more **Releases** (a
  release is a mint configuration: price, window, cap, default art,
  kind, royalty). Single release projects are the common case; multi
  release projects (phases inside one contract) are supported, not
  required. Each release issues sequential ERC721A token ids when
  minted, with EIP-2981 royalties per release.
- **Art is behind a swappable renderer, not hardcoded.** A release has a
  shared default image, but the protocol does not assume every token
  shares it. The contract allows **unique art per token** via a per
  token CID override or an artist supplied renderer contract (Zora
  style, with a built in CID fallback). Frontend v1 uses shared art; the
  capability exists in the contract from day one.
- **Pre and post mint hooks.** A release (or the project) can point at an
  artist owned hook contract that the project calls on each mint. The
  artist can gate mints or record custom data to their own storage
  contract, without PND building those features into the core. This is
  the extensibility the artist wanted from Zora's old contracts.

**Layer B, Release Graph (relationships between releases).**

- A release can declare typed, directed edges to other nodes, addressed
  globally as a `Ref { chainId, contract, id, kind }`. Edges like
  `BelongsTo`, `StudyOf`, `PhaseOf`, `Continues`, `Source`, `Access`.
- This is a **standard onchain interface plus a canonical event
  schema implemented in the edition contract**, not a mandatory central
  registry. Edges can point across contracts and across artists (a
  collaboration, a source object). Any interface reads it from contract
  state or logs. PND may run a convenience indexer, but the source of
  truth is per contract and PND independent.

**Layer C, Token Path (per token future pointer).**

- Each token id has one reserved pointer slot: `pathOf(tokenId) ->
  { pathType, target }`, empty at mint. `target` is a `Ref` (another
  release, a token, or an external node). V1 stores, reads, and emits.
  V1 does **not** execute continuation, migration, claim, reveal, or
  burn. It only guarantees the pointer exists and is writable, so future
  versions or other people's contracts can interpret it.

**Why not a shared registry for B and C:** a central registry would
quietly make PND the chokepoint the ethos rejects. Per contract storage
plus a published interface keeps the artist's contract self sufficient
and self hostable. The graph is just directed pointers between globally
addressable nodes, readers resolve them.

**Indexing fits the existing split (per AGENTS.md).** The fixed
`PNDEditionsFactory` is exactly the kind of single shared contract
Ponder should watch for **discovery** (like `mint_creators`). The
**worker** then scans each discovered clone for mints, Mint Marks, and
graph/path events, gated on `known_artists`, writing the `public` tables
web reads. Do not put per token indexing in Ponder.

---

## 5. Recommended contract components

See `docs/pnd-editions-spec.md` for the full interface definitions. In
summary:

**`PNDEditionsFactory`**

- `createProject(name, symbol, owner, mode) returns (address)`, deploys
  a per project ERC721A and emits `ProjectCreated`. `mode` is the opt in
  upgradeability choice (see below). Minimal.

**`PNDEditions` (ERC721A, one per project)**

Release config, set by the artist at `createRelease`: default artwork
pointer (CID backed, shared, per token overridable), price (0 or any
ETH), `surfaceShareBps`, supply cap (0 = open), mint window, EIP-2981
royalty, release kind, payout address, optional renderer override,
optional mint hook override.

Mint: `mint(releaseId, quantity, surface, hookData) payable`. Validates
window, cap, and exact payment. Runs the mint hook (if set) before and
after. Splits **out of price** (not on top): `surfaceCut = price *
quantity * surfaceShareBps / 10000` to `surface`, remainder to the
artist payout. If `surface == address(0)` the share folds back to the
artist. Mints a contiguous ERC721A batch and records one **Mint Mark
batch record** for the call.

Honest price rule, baked in: if `price == 0` the UI and events describe
it as **gas only**, never "free".

**Swappable renderer (`IPNDRenderer`).** `tokenURI` delegates to a
resolved renderer: per release override, else project renderer, else the
built in default. The built in default returns the per token CID
override if set, else the release default art, with Mint Mark fields as
provenance attributes. Unique per token art is achieved either by per
token CID overrides or by an artist supplied renderer (generative,
manifest based, or fully onchain SVG/HTML).

**Mint hooks (`IPNDMintHook`).** Owner set, non payable, magic value
gated. `beforeMint` can revert to gate a mint (custom allowlist, anti
bot, external conditions); `afterMint` is where the artist records
custom data to their own storage contract. Trust is artist scoped, a bad
hook only harms that artist's own project, and collectors can read the
hook address.

**Opt in upgradeability.** The factory deploys one of two shapes the
artist chooses per project: `ImmutableClone` (EIP-1167, no upgrade code,
cheapest, the UI default) or `Upgradeable` (ERC1967 UUPS, owner can
upgrade until they call `seal()` to renounce permanently). Both
`isUpgradeable()` and `isSealed()` are public reads so the mutability
stance is transparent to collectors.

**Mint Marks (per token provenance, recorded per batch).** Each
`mint()` call is one ERC721A batch of contiguous token ids sharing one
surface, one block, one status snapshot. We store one batch record per
call, not per token, and emit one `Minted` event. A token's mark
(releaseId, indexInRelease, mintBlock, surface, statusAtMint) is
resolved by binary search over batch heads. `first` and `final` are
derived, not stored. No traits, no rarity roll, no hidden reveal. Full
mechanics in the spec.

**Release Graph and Token Path** implement `IPNDReleaseGraph` and
`IPNDTokenPath` (append only edges, per token pointer slot, canonical
events). Pointer layer only in v1.

**Not in v1:** no sale strategy plugin system, no protocol level
allowlist/Merkle minter (an artist can do allowlist gating in their own
mint hook), no Dutch auction, no premint signatures, no rewards escrow,
no secondary/AMM. Upgradeability is opt in per project, never forced.

---

## 6. Recommended frontend flows

All surfaces are crypto native: wallet first, contract addresses
visible, decoded transactions, no email/custodial onramp, no hidden
steps.

**Artist, create a release**

1. Connect wallet. Deploy a `PNDEditions` contract once, or reuse the
   existing one. The contract address is shown and is theirs.
2. Create release: point to artwork (CID), set price with a live honest
   preview ("0 ETH, collector pays gas only" or "0.01 ETH"), set
   `surfaceShareBps` with plain language ("keep 100%" or "share X% with
   whatever surface facilitates the mint"), set cap and window, set
   royalty, optionally declare Release Graph edges ("this is phase one
   of ...", "this is a study for ...").
3. Publish. The release is mintable from any surface, including the
   artist's own.

**Collector, mint**

One screen, fully decoded: the artwork, the exact price, the **visible
split** ("0.01 ETH: 0.009 to the artist, 0.001 to this surface"), gas
estimate, and a **Mint Mark preview** ("you will receive token #47,
minted during phase one"). Never the word "free" on a paid mint. Wallet
signs a legible transaction.

**Self hosting, first class from day one**

PND exports a static, self hostable mint page wired to the artist's
contract, passing the **artist's own address** as `surface`. This reuses
the existing `templates/artist-page/` to `sovereign-artist-site` sync,
so the self hosted page is a real mint surface, not a downgraded export.
"PND has no mandatory fee" only becomes literally true when the artist
can mint off their own page and capture the surface share themselves.
Built in v1, not deferred.

**Release Graph view.** A readable graph of an artist's releases and
their relationships, rendered from onchain data so it works in any
interface, including the self hosted page.

**Token page.** Shows the token's Mint Mark (order, block, surface,
status at mint) as provenance, and its Token Path pointer (empty in v1,
or "points forward to ..."). Reads from chain/indexer, renders the same
anywhere.

**On the feed.** PND keeps its existing feed as a discovery surface, but
the product is the artist's contract and release, not the feed. The feed
is never the thing being optimized.

---

## 7. Recommended v1 scope

1. `PNDEditionsFactory` plus `PNDEditions` (ERC721A, one per project),
   with releases, honest fixed pricing, the Surface Share split,
   EIP-2981, and opt in upgradeability (ImmutableClone default).
2. The swappable renderer (`IPNDRenderer`) with built in CID fallback
   and per token CID override, and the mint hooks (`IPNDMintHook`). These
   are contract capabilities in v1 even though the v1 frontend only
   exposes shared release art and no custom hook UI. Wiring them is what
   lets crypto native artists build on the contract immediately.
3. Mint Marks recorded per batch, provenance only, with onchain resolver
   and full events.
4. Release Graph data layer: append only typed edges plus events plus
   read interface. Ship the canonical edge set: `BelongsTo`, `StudyOf`,
   `PhaseOf`, `Continues`, `Source`, `Access`.
5. Token Path: per token pointer storage, setter, read, event. Pointer
   layer only.
6. Indexer/worker integration following the existing pattern: Ponder
   discovers the factory, the worker scans clones gated on
   `known_artists`, add PND Editions to
   `apps/web/src/lib/indexed-platforms.ts`.
7. Web flows: artist release creation, decoded collector mint with
   visible split and Mint Mark preview, token page, release graph view.
8. **Self host export from launch**, passing the artist's surface
   address.
9. Mainnet only.
10. Tie into the existing Preserve signal: PND Editions media is a first
    class pinning/CID availability candidate.

---

## 8. What to explicitly leave out of v1

- Execution of any future action: continuation, migration, claim,
  reveal, burn. V1 ships the pointer, not the action.
- Any secondary market, AMM, liquidity bootstrapping, ERC20 wrapping, or
  coin.
- Any rewards token, referral economy, leaderboard, or mint to earn.
- Any rarity, trait roll, or timed reveal.
- The global feed as a core product (side surface only).
- L2 / multichain. Mainnet only by design.
- Basefee floating price (chosen against, in favor of artist set fixed
  price, documented as an alternative).
- ERC1155 path, premint signatures, Merkle/allowlist minters, Dutch
  auctions, and a pluggable sale strategy system.
- A mandatory central Release Graph registry. The interface is the
  standard, the contract is the store.
- A **frontend** for per token art, custom renderer authoring, or hook
  authoring. The contract supports all three from day one, but the v1
  PND UI exposes only shared release art and the default renderer. An
  artist who wants unique per token art or a custom hook in v1 does it by
  pointing the contract at their own renderer/hook (or setting per token
  CIDs), not through a PND UI. The UI catches up later.

---

## 9. Risks and tradeoffs

1. **ERC721A editions cost more gas than 1155, and ERC721A is the
   mitigation.** ERC721A writes ownership once per batch instead of once
   per token, so a batch mint of N tokens is close to O(1) in ownership
   writes. We deliberately record Mint Marks **per batch** to match that
   model, so provenance does not reintroduce per token writes. A batch
   of 10 pays roughly constant Mint Mark overhead. The remaining cost
   over 1155 is real but bounded, and it buys the entire PND thesis (per
   token identity). Resolved decision: ERC721A.
2. **Open editions in ERC721A can balloon supply** (state and a giant
   undifferentiated set). Encourage capped or time boxed releases, make
   "open and uncapped" a conscious choice, not the default.
3. **Surface Share is permissionless, so it can be captured by anyone
   who builds the mint transaction.** If the artist sets
   `surfaceShareBps > 0`, a third party could mint via its own `surface`
   address and take the share. That is the honest consequence of "PND is
   not privileged". Mitigations: `surface == 0` folds the share back to
   the artist (recommended, simple), optionally an artist set allowlist
   of accepted surfaces (more control, more complexity). See Open
   Question 4.
4. **No mandatory protocol fee means PND has no protocol revenue from
   mints.** Intentional and correct for the ethos, but a real business
   model tradeoff. PND earns only when artists choose to route the
   surface share to PND for mints on PND, plus any service layer (for
   example Preserve pinning). Flagged honestly rather than smuggling a
   fee back in.
5. **Token Path write authority is a provenance integrity question.** If
   holders can rewrite a token's future pointer, what stops abuse? If
   only the artist can, is it really the token's own path? V1 ships an
   artist set release default with per token holder writes reserved for
   later. See Open Question 5.
6. **Mint Marks must never become rarity.** The risk is social, not
   technical. Collectors will try to make "#1" or "minted in phase one"
   into a rarity game and a floor story. The product framing
   (provenance, not rank) has to resist this in copy and UI. Discipline
   risk more than code risk.
7. **Immutability is now opt in per project (resolved).** The artist
   chooses `ImmutableClone` (EIP-1167, no upgrade code, maximal
   credibility, the UI default) or `Upgradeable` (ERC1967 UUPS, owner can
   upgrade until they `seal()`). The tradeoff moves to the artist, and
   both stances are transparent onchain (`isUpgradeable`, `isSealed`).
   The residual risk: an upgradeable project's owner key is a power a
   collector is trusting. Surface the mode prominently so collectors mint
   with eyes open. See Open Question 10 for the upgrade authority detail.
8. **Mint hooks are artist owned, which scopes the risk but does not
   remove it.** A hook can revert and brick mints, or record misleading
   data. Because the hook is set by the project owner, the blast radius
   is that artist's own project, and collectors can read the hook
   address before minting. Keep hooks non payable in v1 so they cannot
   touch the honest pricing invariant, and guard the mint function
   against reentrancy. The tradeoff is real extensibility in exchange for
   a contract surface collectors should inspect.
9. **Honest pricing reduces impulse volume.** Removing the "free plus
   farm rewards" loop is the point, but PND will not see Zora scale mint
   numbers. The plan explicitly does not depend on volume. Expect lower
   raw counts in exchange for a real collector base.

---

## 10. Open questions to decide before implementation

**Resolved in this revision** (carried into the spec):

- Contract granularity: **one ERC721A per project**, factory deploys per
  project. A project holds one or more releases.
- Pricing: **artist set fixed price** (0 or any ETH), Mint's basefee
  float rejected.
- Surface Share: comes **out of the price**, `surface == 0` folds back
  to the artist.
- Metadata: **swappable renderer with built in CID fallback** (Zora
  style), plus per token CID override and artist supplied renderers.
  Fully onchain media supported via custom renderer.
- Per token art: a **contract capability** (frontend v1 uses shared
  art).
- Mint hooks: **pre and post**, owner set, non payable, magic value
  gated.
- Upgradeability: **opt in per project** (ImmutableClone default vs
  Upgradeable UUPS with `seal()`).
- `_startTokenId == 1`. Mint Marks stored per batch onchain and emitted.

**Still open:**

1. **Per transaction quantity cap.** Cap `quantity` per `mint()` call, or
   leave it unbounded (gas is the natural limit)?
2. **Surface allowlist.** Keep Surface Share fully permissionless
   (`surface == 0` fold is the only guard), or let an artist set an
   allowlist of accepted surfaces? Permissionless is simpler and more in
   keeping with "PND is not privileged".
3. **Token Path write authority.** V1 ships artist gated (release default
   plus per token override). Confirm holder writes stay reserved for a
   later version, and decide whether a set path is immutable or
   appendable.
4. **Release Graph edge set and mutability.** Is `BelongsTo / StudyOf /
   PhaseOf / Continues / Source / Access` the right v1 set? Append only
   is assumed.
5. **Royalties.** Confirm EIP-2981 per release in v1, artist set bps and
   receiver.
6. **Upgrade authority on Upgradeable projects.** Owner only (assumed),
   or add a timelock / second signer? Owner only is simplest and matches
   "artist owned", but a collector trusting an upgradeable project is
   trusting that key.
7. **Status and kind enums.** Confirm the lifecycle snapshot
   (`Open`, `Closing`, `Closed`) and the semantic kind set
   (`Standalone`, `Study`, `Phase`, `Access`, `Source`, `Continuation`).
8. **Hook scope.** Project default plus per release override is in the
   spec. Do you also want per token hooks, or is per release the right
   ceiling?

---

## 11. Build sequence

**Phase 0, specify, do not build.** `docs/pnd-editions-spec.md`:
`IPNDEditions`, `IPNDRenderer`, `IPNDMintHook`, `IPNDReleaseGraph`,
`IPNDTokenPath`, the Mint Mark batch model, the `Ref` URN format, the two
deploy modes. Resolve the remaining Open Questions, especially the
storage layout ones, because they shape the structs.

**Phase 1, core contracts.** `PNDEditions` (ERC721A, initializer based so
it works as both a 1167 clone target and a UUPS impl) plus
`PNDEditionsFactory` with the two deploy modes. Release struct,
`createRelease`, `mint` with the Surface Share split and per batch Mint
Mark recording, EIP-2981, the built in default renderer, and the mint
hook call sites. Foundry unit and invariant tests (no fork needed): exact
value payment, split math, cap and window enforcement, gas only path,
sequential ids, Mint Mark resolution by binary search, batch boundaries,
renderer fallback and per token CID override, hook before/after with the
magic value and revert gating, immutable vs upgradeable behavior and
`seal()`. This phase proves the thesis economics and the extensibility
surface.

**Phase 2, graph and path data layer.** Implement `addEdge` / `edgesOf`
and `setPath` / `pathOf` with events. Test cross contract `Ref`
addressing and append only semantics. Pointer layer only.

**Phase 3, indexing.** Add the fixed `PNDEditionsFactory` to Ponder for
discovery (like `mint_creators`). Extend the worker
(`apps/worker/src/tasks/scan-*` plus `scanners/*`) to scan discovered
clones for mints, Mint Marks, edges, and paths into `public` tables,
gated on `known_artists`. Register the platform in
`apps/web/src/lib/indexed-platforms.ts` and bump the three sync points
in AGENTS.md.

**Phase 4, collector mint flow.** Reuse the patterns already in
`MintEditionCTA` (decoded price, fresh reads, buffered value) but for
fixed ERC721A pricing: artwork, exact price, the visible split, gas, and
the Mint Mark preview. Never say "free".

**Phase 5, artist release creation flow.** Deploy or reuse contract,
create release, set price/share/cap/window/royalty/edges, publish.

**Phase 6, self host export (in v1, not after).** Extend
`templates/artist-page/` to `sovereign-artist-site` so the exported page
is a real mint surface passing the artist's `surface` address.

**Phase 7, read surfaces.** Release Graph view and token page, both
rendered from onchain/indexed data so they work in any interface.

**Phase 8, Preserve integration.** Auto enroll PND Editions media into
the existing pinning and CID availability signal.

V1 is realistically Phases 0 through 6, with 7 and 8 close behind.
Resist adding sale strategies, allowlists, premints, or any secondary
mechanic until the core thesis is live and a real collector base exists.

---

## Appendix A, how this hits the 10 combine goals

| Goal | How |
|---|---|
| 1. Fun, positive sum Zora energy | Cheap, impulsive, legible mints and a visible Mint Mark you receive, without the farming loop |
| 2. Mint Protocol seriousness | Opinionated, minimal, honest pricing, artifact first |
| 3. Artist owned contracts | One ERC721A per project, deployed and owned by the artist, immutable or upgradeable at their choice |
| 4. Honest pricing | Artist set price, exact split shown, never "free" for a paid mint, no protocol fee |
| 5. Crypto native surfaces | Wallet first, decoded txs, addresses visible, no custodial layer |
| 6. Mainnet release infrastructure | Mainnet only, real provenance, real persistence |
| 7. Release continuity | Release Graph edges between releases |
| 8. Self hosting | First class self host mint surface in v1 |
| 9. Onchain readability | Interfaces, events, and CID/onchain metadata readable by anyone |
| 10. Serves bodies of work | One contract as an artist's oeuvre, releases as chapters, not built for every poster |

## Appendix B, how this avoids the 10 Zora traps

| Trap | How PND avoids it |
|---|---|
| 1. Depends on mint volume | No rewards, no token, no farming, product is the contract not the count |
| 2. Calling paid mints free | "Gas only" for 0 ETH, exact price otherwise, enforced in copy and events |
| 3. PND mandatory center | Surface Share is artist set and capturable by any surface, PND never privileged |
| 4. Global feed as core | Feed is a side discovery surface, never the optimized product |
| 5. Forced liquidity | No AMM, no ERC20 wrap, no coin, value is not manufactured |
| 6. Referral as main behavior | Surface Share is an opt in revenue split, not an earn loop |
| 7. Designed for everyone | Built for crypto native artists with bodies of work |
| 8. Vague future utility | Token Path is a concrete pointer slot, not a promise, v1 ships only what it can honor |
| 9. Mint Marks as rarity | Provenance only, no traits, no rank, no floor framing, no leaderboard |
| 10. Self hosting deferred | Self host mint surface is in v1 |
