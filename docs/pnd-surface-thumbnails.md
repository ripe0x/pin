# PND Surface System: thumbnails and cover images

> **Status: design current as of 2026-07-13; contract mechanics shipped,
> offchain capture tooling not yet built.** Companion to
> `docs/pnd-surface-system.md` (§5.4, the capture worker) and
> `docs/injection-convention.md` (the capture spec in §3.1 below should
> be mirrored into injection-convention v2 so the onchain assembler,
> studio, mint surface, and artist embed all agree on the canonical
> frame). This document was rewritten after the 2026-07 restructure:
> the core stores NO presentation data, so everything here lives in the
> **RenderAssets** singleton (cover + per-token captures + capture
> template + the narrow capturer role) read by `DefaultRenderer` and by
> `ScriptyRenderer` when wired. References to `artworkURI` /
> `setTokenArtwork` / `freezeMetadata` / `GenerativeRenderer` in earlier
> revisions are historical; those mechanisms were removed from the core.

## 1. The problem

An HTML generative work renders live from `animation_url`. Marketplaces,
wallets, social embeds, and OG cards want a static `image`. The SVG tier
gets this for free (the SVG is the image). The HTML tier does not: making
a raster thumbnail means running the artist's code in a browser and
grabbing a frame.

**These are two different surfaces, and both matter.** On OpenSea and
every other marketplace, the `image` field drives the gallery grid, the
search result, the wallet list, and the collection page tiles;
`animation_url` drives only the interactive detail view. For a
generative collection each token is visually unique, so the gallery
`image` must be **that token's own rendered frame**. A single shared
cover across the whole collection is therefore not an acceptable steady
state: it makes every cell in the grid identical and erases exactly the
per-token variation that is the point of generative work. Per-token
`image` is a requirement for this tier, not an enrichment. The cover is
only a pre-mint placeholder and a degraded, explicitly-temporary
fallback for the window before a token's real frame lands.

That splits into three problems wearing one coat:

- **A. Compute.** Run the code and rasterize a frame.
- **B. Storage.** Put the bytes somewhere durable.
- **C. Pointer.** Make `image` resolve to them, onchain.

The "outlives PND" promise is threatened by B and C. Compute (A) can be
run by anyone, any number of times, and for a deterministic work it
always yields the same frame, so who runs it does not matter.

**The economic constraint (the load-bearing one).** PND must not become
the thumbnail utility for the whole protocol. If an artist mints on their
own site and keeps the surface share, PND earns nothing on that sale and
must therefore spend nothing on it: no compute, no storage, no gas. The
cost of a thumbnail has to follow the revenue, not pool on PND. Any
design where "PND runs a render farm for every sovereign collection" is
wrong, because it makes the successful sovereign-site path (the whole
point of the system) an uncompensated liability.

## 2. Principles

- **Compute follows revenue.** Whoever hosts the mint, and thus earns the
  surface share, runs the capture. It happens client-side, in the browser
  that is already rendering the live preview, so it is near-free.
- **Storage is a purchase, not a subscription.** The default home for a
  capture is one-time permanent storage (Arweave, via the same Irys path
  Editions already uses): pay cents once at capture time, served by any
  gateway forever, content-addressed, nobody on a recurring bill and
  nothing for anyone to custody. "The artist owns their storage" must not
  quietly mean "the artist maintains a subscription" — a missed renewal
  should never dark a collection's thumbnails. Storacha UCAN remains the
  delegated-write rail where a pinned space fits better; the principle
  is that whoever hosts the mint pays the one-time cost out of the share
  they just earned, and their obligation ends at that transaction.
- **The onchain tokenURI always self-resolves to at least a cover.**
  `image` is never dependent on an offchain API. This is the sovereignty
  floor: if PND vanishes, every token still resolves a real image from
  chain data plus permanent storage.
- **Captures mirror the art; they are not the art.** RenderAssets keeps
  them refreshable forever, deliberately. The art's permanence is the
  collection's `lockRenderer()` plus the renderer's own immutability;
  a thumbnail is a convenience copy of output that is already permanent.
  This is also what makes the narrow capturer role safe to hand out.
- **Determinism makes it reproducible.** A `pure` token's frame is a
  function of onchain data (script bytes plus seed). Anyone can
  regenerate it, so no single party is load-bearing for preservation —
  even a fully abandoned collection can be re-enriched later by a
  stranger with a browser.
- **No headless browser server in v1.** All HTML capture is client-side
  (studio at deploy, mint surface at mint, studio backfill after). PND
  adds no playwright/puppeteer to the worker image. The worker's HTML
  path stays parked.

## 3. The format

### 3.1 Canonical capture spec (mirror into injection-convention v2)

