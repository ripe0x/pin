# PND Collection System

> **Status: built, pre-deploy; SVG-first launch prep (updated 2026-07-09).**
> The core is one OZ ERC721, `Collection` + `CollectionFactory` (renamed from
> `SovereignCollection`), audited at the `43f4ae7` baseline by two independent
> reviews. All work now lives on **`collection-web-v1` (PR #134, OPEN, not yet
> merged to `main`)**, which on top of that baseline adds: the full web/studio
> surface (create wizard, mint pages, discovery), a **multi-admin** access
> delta (owner + flat, full-access admins via `addAdmin` / `removeAdmin`, owner
> stays the keyring root), and terminology renames (`mintToId`, `referral`).
> The collection suite is 202 unit tests + opt-in mainnet-fork probes, green.
>
> **The multi-admin delta is UN-REVIEWED and is the deploy gate.** Before the
> immutable mainnet deploy it needs an external review covering the core + the
> admin delta + the launch project's SVG renderer, plus a one-line
> `isAdmin(owner)` fix (planned, not yet in code). The running review log is
> `docs/pnd-collection-reaudit-notes.md`.
>
> **The first launch project is all-SVG**, so the HTML-generative thumbnail
> problem does not gate it. That work (a MURI preservation overlay + client-side
> capture; needs a small shared MURI operator adapter) is deferred post-deploy
> and tracked in `ripe0x/pin#138`; `docs/pnd-collection-thumbnails.md` is the
> design but is partly stale vs that issue. Indexer/worker enablement and Phase
> 5 minters (BackedMinter/PooledIdMinter) remain gated. Deploy is scripted:
> `DeployCollectionSystem.s.sol` for the singletons, then the project renderer +
> collection via script (the studio create wizard exists but is unverified, so
> it is NOT the launch path).
>
> This document supersedes the *framing* of `docs/pnd-editions-*.md`:
> Editions is one preset of the general collection core, which moved
> from ERC721A to OZ ERC721; `contracts/src/editions/` was removed.

## 1. What we're building

A modular collection protocol plus the product around it, letting PND
artists ship three kinds of work on contracts they own:

1. **Editions**: the existing PND Editions product, unchanged in
   behavior, now as a preset of the general core.
2. **Generative collections**: Art Blocks-style long-form (algorithm +
   mint-time seed, code stored onchain, rendered from chain data alone),
   deployable from the studio with no Solidity.
