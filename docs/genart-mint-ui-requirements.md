# Generative Art Mint UI — Requirements & Best Practices

**Status: research/requirements only. No implementation yet.**

This document defines the *baseline standard* mint experience for PND Collection
protocol collections — the default UI every generative collection gets, covering
every lifecycle state. It is grounded in (a) a survey of the leading generative
art mint platforms (Art Blocks + Engine, Highlight, fx(hash), OpenSea Drops,
Zora, plus Alba / gm.studio / Verse), and (b) an audit of what the PND Collection
protocol and the existing `collection-web-v1` surface actually support today.

**Out of scope:** the Homage mint experience (`homage-gallery-mint-layout`
branch). That is a bespoke, curated full-page takeover for one project and must
not be touched. This doc is about the *sibling* concern: the standard surface at
`/collections/[address]` that works for any Collection without custom work.

---

## 1. Research summary — what "standard" looks like out there

Method note: Art Blocks, OpenSea, Zora, Highlight, and fx(hash) are all
client-rendered SPAs, so findings come from official docs, changelogs,
walkthroughs, and (for Art Blocks) the live discover-page data payload — not
rendered pixels. Claims the research could not verify are flagged inline below
and in §9. Take patterns here as evidence-weighted, not gospel.

### 1.1 Per-platform highlights

**Art Blocks** (the genre-defining baseline)
- Lifecycle is derived from flags (`paused` + `complete` + auction times), not a
  stored enum — same shape as our derived `Scheduled/Open/Closed`.
- Rich minter taxonomy maps mechanisms → UI: fixed price, allowlist (merkle,
  `maxInvocationsPerAddress`), hold-to-mint, Dutch auction (linear /
  exponential / with settlement + automatic rebate), ranked auction (RAM,
  uniform clearing price, anti-snipe extension), serial English auction.
- "Invocations" X of Y is the canonical scarcity display.
- Everything renders live from the onchain hash — no delayed reveal. During
  indexer lag after a mint burst, a placeholder (Chromie Squiggle) shows with a
  "live" link — graceful degradation, not an error.
- **Documented gaps (our opportunities):** no official pre-mint algorithm
  preview (collectors literally hand-edit hashes in CodePen to see unminted
  outputs), no "you minted #123" success moment (confirm in wallet → go find
  the token in your profile yourself), and the "Purchases Paused" button
  requires manual page refresh to flip live at drop time.

**Highlight** (strongest custom-site + reveal infrastructure)
- Pre-mint preview: a "Randomize" control runs the *actual algorithm* live with
  throwaway seeds, with the explicit caveat that previews "do not reflect the
  exact NFT you mint" (final seed comes from the tx hash).
- Reveal: a `highlight:token-revealed` JS event carries the final metadata so a
  page can render the collector's real output immediately, client-side, without
  an indexer round trip. Embeds can suppress the stock success modal and build
  fully custom reveals (Superchain Chiblings case study).
- Eligibility hierarchy: one mint page resolves what the visitor sees — signed
  out sees public sale; signed in sees the sales they qualify for, cheapest
  first, excluding ones where they've hit their per-wallet cap.
- Buyer-side mint fee is broken out as a visible line item before confirmation;
  a fee-oracle contract lets third-party embeds compute it exactly.
- Mint referral rewards with a share-link generator in the mint modal.
- Sale methods are stackable (public fixed price + gated discount in parallel).

**fx(hash)** (deepest preview/param conventions)
- The project page embeds a live running instance of the generator; collectors
  can roll unlimited preview variations.
- A formalized execution-context contract: the runtime tells the artist's code
  whether it is running as `standalone` (browsing preview), `capture` (headless
  thumbnail capture), or `minting` — code can adapt per context.
- The most itemized supply display found anywhere: total / collected /
  remaining / burned / **reserved for allowlist**, with an infinity glyph for
  open editions.
