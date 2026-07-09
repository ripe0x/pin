# PND Collection System: thumbnails and cover images

> **Status: design, not yet built (2026-07-09).** Companion to
> `docs/pnd-collection-system.md` (section 5.4, the capture worker) and
> `docs/injection-convention.md` (the capture spec in section 3.1 below
> should be mirrored into injection-convention v2 so the onchain
> assembler, studio, mint surface, and artist embed all agree on the
> canonical frame). The contract mechanics referenced here already ship
> on PR #133: `Collection.artworkURI` / `setTokenArtwork` /
> `setTokenArtworkBatch` / `freezeMetadata`, and the `image` resolution
> in `DefaultRenderer` and `GenerativeRenderer`. Nothing here needs a
> contract change for v1.

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
fallback for the window before a token's real frame is captured (see
section 4).

That splits into two problems wearing one coat:

- **A. Compute.** Run the code and rasterize a frame.
- **B. Storage and pointer.** Put the bytes somewhere and make `image`
  point at them.

The "outlives PND" promise is only threatened by B. Compute (A) can be
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
- **Storage is always artist-owned.** The bytes are pinned to the
  artist's own space (Storacha UCAN / Arweave), the same self-pin rails
  Editions uses. PND never custodies media and never pays a storage bill.
- **The onchain tokenURI always self-resolves to at least a cover.**
  `image` is never dependent on an offchain API. This is the sovereignty
  floor: if PND vanishes, every token still resolves a real image from
  chain data plus artist-owned storage.
- **Determinism makes it reproducible.** A `pure` token's frame is a
  function of onchain data (script bytes plus seed). Anyone can
  regenerate it, so no single party is load-bearing for preservation.
- **No headless browser server in v1.** All HTML capture is client-side
  (studio at deploy, mint surface at mint). PND adds no playwright /
  puppeteer to the worker image. The worker's HTML path stays parked.

## 3. The format

### 3.1 Canonical capture spec (mirror into injection-convention v2)

Every surface that captures a token must produce the same frame, or the
"anyone can reproduce it" guarantee breaks. The spec:

- **Frame.** A single frame taken after a deterministic warm-up: N draw
  frames or M ms of virtual time, declared per work in
  `WorkConfig.renderParams` (default: the first stable frame the harness
  detects). Time is virtual and seeded, never wall-clock.
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
- **Output identity.** The pinned PNG bytes are the canonical thumbnail;
  its CID is the pointer. Pure 2D / canvas work is close to
  byte-reproducible across machines; GPU work is not (see section 6), so
  store the CID of the frame actually captured and treat later re-renders
  as visually-equivalent preservation, not a strict CID match.

### 3.2 Storage

- Pin the PNG to the **artist's own space** (Storacha UCAN space, or
  Arweave via the Editions self-pin path). Content-addressed; the pointer
  is the CID.