Every surface that captures a token must produce the same frame, or the
"anyone can reproduce it" guarantee breaks. The spec:

- **Frame.** A single frame taken after a deterministic warm-up: N draw
  frames or M ms of virtual time, declared per work in the work's render
  params (default: the first stable frame the harness detects). Time is
  virtual and seeded, never wall-clock.
- **Size.** Fixed from the render spec aspect ratio at
  `devicePixelRatio = 1`; default 1200px on the long edge, matching the
  worker's existing SVG rasterize target.
- **Format.** PNG, no alpha; flatten onto the work's declared background.
- **WebGL.** The renderer must be constructed with
  `preserveDrawingBuffer: true` so the canvas is readable at capture time.
  The harness enforces this for `three` and raw WebGL works.
- **Determinism (`pure` works).** Seeded PRNG only, no `Date.now`, no
  `Math.random`, no network. The same seed yields the same frame. This is
  what makes the frame a reproducible artifact rather than a service
  output.
- **Output identity.** The uploaded PNG bytes are the canonical
  thumbnail; their content address (Arweave tx / IPFS CID) is the
  pointer. Pure 2D / canvas work is close to byte-reproducible across
  machines; GPU work is not (see §6), so store the address of the frame
  actually captured and treat later re-renders as visually-equivalent
  preservation, not a strict byte match.

### 3.2 The pointer (shipped, in RenderAssets)

All presentation pointers live in the **RenderAssets** singleton
(`contracts/src/surface/renderers/RenderAssets.sol`), renderer-land,
outside the core. `imageFor(collection, tokenId)` resolves down a ladder:

1. **Per-token capture** — `setCaptures(collection, tokenIds, uris)`,
   explicit frames, one string per token. The override rung.
2. **Capture template** — `setCaptureTemplate(collection, template)`,
   a URI with `{id}` resolved to the token id at read time, e.g.
   `ar://<manifest>/{id}.png`. **One small transaction covers a whole
   drop's thumbnails**: upload the frames, publish a manifest, point the
   template at it. Refreshes are one transaction regardless of
   collection size (a new manifest can reference all previously uploaded
   frames plus the new ones). This rung exists so per-token thumbnails
   never cost per-token gas.
3. **Collection cover** — `setCover(collection, uri)`. The floor, set at
   deploy so `image` resolves from the first block.
4. `""` — nothing set. `DefaultRenderer` emits an empty image;
   `ScriptyRenderer` omits the `image` field so `animation_url` stands
   alone.

`DefaultRenderer` reads this ladder always; `ScriptyRenderer` reads it
when constructed with the registry address (the wired form is the
default recommendation for HTML works). After landing new captures or a
new template, nudge marketplaces with the collection's ERC-4906
`notifyMetadataUpdate` (owner/admin).

### 3.3 Write authority: admins and the capturer role

RenderAssets borrows each collection's own authority: the owner and
admins can write everything. Two writes — `setCaptures` and
`setCaptureTemplate` — additionally accept a **capturer**: a narrow,
per-collection key granted and revoked by an admin via
`setCapturer(collection, account, allowed)`. A capturer cannot touch the
cover, the capturer roster, or anything on the collection itself.

This resolves the old "flat admins vs narrow thumbnails-only key" open
decision, in renderer-land where it is cheap instead of the core where
it was rightly rejected. What it buys:

- **The artist's own automation runs on a low-privilege hot key.** A
  serverless function or laptop cron that writes thumbnails should not
  hold a key that can reroute payouts or authorize minters. Now it
  doesn't have to.
- **Delegation without full trust.** An artist can grant PND (or any
  service, or a friend) capture-writing for the tokens minted on that
  surface, and revoke it any time. The worst a rogue capturer can do is
  point at a wrong thumbnail — refreshable, art untouched.
- **PND stays un-obligated.** A capturer grant is a permission, not a
  duty; PND accepts it only where it earned the mint share.

## 4. Who captures, who pays (the answer)

Cost centers, each assigned to the party that benefits:

| Cost | What it is | Who bears it | Why that is correct |
|---|---|---|---|
| Live display | render in grid / hero / mint preview | whoever shows it (client-side) | trivial browser cost, borne by the viewer's page |
| Collection cover | one capture + one-time upload at deploy | the artist, once | it is their contract; the floor image |
| Per-token capture (compute) | client-side frame grab at mint | the mint surface (which earns the share) | compute follows revenue |
| Per-token storage | one-time permanent upload (cents) | the mint surface, out of the share it just earned | pay once, done forever; no recurring bill exists |
| Pointer (gas) | one `setCaptureTemplate` per batch, or `setCaptures` for overrides | the artist's key or their capturer | O(1) per refresh via the template rung, not per token |