3. **Network-based and backed works**: the forms PND's own artist has
   been hand-building for years: works that read live chain state
   (Homage to the Punk), works holders act on (TBAM's locks), works that
   escrow ERC20 value and redeem (Homage's $111 backing). These become
   stock modules instead of bespoke one-offs.

The one-line pitch to artists: **Art Blocks-grade permanence,
roll-your-own-grade ownership, minted from your own site, no committee,
no Solidity.**

Nothing here is novel cryptography, deliberately. Scripts onchain,
mint-time seeds, and HTML assembly are proven patterns (Art Blocks,
scripty.sol). The novelty is who can access that tier and who owns each
piece: the artist owns the contract, the code, the mint venue, and, when
they host the mint themselves, the platform's share of the sale.

## 2. Design principles

Each of these was argued to a conclusion; the reasons matter as much as
the rules.

- **One dumb core, four slots.** The base contract holds ownership,
  money paths, and provenance, and nothing else. All variability lives
  in swappable modules (minter, price, renderer, hooks) and optional
  per-work companion contracts. No work, however exotic, adds a line to
  the core.
- **OZ ERC721, not ERC721A.** Burn-then-remint is a hard requirement
  (Homage's redeem returns ids to the pool) and ERC721A's burn tombstone
  is permanent by design. 721A's only real benefit is batch-mint gas,
  worth roughly a dollar or two per multi-mint at current gas. OZ is the
  most-audited token code in existence, allows re-minting a burned id
  natively, and deleting the 721A batch machinery (MintBatch, batch
  heads, per-batch entropy derivation) simplifies the spec and audit.
- **Value custody never leaves the core on the built-in path.** Price
  strategies are views; hooks are non-payable. A custom pricing curve
  cannot introduce a theft or reentrancy path. Works whose economics ARE
  the medium use the extension-minter path instead, explicitly.
- **The base is a default, not a gate.** Three tiers: preset (no
  Solidity), base + modules, fully bespoke consuming the rails a la
  carte. Bespoke works that prove out graduate into templates and
  modules; they are the R&D pipeline, not exceptions.
- **Compose with existing commons; build nothing that exists.** Code
  storage and HTML assembly are scripty v2 / EthFS (already deployed,
  already used by TBAM). Artist attribution is Catalog.sol (already
  deployed). Media permanence anchoring is MURI (already deployed).
- **Art layer separate from commerce.** Rendering is a pure onchain view
  anyone can call forever; a token's live view is computed from chain
  data, not served by anyone's infrastructure. If PND disappears, every
  work still renders.
- **Cut until it hurts.** Decisions made along the way: no
  token-contract-agnostic seed binder (all cost, hypothetical benefit),
  no separate WorkRegistry in v1 (work config lives on the collection;
  a registry is cleanly retrofittable later if the
  "declare a work independent of any sale" preservation product earns
  it), no dutch-auction strategy in v1 (the price slot is justified by
  TBAM's dynamic pricing; implementations are additive forever), no
  second token variant (one OZ core with an id-mode flag).

## 3. The onchain system

```
SINGLETONS (deployed once, ownerless)
  scripty v2 / EthFS (exists)     GenerativeRenderer      SVGRenderer
  code + dependency bytes         scripty HTML assembly   abstract base
                                  + injection convention  for Solidity SVG

COLLECTION LAYER (per artist, via factory)
  CollectionFactory ── clones ──► Collection (the core)
    fixed: OZ ERC721, sale states, 10% surface share,
           per-token Mint Mark + entropy → tokenSeed(),
           work config (set at init, lockable), graph refs,
           id mode: sequential | pooled (set at init)
    slot: renderer       (GenerativeRenderer | SVGRenderer | custom)
    slot: priceStrategy  (FixedPrice | custom, view-only)
    slot: minter         (built-in path | authorized extension minters)
    slot: mintHook       (beforeMint/afterMint, non-payable)

MINTER EXTENSIONS (all economics live here)
  FixedPrice built-in path (v1)
  BackedMinter + escrow vault (fast-follow): ETH → coin swap or direct
    deposit, per-token escrow, redeem = burn + principal (exit fee param)
  PooledIdMinter (fast-follow): Fisher-Yates draw over an id pool,
    tokenId == sourceId, redeem returns the id to the pool for re-mint

COMPANIONS (per work, optional, artist-deployed)
  lock registries, attestation boards, satellite contracts; written to
  by holders, read by renderers and price strategies, linked by graph

RAILS (serve every contract, including bespoke)
  Catalog.sol (deployed): artist → works claims
  Attribution (new singleton, Catalog idiom): works → artists roster
    confirmed attribution = roster entry ∩ the artist's own Catalog claim
```

### 3.1 Collection core

Rewritten from `contracts/src/editions/PNDEditions.sol` with salvage:
the payment split, hooks interface, sale states, and graph carry over;
the token layer is new.

- **OZ ERC721** with two mint paths: the built-in path (assigns
  `nextId++`, takes payment, enforces surface share) and a role-gated
  `mintTo(recipient, tokenId)` for authorized extension minters. An
  init-time flag sets the id mode: sequential collections never accept
  minter-supplied ids; pooled collections require them. Approval-gated
  `burn(tokenId)`; OZ semantics make a burned id re-mintable, which the
  pooled form depends on.
- **Entropy**: one `bytes32` stored per token at mint
  (`keccak(prevrandao, address(this), tokenId, minter)`), exposed as
  `tokenSeed(tokenId)`. In the core because it can never be
  retrofitted: randomness only exists at mint time. Proposer influence
  on prevrandao is acknowledged in the spec; acceptable for art,
  disqualifying for lotteries.
- **Mint Marks**: per-token, one packed slot (`mintBlock` uint48,
  `surface` address, `status` uint8), replacing the ERC721A per-batch
  machinery. A re-minted pooled id is a new instance: fresh mark, fresh
  entropy, fresh escrow; the prior instance's history persists in events
  and the indexer.
- **Surface share**: unchanged from the Editions spec. A fixed 10% of
  the price to whoever hosts the mint; folded back to the artist on a
  direct or self-hosted mint. No other protocol fee. On the
  extension-minter path this becomes convention rather than contract
  guarantee: PND-shipped minters honor it; a custom minter is the
  artist's visible, onchain choice.
- **Work config**: init-time fields on the collection, lockable by the
  artist: script refs (scripty v2 storage pointers, or URI + content
  hash for oversized code), dependency refs, render spec (aspect ratio,
  library versions, injection version, liveness tier). For
  Solidity-rendered works this config is empty: the renderer contract
  IS the work.
- **Liveness tiers**, declared in the render spec, keep the
  preservation story honest: `pure` (seed only, archival-deterministic),
  `chain-live` (reads declared contracts; Homage, zorb-style works),
  `external-live` (reads declared URLs; honest about fragility). A live
  work's archival form is explicitly "code plus inputs at time T".

### 3.2 Renderers

The slot interface is `tokenURI(address collection, uint256 tokenId)
returns (string)`, with the collection passed explicitly (a deliberate
amendment to the editions spec's msg.sender pattern) so one shared
renderer serves every collection and bespoke contracts can adopt it.
Renderers are onchain views with full EVM read access: they can read
the seed, the current owner, sibling tokens, companion state, foreign
contracts, and block state. That single fact is what makes
network-based works possible; Art Blocks' renderer is an offchain
sandbox with two inputs.

- **GenerativeRenderer** (default, singleton): reads the collection's
  work config and seed, assembles a complete HTML page as a data: URI
  via ScriptyBuilderV2 (gzipped deps + injected context + artist
  script), wraps it in tokenURI JSON with `animation_url`.
- **SVGRenderer** (abstract base): JSON envelope, base64, attributes
  handled; an artist's custom renderer reduces to one function,
  `svg(tokenId, seed, state)`. Solidity SVG is the gold preservation
  tier: no JS runtime, no browser drift, renders in anything that
  parses SVG. SVG works also mostly skip the capture worker since
  `image` renders natively everywhere.
- **The injection convention** (a written spec, load-bearing): the
  context object (`tokenId`, `seed`, declared live values) injected
  identically by the onchain assembler, the studio previewer, the mint
  surface, and the artist-site embed, plus determinism rules for `pure`
  works (no network, no time, seeded PRNG) and a provider-bridge
  convention so chain-live HTML works can read the chain from the
  viewer's browser via any RPC. This replaces the Express servers and
  cron jobs PND's own artist currently runs for dynamic works.

### 3.3 Minters

All value motion beyond the built-in fixed-price path lives in minter
extensions, authorized explicitly per collection by the artist.

- **BackedMinter + vault** (one audit, reusable by any collection):
  mint takes ETH and swaps via a configured route, or takes the coin
  directly; deposits per-token backing into the vault; calls `mintTo`.
  Redeem: ownership check, burn, principal released minus exit fee.
  Parameterized: coin, amount, route, fees. Guardrails at launch
  (vetted-coin list or liquidity checks) against fee-on-transfer and
  thin-pool failure modes. This turns "ERC20-backed" from a bespoke
  achievement into a checkbox, composable with any form: backed
  generative, backed editions.
Hooks run on ALL mint paths, built-in and extension, so policy composes
orthogonally with economics: a backed drop with an allowlist phase is
BackedMinter plus the stock merkle hook, not a minter that reimplements
gating.

- **PooledIdMinter**: owns the id pool and Fisher-Yates draw,
  `tokenId == sourceId` preserved (pooled id mode), redeem returns the
  id for a future draw. Combined with BackedMinter and a chain-live
  renderer with a source-reader adapter (`ISourceReader`, needed
  because sources like CryptoPunks are not ERC721), the Homage form
  decomposes entirely into stock modules.

### 3.4 Companions

A pattern, not protocol: small per-work contracts holders write to
(locks, attestations, votes) and renderers/price strategies read. The
core meets them only through afterMint notifications and graph refs.
Reference implementations (a lock registry, an attestation board) ship
after launch so tier-2 artists compose rather than write. TBAM is the
reference case: per-block re-rendering, lock-to-freeze, a satellite
ERC1155 spawned per locked frame, price as f(basefee, locks).

## 4. The forms it supports

| Form | Composition | Reference |
|---|---|---|
| Edition | preset: sequential + FixedPrice + static renderer | PND Editions |
| Long-form generative | preset: sequential + FixedPrice + GenerativeRenderer | any p5 artist |
| Onchain SVG work | sequential + custom SVGRenderer | zorbs, dithers |
| Participatory / evolving | + companions + custom price strategy | TBAM |
| Live-derivative, backed, pooled | + BackedMinter + PooledIdMinter + chain-live renderer | Homage |
| Fully bespoke | own contract + rails a la carte (renderer interface, catalog, mint surface, graph) | Homage v1 as shipped |

Art Blocks' entire catalog fits row two. Rows three through six are the
forms it structurally cannot express.

## 5. The offchain product

The Solidity is the deed; this is the product. Most of the effort lives
here, and most of the rails already exist (studio shell, generic mint
surface, worker, indexer, artist-page template, Catalog).

1. **Studio flow** (the biggest chunk): upload script, chunked scripty
   storage transactions, test-seed preview harness, configure form
   preset, deploy via factory, batch Catalog claim in the same flow.
2. **JS parity renderer library**: one implementation of the injection
   convention shared by studio preview, mint surface, and the
   artist-site embed, so preview, artist site, and chain render
   identically.
3. **Mint surface**: a generative descriptor type for the existing
   generic mint surface, with live per-mint rendering.
4. **Capture worker**: headless rendering for HTML works (thumbnails,
   OG images; ephemeral convenience compute, reproducible by anyone);
   cheap server-side rasterize for SVG works.
5. **Artist-page template embed**: the same renderer component in the
   sovereign site template, so collections mint and render on the
   artist's own site with zero PND dependency.
6. **Discovery indexing**: the factory deploy event is the single hook,
   following the existing fixed-contract pattern.

## 6. Why this, and the revenue answer

- **The gap**: today, sovereign-tier generative work (own contract,
  code onchain, no platform) requires being a Solidity developer.
  Platforms provide tooling but keep something load-bearing: the
  contract, the code hosting, the render infrastructure, the venue, a
  curation gate. Nobody sells the middle. PND's known artists are
  exactly the population stuck in that gap.
- **The asymmetry**: for PND this product is small because PND already
  built everything around it (catalog, studio, indexer, sites, artist
  relationships). For anyone else it is enormous. Forking the contract
  gets a competitor none of the system it plugs into.
- **Revenue without breaking the no-fee origin**: PND's promise was
  zero rent, not zero revenue: no platform standing between artist and
  collector. Auctions and secondary stay at zero. The surface share
  pays whoever actually hosts a mint, and the artist keeps it on their
  own site. Generative drops are where that share is material (higher
  price points, mint-window velocity), and comparable platforms charge
  5 to 10 percent unconditionally. Stated openly: drops through PND's
  surface fund the free auctions, indexing, and preservation tooling.

## 7. What exists today

- **Deployed and done**: Catalog.sol, scripty v2 / EthFS, MURI, the
  studio shell and tool registry, worker + indexer, artist-page
  template pipeline. (The generic mint surface lives on the unmerged
  `generic-mint-surface` branch with the Homage launch work; it is not
  on main, and collection descriptor integration is deferred until it
  merges. See docs/pnd-collection-web-plan.md.)
- **Exists, gets reworked**: the editions contracts (846 lines:
  PNDEditions.sol, factory, types, default renderer, hooks) and their
  fork-test suite; the spec docs.
- **Reference works**: Homage (bespoke, mid-launch, ships as-is,
  unaffected) and TBAM, which become the documented tier exemplars.

## 8. Work plan

### 8.1 Rework (blocks everything, including the Editions deploy)

- PNDEditions core rewritten as **Collection** on OZ ERC721: delete
  the ERC721A batch machinery, add per-token marks + entropy, the
  minter slot (`mintTo`/`burn` roles, id-mode flag), the price strategy
  slot, and the explicit-param renderer interface. Salvage the payment
  split, hooks, sale states, factory, and port the fork tests.
- Rename: contracts, directory (`contracts/src/collection/`), docs.
  "Editions" survives as a studio preset name only. Do not reuse
  "Releases" (taken by the Releases v1 protocol).
- Roughly 1 to 2 weeks of contract work plus test porting.

### 8.2 New contracts, v1

- GenerativeRenderer (scripty orchestration): up to a week.
- SVGRenderer abstract base: about a day.
- Injection convention spec document: a day to write.
- FixedPrice built-in path: part of the core rework.

### 8.3 Fast-follow (gated on Homage proving the form)

- BackedMinter + vault: the one genuinely new audit surface, 1 to 2
  weeks of careful work; where external review money goes.
- PooledIdMinter + ISourceReader adapters (punks, vanilla 721).
- Reference companions (lock registry, attestation board).
- Optional later: a WorkRegistry singleton for declare-before-mint
  preservation, if that product earns it (cleanly retrofittable).

### 8.4 Offchain, roughly parallel

- Studio generative flow: 2 to 4 weeks.
- JS parity renderer lib: about a week, shared three ways.
- Mint surface descriptor + live preview: days.
- Capture worker (headless HTML path): about a week.
- Artist template embed + factory discovery indexing: about a week
  combined.

### 8.5 Decision record (Phase 0, locked 2026-07-06)

- **Immutable EIP-1167 clones, no UUPS.** The slots and companions
  carry all variability; immutability deletes the proxy, upgrade, and
  seal surface from the audit and is the stronger trust story. Core
  evolution happens by factory-offered versions; deployed collections
  never change. Consequence: the editions upgrade test suite is
  retired, not ported.
- **FixedPrice is a stored field, not a contract.** The collection
  holds a `price` used when the strategy slot is unset; a set
  `IPriceStrategy` overrides it. Simple collections deploy nothing
  extra; TBAM-shaped pricing plugs in by setting the slot.
- **Hooks run on all mint paths**, built-in and extension `mintTo`,
  so gating composes with custom minters instead of being
  reimplemented inside them.
- **Interface names**: `ICollection` (view surface:
  `tokenSeed`, `mintMarkOf`, `workConfig`, sale state),
  `IRenderer` (`tokenURI(address collection, uint256 tokenId)`),
  `IPriceStrategy` (`priceOf(collection, minter, qty, data)`, view),
  `IMintHook` (`beforeMint`/`afterMint`, non-payable, magic-value
  gated, carried from the editions spec).
- **Naming**: contracts carry no PND prefix, since PND is a
  stepping stone and the contracts must outlive it. The core family is
  `Collection` / `CollectionFactory`, consistent with
  the existing `SovereignAuctionHouse` and the sovereign-artist-site
  template. Singletons stay unprefixed in the Catalog idiom
  (`Attribution`, `GenerativeRenderer`, `SVGRenderer`).
- **Extension-path surface share**: convention plus an official,
  reviewed minter set surfaced by the studio. PND-shipped minters
  honor the share in code; a custom minter is the artist's visible,
  onchain choice.

Still open (gates Phase 5 only, not v1): BackedMinter launch
guardrails (vetted coins vs permissionless with liquidity checks).

### 8.6 Timeline

Roughly **2 to 3 months to a launched v1**: the rewritten core
deployed, Editions and studio-deployable generative collections live on
it, both renderers, fixed pricing. Backed/pooled minters follow
Homage's demand signal. Homage itself ships bespoke now, on its own
contract, and becomes the tier-3 reference implementation.

## 9. End state

An artist opens the studio, uploads an algorithm or points at a
renderer contract, watches test seeds render exactly as they will
onchain, and deploys a collection they own in one transaction,
cataloged under their address, minted on pnd.ripe.wtf and on their own
site, where they keep the surface share. The code lives in shared
onchain storage; the seed is stamped at mint; the live view is a pure
function of chain state that anyone can evaluate forever. Holders can
act on works, works can read the network, and value can live inside
tokens, all through modules that never touch the audited core.

PND ends up as the steward of rails and the first surface over them,
not the owner of a platform. Every collection outlives the frontend
that launched it. The forms PND's own artist had to hand-build three
times (live-reading, participatory, backed) become checkboxes for
artists who will never write Solidity, and the bespoke works that
come next are not exceptions to the system; they are where its next
modules come from.