- For mints hosted on **PND's** surface, the artist grants PND a scoped,
  revocable UCAN delegation to write to their space (the same "sovereign
  connect" Editions already uses). Storage stays artist-owned; PND is a
  delegated writer for the duration, never a custodian. Revoking the
  delegation costs the artist nothing and loses nothing already pinned.

### 3.3 Pointer (already in the contracts)

- **Collection cover:** `CollectionConfig.artworkURI`, set at deploy,
  read via `artwork()`. This is the floor.
- **Per-token override:** `setTokenArtwork(tokenId, cid)` /
  `setTokenArtworkBatch(tokenIds, cids)`, `onlyOwner`, blocked once
  `freezeMetadata()` is called (this pairing is the art-permanence
  guarantee, so it stays owner-gated).
- **`image` resolution, as already implemented:** per-token override, else
  collection cover. `DefaultRenderer` always emits the cover;
  `GenerativeRenderer` omits `image` entirely when both are empty and
  falls back to `animation_url` alone.
- **Net rule for the studio:** always ship a cover so `image` is present
  from the first block, then set the real per-token frame as each token
  is minted. For a generative collection the per-token frame is the
  target state; the cover is the placeholder that shows only until the
  token's own frame lands.
- **Authorization note:** `setTokenArtwork` / `setTokenArtworkBatch` are
  gated by `onlyOwnerOrAdmin`. The collection has a flat admin model (the
  owner grants full-access admins; there is no narrow thumbnails-only
  role, a deliberate simplicity choice). So a per-token frame is written
  by the owner or by any admin. The sovereignty-preserving default is that
  the artist's own backend (owner, or an admin the artist runs) sets the
  frames for all their tokens, regardless of mint venue. Letting PND write
  frames directly would mean granting PND a full admin key, which is full
  trust, not a scoped grant; see section 4.

## 4. Who captures, who pays (the answer)

Three cost centers, each assigned to the party that benefits:

| Cost | What it is | Who bears it | Why that is correct |
|---|---|---|---|
| Live display | render in grid / hero / mint preview | whoever shows it (client-side) | trivial browser cost, borne by the viewer's page |
| Collection cover | one capture + pin at deploy | the artist, once | it is their contract; the floor image |
| Per-token capture (compute) | client-side frame grab at mint | the mint surface (which earns the share) | compute follows revenue |
| Per-token storage | pin the PNG | the artist's space always (self-pin, or the mint surface as a revocable delegated writer) | storage is always artist-owned |
| Per-token pointer (gas) | `setTokenArtwork` / `setTokenArtworkBatch` | the artist's own backend (owner or an admin they run); optionally PND if granted a full admin key | the pointer is owner-or-admin gated; the artist keeps it in-house by default |

What this means concretely:

- **Artist mints on their own site.** Their site captures the frame
  client-side (it is already rendering the buyer's live preview), pins to
  the artist's own space, and sets the per-token pointer with the owner
  key or an admin the artist runs. PND is not in the loop and spends
  nothing: no compute, no storage, no gas. Symmetric.
- **Collector mints on PND.** PND's mint page captures client-side (PND
  earns the share here, so the compute is compensated) and pins under a
  revocable UCAN delegation to the artist's space. The onchain pointer is
  then written by the artist's own backend, which batches new tokens from
  every venue. So PND does the compute where it earned the share, storage
  stays artist-owned, and the artist keeps the onchain write in-house.
  PND needs no onchain role at all in this model.
- **The full-trust shortcut.** An artist who fully trusts PND can grant
  PND a full admin key so PND writes the pointer directly on PND-surface
  mints. Because admins are full-access (they can also redirect payouts
  and authorize minters), this is a real trust decision, not a scoped
  grant. Revocable at any time, but not the default.
- **PND runs no protocol-wide thumbnail service.** Its headless worker
  stays optional and scoped to its own surface. It is never obligated to
  render or set thumbnails for a collection minted somewhere else.

This keeps the per-token requirement affordable without pooling cost on
PND: the compute sits with whoever hosted the mint and took the share,
storage is always artist-owned, and the onchain pointer defaults to the
artist's own backend. The artist's batching job is lightweight (read new
tokens from the indexer, capture, pin, `setTokenArtworkBatch`), a cron or
serverless function, not a live render server.

## 5. By liveness tier

- **SVG / Solidity-native.** No capture. `image` is generated onchain.
  The worker's cheap `sharp` rasterize handles the marketplace-cache case
  where a raster copy is wanted. Already built; nothing to add.
- **Pure HTML generative.** The format above: a cover at deploy plus
  optional per-token thumbnails, deterministic and reproducible. This is
  Art Blocks' entire catalog and the main case.
- **Chain-live (Homage, TBAM).** A frozen frame is an honest snapshot,
  "code plus inputs at time T", not the work. The cover is a
  representative snapshot; per-token or periodic refresh is optional and,
  if wanted, driven by the artist. Do not present the snapshot as the
  work; `animation_url` is the living piece.
- **External-live.** Same as chain-live, and honest about fragility.

## 6. Honest limits

- **WebGL byte-determinism is not guaranteed** across GPUs and drivers.
  Do not build durability on "anyone recomputes the exact CID." Store the
  CID of the frame actually captured and pinned; a later re-render gives a
  visually-equivalent preservation copy, not necessarily byte-identical.
  Pure 2D / canvas is close to byte-reproducible; 3D is not.
- **Contract-direct mints** (no browser, no surface) get the cover only,
  until someone enriches them. Backfill is optional: the artist can run a
  client-side pass over their own not-yet-captured tokens and batch the
  setter. Determinism means it can also be done later by anyone.
- **Canvas tainting.** The harness must render same-origin (the `srcdoc`
  iframe already in use) so the canvas stays readable for capture.
- **Per-token onchain cost.** One storage write per token (order of one
  to two dollars at moderate gas), batched via `setTokenArtworkBatch`. It
  is opt-in; the cover floor is free after deploy.

## 7. What this reuses vs what is new

**Reuses (most of it):**
- The parity renderer (`apps/web/src/lib/collection-render/` and the
  vendored `templates/artist-page/lib/collection-render/`) as the capture
  source: it already builds and renders the token document in a sandboxed
  iframe.
- The Editions self-pin (Storacha UCAN) for storage, including the
  scoped-delegation "sovereign connect".
- `artworkURI` / `setTokenArtwork` / `setTokenArtworkBatch` and the two
  renderers' `image` resolution, already shipped on #133.
- The worker's `sharp` SVG rasterize path in
  `apps/worker/src/tasks/capture-collection-media.ts`, already built.

**New (small):**
- A client-side capture util in the parity lib: grab the canvas from the
  render iframe, encode PNG per the section 3.1 spec, hand the bytes to
  the existing pin flow.
- The capture-spec section mirrored into `injection-convention.md` v2.
- A studio "capture cover" step at deploy (the studio is already
  rendering the work for the preview; capture one frame and pin it).
- An optional, artist-run per-token batch-enrich job (client-side render
  plus `setTokenArtworkBatch`), usable for both venues and for
  contract-direct backfill.

**Explicitly not built:**
- A PND-hosted headless capture service. The worker's HTML path stays
  parked behind `CAPTURE_HTML=1`; v1 adds no browser to the Railway
  image. Revisit only if there is real demand for backfilling
  contract-direct mints, and even then as an optional or paid capability,
  never a protocol obligation.

## 8. Open decisions

- **Default capture frame policy** (first-stable-frame detection vs a
  declared frame index in `renderParams`), and per-library defaults (a p5
  `draw` loop vs a `three` render).
- **Whether the studio auto-prompts** the artist to batch-enrich per-token
  thumbnails after a drop, or leaves it fully manual.
- **Flat admins vs a narrow thumbnails-only key.** The core ships flat,
  full-access admins (owner grants an admin; an admin can do everything
  the owner can except manage admins and transfer ownership). That means
  the only way to let PND write per-token pointers on PND-surface mints is
  a full admin grant (full trust), so the default path is the artist's own
  backend writing pointers for all venues. If experience shows artists
  want PND to set thumbnails without full trust, a narrow thumbnails-only
  capability could be added, but it is a contract change and cannot be
  retrofitted to already-deployed immutable clones. Deferred by the "no
  roles" decision; revisit only on real demand.