What this means concretely:

- **Artist mints on their own site.** Their site captures the frame
  client-side (it is already rendering the buyer's live preview),
  uploads it once, and updates the template or captures with the
  artist's own key or a capturer key they run. PND is not in the loop
  and spends nothing: no compute, no storage, no gas. Symmetric.
- **Collector mints on PND.** PND's mint page captures client-side (PND
  earns the share here, so the compute is compensated) and pays the
  one-time upload — cents against a share of an art sale — and then PND
  is done, forever: permanent storage has no landlord. The pointer is
  written by the artist's key, or by a capturer key the artist granted
  PND, their choice.
- **Contract-direct mints** (no browser, no surface) show the cover
  until someone backfills. Determinism means anyone can, any time.
- **PND runs no protocol-wide thumbnail service.** Its capture code is
  client-side on its own surface, plus the optional worker rasterize for
  SVG. It is never obligated to render or store thumbnails for a
  collection minted somewhere else.

## 5. The artist workflow (no servers, ever)

1. **At deploy** the studio is already rendering the work for the
   preview; it captures one frame, uploads it once, and sets the cover
   in the same flow. `image` resolves from block one.
2. **At mint** the hosting surface captures that token's frame from the
   preview it is already showing and uploads it.
3. **Backfill, occasionally**: a studio page lists tokens with no
   capture yet (the indexer knows), renders each client-side via the
   parity renderer, uploads the frames, publishes an updated manifest,
   and the artist signs **one** `setCaptureTemplate` transaction. No
   cron. No server. Signing can also be delegated to a capturer key.

## 6. By liveness tier, and honest limits

- **SVG / Solidity-native.** No capture. `image` is generated onchain.
  The worker's cheap `sharp` rasterize handles the marketplace-cache
  case where a raster copy is wanted. Already built; nothing to add.
- **Pure HTML generative.** The format above: cover at deploy, per-token
  frames via the template, deterministic and reproducible. This is Art
  Blocks' entire catalog and the main case.
- **Chain-live (Homage, TBAM).** A frozen frame is an honest snapshot,
  "code plus inputs at time T", not the work. The cover is a
  representative snapshot; per-token or periodic refresh is optional
  and, if wanted, driven by the artist (captures are refreshable
  forever, on purpose). Do not present the snapshot as the work;
  `animation_url` is the living piece.
- **External-live.** Same as chain-live, and honest about fragility.
- **WebGL byte-determinism is not guaranteed** across GPUs and drivers.
  Store the address of the frame actually captured; a later re-render is
  visually-equivalent preservation, not necessarily byte-identical.
- **Canvas tainting.** The harness must render same-origin (the `srcdoc`
  iframe already in use) so the canvas stays readable for capture.

## 7. What this reuses vs what is new

**Reuses (most of it):**
- The parity renderer (`apps/web/src/lib/collection-render/` and the
  vendored `templates/artist-page/lib/collection-render/`) as the
  capture source: it already builds and renders the token document in a
  sandboxed iframe.
- The Editions upload rails: the Irys→Arweave one-time path and the
  Storacha UCAN "sovereign connect" delegation, as fits.
- RenderAssets + both bundled renderers' image resolution (shipped).
- The worker's `sharp` SVG rasterize path in
  `apps/worker/src/tasks/capture-collection-media.ts`, already built.

**New (small):**
- A client-side capture util in the parity lib: grab the canvas from the
  render iframe, encode PNG per §3.1, hand the bytes to the upload flow.
- The capture-spec section mirrored into `injection-convention.md` v2.
- A studio "capture cover" step at deploy.
- The studio backfill page (§5, step 3) with manifest publish + one-tx
  template update.

**Explicitly not built:**
- A PND-hosted headless capture service. The worker's HTML path stays
  parked behind `CAPTURE_HTML=1`; v1 adds no browser to the Railway
  image. Revisit only on real demand for backfilling contract-direct
  mints, and even then as an optional or paid capability, never a
  protocol obligation.

## 8. Decisions resolved (formerly open)

- **Per-token pointer gas** — resolved by the template rung: O(1)
  transactions per refresh, per-token strings only for overrides.
- **Flat admins vs a narrow thumbnails-only key** — resolved by the
  capturer role in RenderAssets (§3.3): narrow, revocable, renderer-land,
  no core change, no violation of the flat-admin decision.
- **Storage default** — one-time permanent storage over subscription
  pinning (§2), with the mint surface paying at capture time.

Still open:
- **Default capture frame policy** (first-stable-frame detection vs a
  declared frame index), and per-library defaults (a p5 `draw` loop vs a
  `three` render).
- **Whether the studio auto-prompts** the artist to backfill after a
  drop, or leaves it fully manual.