- fx(params): two-step ticket → parameter-tuning mint where the collector
  adjusts sliders/toggles with a live render, can lock individual params and
  reroll example seeds. (Beyond our v1, but the "reroll seed while params stay
  fixed" interaction is worth remembering.)
- "Features" (traits) must be PRNG-derived and match the rendered art — an
  explicit integrity convention.
- Known failure modes are named and documented: "waiting to be signed" stalls,
  indexer backlog delaying reveal under load.

**OpenSea Drops / Zora** (multi-phase drop mechanics, consumer polish)
- OpenSea: up to 5 presale stages + mandatory public stage, each with own
  price / per-wallet limit / allowlist. Signed-in users see per-stage
  **"ELIGIBLE"** or a grayed mint button with "You're not eligible for this
  mint stage." Per-stage allocations stack (presale limit + public limit).
- "Set reminder" (email + add-to-calendar) on upcoming drops.
- Fee breakdown lives behind an expandable "Summary" — progressive disclosure;
  gas is deferred entirely to the wallet's confirm screen (fx(hash) does the
  same, explicitly).
- Explicit warning surface: mint can fail if supply sells out mid-transaction;
  gas is not refunded.
- Zora: referral rewards make "who hosted the mint UI" a first-class economic
  actor (create-referral + mint-referral splits) — directly analogous to our
  `mintWithReferral` + 10% referral share. Onchain comments at mint time feed a
  live activity tab.

**Alba / gm.studio / Verse** (patterns worth stealing)
- Alba: supply broken into labeled sub-allocations shown together (general
  sale / reserves / artist proofs / platform), and keyboard controls on the
  live render (freeze/resume, save at low/HD/ultra resolution, metadata
  overlay toggle).
- gm.studio: "blind mint" framing — the output finalizes only at purchase;
  token-holder discount tiers baked into the primary sale.
- Verse: walletless onramp (custodial wallet + card payments) and white-label
  embeds for gallery-branded domains.

### 1.2 Cross-platform consensus (the actual baseline)

Every serious platform converges on:

1. **Live algorithm preview before mint** (Highlight, fx(hash), Alba — and Art
   Blocks' *absence* of it is a known pain), always with a "your final output
   will differ" disclaimer.
2. **No delayed reveal for generative work.** The output is deterministic from
   the seed; render it live the moment the seed exists. Delayed-reveal
   placeholder patterns are a PFP-world artifact, not a gen-art one.
3. **Above-the-fold clarity:** price, supply progress, phase/state, and
   per-wallet limits visible without scrolling; fees itemized but behind
   progressive disclosure; gas left to the wallet.
4. **Explicit per-state UI** for upcoming / gated / open / sold out / closed,
   with countdowns for scheduled transitions.
5. **Eligibility answered as early as possible** — after connect, before the
   user attempts a doomed transaction.
6. **A real post-mint moment**: show the collector *their* output, numbered,
   immediately, with a path to the token page and to the rest of the
   collection.
7. **Live collection browsing during the mint** (recent mints streaming in) as
   social proof and as the actual product — the collection *is* the artwork
   unfolding.
8. **Trust strip near the mint action:** contract address, chain, creator
   identity, immutability/lock status, license.

---

## 2. Protocol reality check — what our contracts actually support

The requirements below must map onto the Collection protocol as it exists on
`collection-web-v1` (audited baseline, pre-deploy). Key facts:

| Capability | Protocol reality |
|---|---|
| Lifecycle | Derived `Scheduled / Open / Closed` from `mintStart` / `mintEnd` / `supplyCap` + live minted count. Never stored. No "paused" state — but window/price/cap are **live-settable**, so status can move in *any* direction (an artist can reopen a closed window). |
| Mint entry points | `mint(quantity)` and `mintWithReferral(quantity, referrer, hookData)` — payable, sequential mode only. Pooled collections sell only via their authorized minter. |
| Payment | **Exact match** (`msg.value == price × qty`) when no price strategy is set → a stale displayed price reverts as `WrongPayment`. With a strategy: `>=` with pull-refund of excess. |
| Quantity limits | None in core. Per-wallet caps exist only via the hook slot (`PerWalletCapHook`). |
| Allowlist | Only via the single `mintHook` slot: `AllowlistHook` (merkle proof passed as `hookData`). **One hook at a time** — allowlist + per-wallet cap together needs a composite hook that does not exist yet. |
| Pricing presets | Stored fixed price only. `IPriceStrategy` slot exists but **no concrete strategy contract ships** (Dutch auction explicitly cut from v1). |
| Referrals | `REFERRAL_SHARE_BPS = 1000` (10%) protocol constant; referrer is a mint param; zero address folds the share back to the artist. |
| Seed / reveal | `tokenSeed` = keccak256(prevrandao, collection, tokenId, mintIndex) — the documented protocol standard (injection-convention § Seed derivation; recipient deliberately excluded). Not predictable before the mint block exists; the reveal needs one `tokenSeed` read after the receipt (or derivation from the receipt block's prevrandao). `Minted` event gives `firstTokenId`, `quantity`, `firstMintIndex`, `statusAtMint`. |
| Rendering | `GenerativeRenderer` assembles onchain HTML via scripty (`tokenURI` eth_call needs a dedicated ~300M-gas call). The **client-side parity renderer** (`apps/web/src/lib/collection-render/`, injection convention) renders the same output from `(seed, tokenId, collection, chainId, work)` with zero heavy RPC. |
| Permanence | Core owns exactly the state it controls: `lockSupply()` and `lockRenderer()` (one-way, optional — pins the renderer pointer). The work lock moved renderer-land: `GenerativeRenderer.lockWork(collection)`. Full presentation permanence = immutable renderer + locked pointer + locked work. (`freezeMetadata`/`isPermanent` were removed in 8ca23eb.) |
| Data layer | Collection indexing (`collections` / `collection_tokens` / `collection_mints`) is fully coded but **deploy-gated** — handlers never fire today. All web reads are pgCache-wrapped live RPC (config 20s, price 5s, history 30s). The indexer, once live, does **not** track ERC-721 `Transfer`s, so post-mint ownership needs live `ownerOf`. |

And what already exists in `apps/web`:

- `/collections` listing, `/collections/[address]` with `MintCollectionCTA`
  (quantity input, status dot, fixed vs strategy price with 12s poll, referral
  split bar, mint-mark preview, connect/switch/mint state machine,
  `TxSuccessBanner`), `GenerativeHero` (live parity render of latest seed, or a
  deterministic preview seed pre-mint), `RecentMintsGrid`, facts block,
  self-host snippet, `CollectionMintHistory`, `WithdrawPanel`.
- `/collections/[address]/[tokenId]` with `TokenMedia` (static, decoded from
  `tokenURI`), mint-mark card, seed card.
- Shared tx infra: `apps/web/src/components/tx/tx-ui.tsx` (`Countdown`,
  `TxSuccessBanner`, `formatWriteError`, `useChainNowSec`).

**Known gaps in the existing surface** (from the audit, confirmed against the
platform baseline): no post-mint reveal moment (generic success banner, no link
tying `firstTokenId` to a live render), token page shows static media instead
of the live parity render, no allowlist/eligibility UI of any kind, no
pre-mint preview exploration beyond the single deterministic hero seed, no
countdowns, no per-wallet-limit surfacing, no lifecycle filtering on the
listing page.

---

## 3. Requirements — lifecycle states

Priorities: **[M]** must have for v1 · **[S]** should have · **[C]** could
have / later.

The UI derives one presentation state from `config()` + minted count + hook
inspection. Because sale settings are live-settable, the state machine is
**non-monotonic**: every state must tolerate transitioning to any other on the
next read (e.g. artist extends a closed window → Closed back to Open). Never
cache a state as terminal unless the corresponding lock is set.

### 3.1 Scheduled (pre-mint)

- [M] Full project presentation before the mint opens: title, artist
  (attribution roster), description/statement, live algorithm preview (§4),
  price, supply, and the mint window.
- [M] Countdown to `mintStart` using chain-time (`useChainNowSec`), not client
  clock. On reaching zero, re-read config and flip to Open **without requiring
  a manual refresh** (Art Blocks' "keep refreshing until the button changes" is
  the documented anti-pattern here).
- [S] Calendar affordance ("add to calendar" .ics download). Email reminders
  [C] — requires backend we don't have and shouldn't build for v1.
- [M] If an allowlist hook is active for the opening phase, show it: "Allowlist
  mint" labeling and the eligibility checker (§5) live *before* the window
  opens, so collectors can verify their status ahead of the drop.
- [M] If `mintStart` is unset/zero-window edge cases arise, degrade to a clear
  "Not scheduled yet" presentation rather than a broken countdown.

### 3.2 Open (active mint)

- [M] Above the fold: price (with "+ gas" implied, never estimated in-page —
  consensus is to defer gas to the wallet), supply progress, quantity control,
  mint button, wallet/connect state.
- [M] Supply display, fx(hash)-grade itemization where applicable: minted /
  remaining out of cap; **∞ / "Open edition"** when `supplyCap == 0`; burned
  count if nonzero. Numeric "X of Y" is the primary display; a progress bar is
  [S] and only when a cap exists.
- [M] If `mintEnd` is set: countdown to close ("Mint closes in …"). The window
  end is as important as the start.
- [M] Live price handling: when a price strategy is set, poll `currentPrice`
  on the existing short-TTL cadence and label it as changing ("Current
  price"). When no strategy: display the stored price and rely on exact-match
  semantics (§6.3 covers the stale-price failure).
- [S] Recent mints streaming into the page (existing `RecentMintsGrid`,
  upgraded to refresh on an interval *while Open only* — never poll on
  Scheduled/Closed pages). Live-feed social proof is a consensus pattern
  (Highlight shipped it as a headline feature; OpenSea/Zora both have it).
- [S] Mint-velocity/"recently minted N minutes ago" microcopy [C]; keep it
  honest and derived from mint history reads we already make.

### 3.3 Closed — two distinct sub-states, never conflated

- [M] **Sold out** (`mintedEver >= supplyCap`): celebratory terminal framing —
  "Sold out · 400 of 400 minted", mint CTA replaced by collection-exploration
  CTA and (if applicable) secondary-market links. If `isSupplyLocked()`, this
  is genuinely terminal and may say so ("supply locked onchain").
- [M] **Window closed** (`mintEnd` passed, supply remaining): honest framing —
  "Mint closed · 213 of 400 minted". Because the artist can reopen the window,
  do not present this as permanent unless locks say otherwise.
- [M] In both: the page converts from mint page to *collection record* — the
  gallery, provenance facts, and token pages become the primary content. The
  page must remain a good permanent URL for the work after the mint is over.
- [S] Zora-style handoff note: where the work trades now (deferred until we
  decide what secondary links the baseline should carry — see open question
  Q4).

### 3.4 "Paused" and other operator-driven states

- [M] There is no protocol pause. When an artist effectively pauses by moving
  `mintStart` forward or `mintEnd` to now, the UI simply re-derives Scheduled
  or Closed. Requirement: config re-reads happen on focus/interval-while-open
  so operator changes propagate within the cache TTL (~20s), and the UI never
  wedges on a stale state.
- [M] **Pooled / sells-via-minter collections**: baseline page shows the
  collection record with a quiet "mints through its own minter" notice (exists
  today). No mint CTA. Custom minter UIs are out of baseline scope.
- [S] Surface `lockRenderer` / `lockSupply` (core) and the renderer-land work
  lock (`GenerativeRenderer.workLockedOf`) in the facts block as they land.

---

## 4. Requirements — algorithm preview / explore (pre-mint and always)

This is the defining feature of a *generative* mint UI versus a generic drop
page, and the parity renderer makes it nearly free for us — no RPC beyond the
work config we already read.

- [M] **Live preview, real algorithm.** The hero preview runs the actual work
  code client-side via the parity renderer with test seeds (the
  `testSeed`/`makeTestTokenData` machinery exists). Never a static mockup.
- [M] **Reroll control.** A "randomize" affordance generates a new test seed
  and re-renders. Collectors should be able to pull unlimited throwaway
  variations (fx(hash)/Highlight pattern; Art Blocks' absence of this is its
  most-cited gap).
- [M] **The disclaimer.** Every preview surface carries the standard caveat,
  verbatim-class copy: "Previews are example outputs. Your minted piece is
  generated from your transaction and will differ." Both Highlight and
  fx(hash) treat this as load-bearing copy, not fine print.
- [S] **Preview grid**: a small gallery of N deterministic sample seeds
  (derived from the collection address, as `GenerativeHero` already does for
  its pre-mint seed) so the page shows range at a glance without N iframes of
  cost — reuse the iframe-shared dependency fetch that `RecentMintsGrid`
  already implements.
- [S] Execution-context flag in the injection convention: tell the work code
  whether it's rendering as `preview` / `capture` / `token` (fx(hash)'s
  formalized contract). Needs a small injection-convention addition — flag for
  the renderer/docs owner rather than inventing it in the web layer. [C] if
  the convention change doesn't make the next contracts iteration.
- [C] Alba-style capture controls on the live render (freeze/resume, save
  PNG at resolution) — nice for animated works, not baseline.
- [C] fx(params)-style collector parameters — explicitly out of scope for the
  baseline; would be a custom minter + hook product later.

---

## 5. Requirements — gating, eligibility, and phases

Protocol reality: one hook slot, merkle `AllowlistHook`, `PerWalletCapHook`,
`HoldsCollectionHook`; no multi-phase scheduling primitive. The baseline UI
should handle **the single-hook cases perfectly** and stay honest about what
it can't know.

- [M] **Hook detection.** The UI reads `config().mintHook` and recognizes the
  known reference hooks by address/interface. Unknown hook → generic "This
  mint has additional onchain conditions" notice with the hook address linked,
  and mint attempts still allowed (the hook is the enforcement; the UI is the
  messenger).
- [M] **Allowlist eligibility check, pre-connect and post-connect.**
  - Post-connect [M]: connected wallet is checked against the list — green
    "You're on the allowlist" / "This wallet is not on the allowlist"
    (OpenSea's ELIGIBLE pattern). Shown in Scheduled state too (§3.1).
  - Pre-connect address paste-in checker [S]: lets a collector check any
    address without connecting (nobody does this well; cheap for us since
    the check is a local merkle lookup).
  - This requires **proof serving**: the merkle tree/leaves must be published
    somewhere the web app can read (Postgres via studio upload, or a static
    JSON the artist hosts). **Open infra decision — see Q1.** The UI
    requirement stands regardless of where proofs live.
- [M] **Proof passed transparently.** When eligible, `hookData =
  abi.encode(proof)` is built automatically; the collector just sees "Mint".
  Ineligible wallets get a disabled button with the reason — never a doomed
  transaction (OpenSea/Highlight consensus).
- [M] **Per-wallet cap surfacing.** When `PerWalletCapHook` is active: show
  "Limit N per wallet" beside the quantity control, clamp the quantity input
  to the connected wallet's remaining allowance (read from the hook), and
  show "You've minted your maximum" as the terminal state for that wallet.
- [M] **Holder gate surfacing.** When `HoldsCollectionHook` is active: "Requires
  holding <collection>" with a link, and a post-connect yes/no verdict.
- [S] **Phase timeline.** The protocol has no native phases, but an artist can
  run allowlist-then-public by swapping the hook (or pointing `mintStart` at
  the public open with the hook active before a swap). The UI should render a
  simple schedule ("Allowlist now · Public at <time>") **only when that intent
  is knowable** — which today means an offchain descriptor. Don't fake a
  timeline from data we don't have. See Q2.
- **Protocol gap to flag, not work around in the UI:** allowlist + per-wallet
  cap simultaneously requires a composite hook that doesn't ship. If launches
  need it (they almost certainly do — an allowlist without a cap invites
  sweeping), that's a small contracts work item, not a UI hack.

---

## 6. Requirements — the mint action

### 6.1 Quantity

- [M] Stepper (− / count / +) clamped by: remaining supply, per-wallet
  allowance when a cap hook is active, and a UI sanity max (e.g. 10) when
  nothing else binds. Default 1.
- [M] Total updates live: "3 × 0.05 ETH = 0.15 ETH". Label is always **"ETH"**
  (house rule: never the Ξ glyph).
- [S] "Max" affordance only when a small per-wallet cap makes it meaningful.
- [M] Mint-mark preview retained from the existing CTA ("Mints #14–16" / "You
  would hold the first token") — it's a distinctive, honest touch no other
  platform has.

### 6.2 Cost display

- [M] Price × quantity total, with the referral split visualization the CTA
  already has (artist / referrer bar). We have no buyer-side platform fee —
  say so plainly where platforms would show a fee line: the "honest pricing"
  story is a differentiator; one line, not a banner.
- [M] Gas: never estimated in-page. The wallet's confirm screen owns gas
  (unanimous platform consensus, and MetaMask's inflated-estimate failure mode
  on Art Blocks shows why duplicating it invites confusion).
- [S] Progressive disclosure for the breakdown (expandable row) once there is
  more than one line to show; until then inline is fine.

### 6.3 Button state machine

- [M] States: Connect wallet → Switch network (auto-switch prompt, wrong-chain
  never silently fails) → Mint (enabled) → Confirm in wallet… → Minting… →
  Success (§7) / Error. The existing CTA implements most of this; keep it.
- [M] Disabled-with-reason states: not eligible, wallet cap reached, sold out,
  window closed, insufficient balance for price×qty (a cheap client-side
  balance check before letting the user sign a doomed tx — [S] if it adds an
  RPC read; use the wallet balance wagmi already holds).
- [M] **Stale-price defense (exact-payment semantics).** Immediately before
  writing, re-read price (5s-TTL read is already the norm); if the strategy
  price moved, update and require one more click rather than sending a value
  that reverts `WrongPayment`. Surface a revert of this class as "Price
  changed — refresh and try again", not raw bytes.
- [M] **Sold-out-mid-tx.** If the receipt reverts on supply: "Sold out during
  your transaction. Gas is consumed on failed transactions." (OpenSea documents
  this exact case; be as blunt.)
- [M] Error surfacing walks the viem cause chain (`shortMessage` /
  `metaMessages` / nested `cause`) — never bare "Execution reverted". Map the
  protocol's named errors (`WrongPayment`, hook rejections, window/cap
  reverts) to human copy. `formatWriteError` exists; extend its mapping for
  Collection error names.

### 6.4 Referral

- [M] `mintWithReferral` with the page's referrer (PND's address on
  pnd.ripe.wtf; overridable for self-hosted pages — exists).
- [S] Highlight/Zora-style share-to-earn: a "share this mint" control that
  produces a URL carrying `?ref=<address>`, honored by the page as the
  referrer param. The protocol already pays 10% — surfacing it turns every
  collector into distribution. Needs a one-line trust decision (Q3).

---

## 7. Requirements — transaction feedback and the reveal

The reveal is the emotional payoff of a generative mint and our single biggest
architectural advantage: seed → parity renderer means we can show the
collector their actual piece seconds after confirmation, entirely
client-side. Art Blocks doesn't have this moment at all; Highlight needed a
custom event system to enable it. We get it almost for free.

- [M] **Pending:** in-page state from "Confirm in wallet…" through "Minting…"
  with the tx hash linked (evm.now, per house rule) as soon as it exists.
- [M] **Reveal:** on receipt, parse `Minted` (`firstTokenId`, `quantity`),
  read `tokenSeed` for each new token (the only unavoidable post-mint read —
  seeds are prevrandao-derived and cannot be precomputed), and render the
  piece(s) live via the parity renderer. Numbered: "You minted #14."
- [M] Multi-quantity reveal: grid of all minted pieces, each linking to its
  token page.
- [M] Reveal links: "View token" → `/collections/[address]/[tokenId]`, plus
  "Back to collection". The token page must exist and be good (§8.2) — the
  reveal is a doorway, not a dead end.
- [S] Graceful fallback: if the seed read or render fails, show mint-mark +
  "Your piece is minted — rendering shortly" with retry, never a broken frame
  (Art Blocks' placeholder-during-lag pattern, minus the indexer dependency).
- [S] Share affordance on the reveal (copies token URL; composes with §6.4's
  ref param).
- [C] Bespoke reveal theatrics (animations à la Chiblings) — that's what
  custom layouts like Homage's are for; the baseline reveal is clean and
  fast, not theatrical.

---

## 8. Requirements — collection exploration

### 8.1 During and after the mint (collection page)

- [M] The gallery of minted tokens is on the mint page itself (exists as
  `RecentMintsGrid`), live-rendered from real seeds, newest first, linking to
  token pages.
- [S] While Open: the grid refreshes so watchers see the collection grow.
  While Scheduled/Closed: static, zero polling. (RPC discipline: every
  interval must be gated on lifecycle state and page visibility.)
- [S] Full-collection browse with pagination once collections get large;
  server-side from mint history now, from the indexer tables once indexing is
  deploy-unlocked. **Do not build any feature that requires web-side log
  scanning** — pooled history already correctly returns `unsupported`.
- [C] Trait/feature filtering. Features are renderer-derived (fx(hash)-style
  PRNG-derived integrity), which means filterable traits require capturing
  each token's features into Postgres — worker/indexer work (the
  `collection_media` capture task is the natural home). Not v1.

### 8.2 Token page

- [M] **Live render, not static.** Replace/augment `TokenMedia` with the
  parity renderer (`TokenPreview`) as the primary view, with static
  `tokenURI` media as fallback/verification. This is the confirmed gap in the
  existing surface, and "the token page runs the real code" is table stakes
  on every gen-art platform (Art Blocks' Live view).
- [M] View modes: Live / Image (captured static) / fullscreen. The static
  image is the RenderAssets registry's per-token capture (else the collection
  cover) — deliberately refreshable, it mirrors rendered output and is not
  the art; label it accordingly. Details: mint mark (exists), seed with copy
  (exists), owner (live `ownerOf` — the indexer won't track transfers),
  features/attributes as reported by `tokenURI` metadata.
- [S] "Open in new tab" standalone live view (a shareable, chrome-less render
  URL — our equivalent of `generator.artblocks.io/...`).
- [S] Provenance block: minted-at (from event), mint index, `statusAtMint`,
  referrer if nonzero, tx link (evm.now).
- [C] Alba-style capture/save controls, keyboard shortcuts.

### 8.3 Listing page (`/collections`)

- [S] Lifecycle-aware sections: Minting now / Upcoming / Past (OpenSea's
  Live & Upcoming vs Past split), each card showing state, price, and
  progress. Today's flat recent-collections list is fine for v1 with a status
  chip per card [M].

---

## 9. Requirements — trust, provenance, and copy rules

- [M] Trust strip near the mint action: contract address (evm.now link),
  chain, artist attribution (roster exists), and immutability status —
  renderer pointer locked, work locked (renderer-land), supply locked — in
  plain language ("Artwork code locked onchain"; the honest three-part
  permanence story: immutable renderer + locked pointer + locked work). The
  existing Facts block covers most of
  this; the requirement is *placement*: a compact version near the CTA, full
  version below.
- [M] Royalty display (bps → "5%") and the no-protocol-fee line.
- [S] License display once the protocol/work config carries one — **it
  doesn't today**; flag as a metadata/work-config question (Q5) rather than
  inventing a UI field with no source of truth.
- [S] "How this works" disclosure: seed derivation, onchain render pipeline,
  self-host snippet (exists) — the "verify it yourself" story Art Blocks
  markets and Highlight documents.
- [M] **House copy rules** (from standing project rules, non-negotiable in
  implementation): "onchain" never "on-chain"; "ETH" never Ξ; no em/en dashes
  in user-facing copy; all tx/address links via evm.now with chainId; never
  name Foundation in marketing-adjacent copy.

---

## 10. Data & RPC discipline (constraints on all of the above)

Standing rule: minimize RPC; indexer/cache first. Concretely for this surface:

- [M] All reads through the existing pgCache'd server reads
  (`collection-onchain.ts` TTLs: config 20s, price 5s, history 30s). New
  client-side reads require explicit justification; default is server-cached.
- [M] Polling only while it matters: price poll only when a strategy is set
  AND state is Open AND tab visible; recent-mints refresh only while Open;
  countdowns are client-side timers off chain-time, not repeated reads.
- [M] `tokenURI` reads stay on the dedicated high-gas call path, never
  multicalled, and are needed only for the token page's fallback/verification
  view — previews and reveals use the parity renderer (zero heavy RPC).
- [M] Reveal costs exactly: one receipt wait + one `tokenSeed` read per
  minted token (multicall them for multi-quantity).
- [S] When collection indexing is deploy-unlocked, migrate gallery/history
  reads from RPC reconstruction to `collection_tokens`/`collection_mints`
  queries; the UI layer should be written against the read-function
  interface, not the transport, so this swap is invisible.

---

## 11. Gap analysis — existing surface vs this spec

| Requirement | Exists today | Gap |
|---|---|---|
| Lifecycle states on collection page | Status dot + label in CTA | No countdowns; no distinct sold-out vs window-closed framing; listing has no status |
| Pre-mint algorithm explore | Single deterministic hero seed | No reroll control, no preview grid, no disclaimer copy |
| Allowlist / eligibility | Nothing | Entire §5: hook detection, checker, proof serving (needs infra decision Q1) |
| Per-wallet limits | Nothing | Cap-hook read + quantity clamp + messaging |
| Quantity + price + referral split | Yes (CTA) | Stepper polish, balance pre-check, stale-price defense on click |
| Error surfacing | `formatWriteError` generic | Map Collection protocol errors to human copy |
| Reveal | Generic `TxSuccessBanner` | Entire §7: seed read + live render + numbered moment + links |
| Token page live render | Static `TokenMedia` | `TokenPreview` as primary view; standalone live URL |
| Gallery during mint | `RecentMintsGrid` (static) | Open-state refresh; pagination later |
| Trust strip | Facts block (below fold) | Compact version adjacent to CTA |

## 12. Protocol / infra work this spec implies (not UI work)

1. **Composite hook** (allowlist + per-wallet cap) — near-certain launch
   requirement; small contract, needs the standard review/audit path.
2. **Allowlist proof pipeline** — where artists upload lists, where the tree
   is built, where the web app reads proofs (studio flow + Postgres is the
   natural shape). (Q1)
3. **Phase/schedule descriptor** — offchain metadata making "allowlist now,
   public later" renderable. Could fold into the same studio flow. (Q2)
4. **Injection-convention execution context** (`preview`/`capture`/`token`) —
   small, valuable, best done before many works are authored. (renderer/docs)
5. **Feature/trait capture** into Postgres for filtering — worker follow-on to
   `collection_media`. Not v1.
6. **Indexer deploy-unlock** — already coded; gallery scale-out waits on it.
7. **Optional onchain preview extension on renderers** — a view like
   `previewURI(collection, tokenId, seed)` on `GenerativeRenderer` (and an
   optional interface renderers may implement) so previews are a pure function
   of chain state like the live view itself. Renderer-land only, core
   untouched. The web hot path still previews via the client parity renderer
   (tokenURI-class eth_calls are 60-120M gas); this is the canonical,
   verifiable capability for integrators and self-hosted pages. Recommended —
   see the preview discussion accompanying this doc.

## 13. Open questions (for Dave)

- **Q1 — Allowlist proof serving:** studio-managed (artist uploads addresses,
  we store tree + serve proofs from Postgres) vs artist-hosted JSON the page
  fetches? Studio-managed is the better long-term answer (one flow, works for
  self-hosted pages via API) but makes PND infra a dependency of eligibility
  checks.
- **Q2 — Phase intent:** are multi-phase launches (allowlist → public) a v1
  requirement? If yes, the schedule descriptor (item 3 above) moves into
  scope; if v1 launches are single-phase, §5's phase timeline is deferred.
- **Q3 — Referral links on the baseline page:** honor `?ref=` from anyone
  (open referral, Zora-style) or only surface PND/self-host referrers? Open
  referral is more aligned with the protocol's design but changes who the
  split bar shows.
- **Q4 — Secondary-market links post-close:** should the baseline link out
  (OpenSea et al.) after mint-out, or stay marketplace-agnostic?
- **Q5 — License:** does license belong in work config / metadata? No source
  of truth exists today; every surveyed platform displays one. Post-8ca23eb
  the natural home is renderer-land (WorkConfig or contractURI), not core.

---

## Appendix: source reports

Full research reports (platform-by-platform detail, source URLs, and explicit
unverified-claims lists) were produced by four research passes: Art Blocks +
Engine, Highlight + fx(hash) (+ Alba/gm.studio/Verse), OpenSea Drops + Zora
(+ general drop-UX writeups), and the repo/protocol audit. The condensed
findings are in §1–§2; the per-claim caveats worth remembering:

- All five major platforms are client-rendered SPAs; research is docs-derived.
  Before copying any *specific* visual treatment (quantity stepper widgets,
  success-modal layouts, phase-timeline visuals), a live click-through of one
  or two reference mints is worth an hour.
- Zora's fee/reward numbers span two eras (0.000777 → 0.000111 ETH); don't
  cite either without rechecking.
- Highlight's collector-facing "Randomize" control is inferred from creator
  tooling + marketing copy; the creator-side control is documented, the
  collector-side one wasn't directly observable.
