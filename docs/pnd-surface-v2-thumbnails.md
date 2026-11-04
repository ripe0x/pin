# Surface v2: thumbnails for HTML works

> **Status: design, 2026-11-04. Answers issue #365** (which folds #138,
> #271 and #272). Supersedes `docs/pnd-surface-thumbnails.md`, which was
> written for the v1 core (admins, `DefaultRenderer`, a PND-deployed
> RenderAssets, client-side-only capture) and is now historical.
> Companions: `docs/pnd-surface-v2-design.md` (the primitive rules),
> `docs/injection-convention.md` (the render contract this capture spec
> extends), `docs/media-delivery.md` (PND's display-derivative layer),
> `docs/muri-integration.md`.

## 1. Problem

An HTML or generative token renders live from `animation_url`. Marketplace
grids, wallets, search, OG cards and PND's own grids read `image`. With no
raster `image`, every one of those surfaces shows a blank tile or has to
boot a live iframe (60M+ gas `tokenURI`, WebGL, per tile). Each token is
visually unique, so a shared cover is a placeholder, not an answer: the
steady state is **a per-token still of that token's own render**.

Three sub-problems, unchanged from the v1 note:

- **Compute**: run the code and rasterize a frame.
- **Storage**: put the bytes somewhere durable.
- **Pointer**: make `tokenURI.image` resolve to them.

## 2. Constraints (what v2 changed)

1. **`image` is the renderer's job.** `Surface.tokenURI` delegates wholly
   to `IRenderer(renderer).tokenURI`; the cover is the renderer's
   `contractURI`. There is no core field to write a thumbnail into, and the
   v2 rule (design §2) forbids adding one.
2. **No PND RenderAssets in the system.** #353 removed `RenderAssets`,
   `DefaultRenderer` and `ScriptyRenderer` from the repo; they "may return
   later as a separate optional package" (design §5). `packages/addresses`
   still says RenderAssets was "never deployed to mainnet", which is now
   stale (§3).
3. **Authority is `owner()` only.** No `isAdmin`, no admin set, no
   capturer role on the token. `notifyMetadataUpdate` is callable by the
   **renderer or the owner** (`contracts/src/surface/v2/Surface.sol:165`).
   `renounceOwnership()` is the only lock; after it, `owner() == 0` and
   anything that borrows owner authority stops working.
4. **Discovery vs scanning (AGENTS.md).** A fixed shared singleton (an
   asset registry, MURI) may be indexed in Ponder. Per-token work
   (rendering, uploading, deriving) belongs in the worker or an
   offline tool, never Ponder.
5. **Compute follows revenue** (kept from v1). PND must not become the
   free thumbnail utility for collections that mint elsewhere. PND pays
   only where it earns: the 5% referral on its own mint surface, or a
   payout split (Form of Solitude's 80/20).

## 3. What already exists

**Production precedent: Form of Solitude is already option A.** Probed
read-only at mainnet block 26,338,554:

| Fact | Value |
|---|---|
| Token `0x4490f1dadefa3234961404f5cc58056296eb4a89` | `version() = 2`, `totalSupply() = 15`, owner `0x365C…5860` |
| `renderer()` | `0x8dfA9cdd…1316`, verified `AntonRenderer is ScriptyRenderer` |
| Renderer `image` | `ScriptyRenderer._image` returns `renderAssets.imageFor(collection, id)`; `contractURI` image is `renderAssets.coverOf(collection)` |
| RenderAssets instance | `0x34D384646a44EbeA51f07C1Fa888E469483e25fB`, verified, ownerless, deployed 2026-10-31 by `0xCB43…17F9` from an external repo (`src/render/RenderAssets.sol`, imports `pin/src/surface/interfaces/ISurfaceAuth.sol`) |
| `imageFor(FoS, 1..15)` | 15 distinct `ar://` PNGs, 2048×2048, RGB (no alpha) |
| `templateOf(FoS)` | `https://form-of-solitude-capturer.fly.dev/<collection>/{id}.png`, `templateMaxTokenIdOf = 256` |
| `coverOf(FoS)` | `ar://SDfMqsvl5tykH224bFG1W0x3G_AQg0wonJXsORc-X3c` |
| Writers | all 15 `CaptureSet` and the one `CaptureTemplateSet` sent by the collection owner; no `CapturerSet` yet |

The mainnet RenderAssets gate is
`msg.sender != owner() && !isAdmin(msg.sender)`. On a v2 token the owner
short-circuits before `isAdmin` is called, so the owner passes. A
non-owner falls through to `isAdmin`, which v2 does not have, so the call
reverts with empty data instead of `NotSurfaceAdmin`. Same for
`onlyCaptureAuthorized`, except a granted capturer short-circuits first.
Consequence: **a capturer granted before renounce keeps writing captures
after renounce**, while the cover and the capturer roster freeze. That is
the right shape for "captures mirror the art, they are not the art".

`AntonRenderer.requestCaptureRefresh(collection, id)` lets a capturer or
the owner emit the token's ERC-4906 refresh through the renderer (v2 lets
the renderer call `notifyMetadataUpdate`). That is how a low-privilege
capture key nudges marketplaces without owner authority.

**Reusable code:**

- **PR #290 (closed), branch `claude/generative-script-onchain-acf484`,
  `apps/worker/src/capture/`.** A working headless pipeline:
  `render.ts` (Playwright Chromium, SwiftShader WebGL flags,
  `deviceScaleFactor: 1`, renders twice and requires byte-identical PNGs),
  `irys.ts` (Irys upload, `paidBy` so an artist's approved balance pays),
  `manifest.ts` (Arweave path manifest plus the **coverage bound**: largest
  N with every id 1..N captured, written as `templateMaxTokenIdOf`),
  `verify.ts` (gateway byte checks, and `bound + 1` must 404),
  `chain.ts`, `run.ts` (resumable record). Its weak spot is the source: it
  renders a work-specific `frame.html` served from a URL, not the onchain
  document.
- **PR #348 (closed), branch `claude/capture-image-route`.** A
  `/api/captures/{chainId}/{collection}/{id}.png` route serving a
  worker-rendered PNG from Postgres with an immutable cache, redirecting to
  the cover while pending. Useful only if PND ever hosts a template target
  (§4, option B); not on the recommended path.
- **`apps/web/src/lib/collection-render/`.** There is **no `capture.ts`**
  on `main` or any branch: #271's client-side utility was never built. The
  parity lib (`build.ts`, `TokenContext = "token" | "preview" |
  "capture"`) builds a v1 `WorkConfig` document. It cannot reproduce
  bespoke context fields (AntonRenderer injects `owner`), so it is not a
  general v2 capture source.
- **`apps/worker/src/tasks/capture-collection-media.ts`.** Rasterizes an
  inline SVG `image` to a 1200px PNG with sharp into `collection_media`,
  parks HTML as `needs_html_capture`, and only logs under `CAPTURE_HTML=1`.
  It discovers through v1 `SURFACE_FACTORY` and
  `${INDEXER_SCHEMA}.collection_tokens`, so it never sees v2 tokens. Keep
  the SVG path. The HTML stub is replaced by §6.
- **`derive-token-media` + `@pnd/media`.** Builds 800px WebP display
  derivatives into S3-compatible storage. It excludes Surface collections
  outright, treats HTML as `unsupported`, and no-ops until `MEDIA_OBJECT_*`
  is provisioned (it is not).

## 4. Options

### A. Renderer-land pointer (the artist's renderer resolves `image`)

The renderer reads an ownerless asset registry (RenderAssets: capture,
else template within bound, else cover). Captures are uploaded once to
Arweave. The pointer is written by the owner or a capturer key.

- **Permanence:** good. `ar://` bytes plus an onchain pointer, and nothing
  PND runs is in the `tokenURI` path. A template that points at a live
  server (FoS's fly.dev) is the exception and should be temporary.
- **Cost:** one Arweave upload per token (cents), and gas per write.
  `setCaptures` costs gas per token. A template plus a manifest costs O(1)
  per refresh.
- **Trust:** owner, or a narrow capturer the owner granted. Survives PND.
- **Marketplace compatibility:** native. `image` is in `tokenURI`, and an
  ERC-4906 refresh goes through the renderer relay or the owner.
- **Determinism:** depends on the capture spec (§5), not on the pointer.
- **Limit:** the renderer must be written to read the registry. A
  collection whose renderer emits no `image` needs `setRenderer` before
  renounce. After renounce it cannot opt in.

### B. PND-hosted offchain derivatives (worker plus R2)

The worker renders headlessly and stores PNG/WebP in R2 (or Postgres, as in
#348). PND's grids read it from `token_media_delivery`.

- **Permanence:** none. It is a cache keyed by source and lives only as
  long as PND does.
- **Cost:** PND pays for compute (a Chromium in the Railway worker image)
  and storage, for every collection. That breaks compute-follows-revenue
  unless it is scoped.
- **Trust:** PND only.
- **Marketplace compatibility:** none, unless the renderer's template
  points at a PND URL, which puts PND uptime in `tokenURI`.
- **Determinism:** same spec, but nothing anchors the result.
- **Fit:** good for **PND's own display layer** (resize the anchored
  capture to WebP for grids). Wrong as the system of record.

### C. MURI anchor

Register the collection with MURI and store per-token thumbnail URIs
there. A renderer would then read `MURI.renderImage` or
`getThumbnailUris`.

**Can MURI register a v2 Surface? Yes, the owner can.** Evidence:

1. **Source.** MURI at `0x0000000000C2A0B63ab4aA971B08B905E5875b01` is
   verified on Blockscout (`MURIProtocol`, solc 0.8.30). Its live
   `eth_getCode` matches the verified runtime byte for byte (49,014 hex
   chars). `registerContract` is
   `onlyContractOwner(contractAddress)`, which calls
   `_isContractAdmin(contract, msg.sender)`:
   ```solidity
   (ok, ret) = contractAddress.staticcall(isAdmin.selector, account);
   if (ok && ret.length >= 32) return abi.decode(ret, (bool));
   (ok, ret) = contractAddress.staticcall(owner.selector);
   if (ok && ret.length >= 32) return abi.decode(ret, (address)) == account;
   return false;
   ```
   A v2 Surface has no `isAdmin` and no fallback, so the first staticcall
   fails and the check falls through to `owner()`. #138's worry ("gates on
   `isAdmin`") holds only for contracts that implement `isAdmin`.
2. **`eth_call` against mainnet (block 26,338,554), Form of Solitude:**
   - `FoS.isAdmin(owner)` reverts (the function does not exist).
   - `MURI.registerContract(FoS, 0x0FFc…606C)` from the owner
     `0x365C…5860` **succeeds** (empty return).
   - The same call from `0x…dEaD` reverts `0xab908d0c` = `WalletNotAdmin()`.
   - `MURI.registerContract(FoS, address(0))` from the owner reverts
     `0x82542ee1` = `InvalidInterface()`, because the operator defaults to
     the token and v2 does not support `IMURIProtocolCreator`
     (`0xa76ed181`). The Manifold extension does.
   - `MURI.contractOperators(FoS)` is zero (not registered today).

What registration does **not** buy:

- **An operator adapter contract is still required.**
  `initializeTokenData` is `onlyContractOperator`
  (`msg.sender == operator`). The Manifold extension only calls it from its
  own Manifold mint path, so it cannot initialize Surface tokens.
- **Every token needs `initializeTokenData`**, with non-empty
  `artistUris`, a `mimeType` and a SHA-256 `fileHash` of an offchain
  artwork file. For onchain HTML that means duplicating the work offchain
  to satisfy MURI's model, plus per-token SSTORE writes (hundreds of
  thousands of gas per token).
- **`updateThumbnail`, `registerContract` and artist-side permission
  changes are `onlyContractOwner`.** After renounce, `owner() == 0` and
  they are dead. Collector fallbacks still work through the adapter's
  `isTokenOwner`.
- **`image` still needs the renderer to read MURI**, so C is A with a
  heavier registry.
- MURI has a privileged owner (`0x2899…515A`; Solady `Ownable`, `Lifebuoy`)
  who can change the default HTML template. Token data is not
  owner-writable.

**Verdict on C:** feasible, but the wrong home for thumbnails. It stays
the optional *preservation overlay* it already is on Manifold: fallback
copies and an integrity hash. It is not the `image` pointer.

## 5. Capture determinism spec (v2, additive to injection-convention)

One spec for every capturer (PND, an artist's CLI or service, a stranger
re-deriving a frame). Taken from what FoS and PR #290 already ship.

| Parameter | Rule |
|---|---|
| **Source document** | The token's own onchain `animation_url` from `tokenURI(id)`, read at a recorded block `B` (eth_call gas ceiling 300M). Never a work-specific harness page. |
| **Context** | Rewrite the injected `"context":"token"` to `"context":"capture"`. Exactly one match is required; zero or several fails with `context_rewrite_failed`. A renderer MAY later expose an optional capture document directly; the rewrite is the renderer-agnostic default. |
| **Seed** | Never injected or re-derived by the capturer. It comes from the onchain document (`tokenSeed`, per injection-convention). Chain-live inputs (AntonRenderer's `owner`) are whatever the document carried at `B`, so the still is "code plus inputs at block B". Record `B`. |
| **Viewport** | Square 2048×2048 CSS px by default. Non-square works declare an aspect in the capture job; the long edge stays 2048. Screenshot the full viewport, not a work-specific selector. |
| **deviceScaleFactor** | 1. |
| **Format** | PNG, 8-bit RGB, no alpha (flatten onto the page background). This matches the FoS captures. |
| **Time** | Playwright clock installed before navigation and frozen at `B`'s timestamp, so `Date`, `performance.now`, timers and rAF are virtual. After `load` and `document.fonts.ready`, advance `warmupMs` of virtual time (default 0: capture-context works must draw the canonical still synchronously, as anton.js does) and wait for two rAF ticks. A work MAY set `window.__pndCaptureReady = true` to signal early; the capturer waits for it up to the timeout. |
| **GPU** | Software WebGL (`--use-gl=angle --use-angle=swiftshader`, falling back to `--enable-unsafe-swiftshader`), `--force-color-profile=srgb`. Pin the Playwright version exactly and record the Chromium build. The work SHOULD create its context with `preserveDrawingBuffer: true` in capture context. |
| **Network** | Every request is aborted except `data:` and `blob:`. A chain-live work that needs RPC gets one configured RPC origin allowlisted, and the record says so. |
| **Verification** | Render twice in fresh pages; the SHA-256 values must match, or the result is `nondeterministic`. Reject a frame that is a single colour (`blank_frame`). |
| **Timeouts** | 30s navigation, 60s total per token. |
| **Failure states** | `no_animation_url` (SVG `image` goes to the existing sharp path), `token_uri_failed`, `context_rewrite_failed`, `page_error` (an uncaught exception), `render_timeout`, `blank_frame`, `nondeterministic`, `upload_failed`, `pointer_write_failed`. Each is recorded and retried with backoff except `nondeterministic` and `context_rewrite_failed`, which park until a human looks. |
| **Record** | `{chainId, collection, tokenId, block, playwright, chromium, args, viewport, dpr, warmupMs, sha256, arweaveId}` per token. The content address is the identity; a later re-render on different hardware is visually-equivalent preservation, not a byte promise. |

## 6. Recommendation

**Option A is the system of record. B is used only for PND's own display.
C is optional preservation, later.**

1. **Pointer:** renderer-land through an ownerless asset registry. Adopt
   the verified mainnet RenderAssets `0x34D3…25fB` as the optional v2
   registry. FoS already depends on it. It is immutable and ownerless and
   works with the v2 owner model as-is. Vendor its exact source back into
   the repo as an optional package and record its address. Do not deploy a
   second instance. Artist renderers resolve `image` through `imageFor`
   (`ScriptyRenderer._image` already does) and expose a
   `requestCaptureRefresh`-style relay so capturer keys can trigger
   ERC-4906 refreshes.
2. **Compute:** one headless capture tool, salvaged from PR #290 and
   generalized to the §5 spec (onchain source plus context rewrite). It
   ships as a CLI an artist runs themselves, and as a worker task PND runs
   **only** for collections where PND earns (an allowlist in config: FoS
   today). This drops the v1 "client-side only, no headless browser"
   principle. Client-side capture was never built, and a headless,
   double-rendered, pinned-Chromium capture is the only thing that makes
   §5 reproducible.
3. **Storage:** Irys to Arweave, one-time, `paidBy` the artist's approved
   balance where the artist pays.
4. **Pointer writes:** `setCaptures` per batch at mint time for live
   drops (what FoS does). Template plus manifest plus coverage bound for
   backfills and minted-out collections, so `tokenURI` never depends on a
   live server once captures exist. Then a refresh through the renderer
   relay or the owner.
5. **PND display (B, narrow):** the worker derives 800px WebP from the
   anchored capture PNG via `@pnd/media` into R2 once `MEDIA_OBJECT_*` is
   provisioned. Until then, grids use the `ar://` capture directly through
   the existing gateway and resize cascade.

## 7. Build plan (issue-sized)

1. **Adopt the mainnet RenderAssets as the optional v2 asset registry.**
   Vendor the verified source (`contracts/src/render/RenderAssets.sol`,
   byte-for-byte), set `RENDER_ASSETS[1] = 0x34D3…25fB` and fix the stale
   comment in `packages/addresses`, and add `deployments.mainnet.json`
   `renderAssets`. *Done when* a fork test against v2 `Surface` proves:
   the owner writes cover, captures and template; a stranger reverts; a
   capturer granted before `renounceOwnership` still writes captures after
   it; the cover and roster freeze after renounce.
2. **Capture spec v2 into `injection-convention.md`.** Add §5 as an
   additive "Capture" section, and note that `WorkConfig` references are
   v1-only. *Done when* the doc carries every row of the §5 table and the
   reference site is regenerated (`pnpm generate:docs`) if a
   `_pages` copy changes.
3. **`@pnd/capture` package: deterministic render.** Port PR #290's
   `render.ts` and `hash.ts`. Source from `tokenURI` at block B with the
   context rewrite. Add the Playwright clock, the network block, blank
   detection and the failure states. *Done when* FoS tokens 1..3 render
   byte-identical twice on the pinned Chromium and match the dimensions and
   colour type of their existing `ar://` captures; a fixture with two
   `"context"` matches fails `context_rewrite_failed`; a fixture using
   `Math.random()` fails `nondeterministic`.
4. **`@pnd/capture`: upload, manifest and pointer.** Port `irys.ts`,
   `manifest.ts` (coverage bound), `verify.ts`, `chain.ts`, and the
   resumable `run.ts` record. Writers: `setCaptures` batch, and
   `setCaptureTemplate(…, bound)`. Refresh through the renderer relay if
   present, else the owner. CLI `pnd-capture run|fund|approvals|refresh`.
   *Done when* a Sepolia (or fork) collection on devnet Irys goes from zero
   captures to `imageFor` resolving every minted id, `bound + 1` 404s on
   the gateway, and a re-run is a no-op.
5. **Index RenderAssets in Ponder.** It is a fixed singleton:
   `CoverSet`, `CaptureSet`, `CaptureTemplateSet`, `CapturerSet` into
   `render_assets_*` tables, joined to v2 collection discovery from the
   in-flight v2 indexer rebind. *Done when* "minted v2 tokens with no
   capture" is a single SELECT, and the FoS mint module's per-token live
   `imageFor` read can move to Postgres (RPC audit in the PR).
6. **Worker task `capture-surface-v2` (PND-earned collections only).**
   Replaces the `CAPTURE_HTML` stub. It reads the candidates from step 5,
   gated on a configured collection allowlist and a capturer key, and runs
   `@pnd/capture`. It adds a pinned Chromium to the worker image; if image
   size or memory on Railway is a problem, it runs as its own service.
   *Done when* a newly minted token on an allowlisted collection gets an
   `ar://` capture and a refresh within one scheduler interval, and a
   non-allowlisted collection is never touched.
7. **Display derivatives for Surface captures.** Drop the blanket Surface
   exclusion in `derive-token-media` for tokens whose `image` is an
   anchored capture. Provision `MEDIA_OBJECT_*` (R2) on the worker as a
   separate ops step. *Done when* FoS grid tiles serve 800px WebP from
   `token_media_delivery`, and unprovisioned storage still no-ops cleanly.
8. **Renderer guide: `image` via the asset registry.** Update
   `docs/reference/_pages/surface/guides/write-a-renderer.md` for v2:
   `_image` through `imageFor`, `contractURI` cover, the
   `requestCaptureRefresh` relay pattern, and "decide before renounce".
   *Done when* the guide is regenerated and the create flow links it.

**Not filed now:** a MURI operator adapter (option C), and a PND-hosted
template target (PR #348's route). Revisit either on real demand.

## 8. Open

- Whether PND grants itself capturer on PND-earned collections (owner
  signs `setCapturer(collection, pndCaptureKey, true)`) or the artist runs
  the CLI. The tool supports both.
- FoS's template points at `form-of-solitude-capturer.fly.dev` (404 for
  unminted id 16 today). Once minted out, replace it with an `ar://`
  manifest and bound, so `tokenURI` has no live-server dependency.
