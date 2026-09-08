# Media delivery

## The problem

Token artwork lives at whatever URI the artist's mint platform wrote:
IPFS, Arweave, a plain https URL, or an inline `data:` URI (sometimes
hundreds of KB of base64). Rendering that URI directly on the landing
page, the activity feed, and collection cards meant three different
problems at once:

- inline `data:` images serialized straight into page HTML and the RSC
  payload, bloating every response that showed one
- video tokens had no still frame to show as a thumbnail, so a grid
  cell either showed an empty box or loaded a full video just to paint
  a preview
- every gateway/proxy fallback lived client-side, so a cold cache or a
  dead gateway showed a broken image with no server-side recovery

## The layer

The reusable core (fetching, classification, thumbnail/poster derivation,
and the display resolver) lives in `packages/media` (`@pnd/media`), a
workspace package with no PND-specific assumptions: no database, no fixed
bucket, no fixed routes. It runs the same in PND's worker, in a standalone
CLI, or embedded in an artist's own site build. See "The `@pnd/media`
package" below.

Worker: `derive-token-media` (`apps/worker/src/tasks/derive-token-media.ts`)
scans known artists' non-Surface tokens and calls `@pnd/media/node`'s
`deriveMedia` for each one:

- images resize to an 800px WebP thumbnail
- videos get a WebP poster frame extracted with ffmpeg/ffprobe
- both upload through an `s3Store` (`@pnd/media/node`, a hand-rolled SigV4
  PUT so no AWS SDK dependency)
- the result is recorded in `token_media_delivery`
  (`db/migrations/027_media_delivery.sql`)

Canonical art is never touched. The derivative is a disposable cache
entry keyed by source URL; PND Surface tokens are excluded because
their captures belong to RenderAssets, a separate pipeline. Everything
PND-specific (the candidate query, the `token_media_delivery` upsert, the
scheduler result) stays in the worker task; the fetch/derive/store
mechanics are the package's job.

Web reads the derivative table through `apps/web/src/lib/media-delivery.ts`
(`getMediaDeliveries`, a batch read keyed by `contract:tokenId`) and
resolves what to display through the single resolver,
`apps/web/src/lib/display-media.ts`:

- `chooseDisplayMedia` is pure: given a token's metadata row and its
  delivery row, it picks a ready delivery derivative first, falls back
  to the metadata's image or animation URL, and returns `{kind: "none"}`
  when there is nothing to show. An inline `data:` image routes through
  `/api/media/token/<contract>/<tokenId>` instead of landing in page
  HTML; an inline `data:` HTML document (a generative tokenURI) has no
  still frame, so it resolves to `none`.
- `getDisplayMedia` batches this for a page's worth of tokens: two
  Postgres reads total (`token_metadata`, `token_media_delivery`), no
  chain reads.

The `/api/media/[...source]` route (`apps/web/src/app/api/media/[...source]/route.ts`)
serves inline media on demand for tokens, RenderAssets covers, and
renderer previews, decoding only browser-safe image MIME types
(`apps/web/src/lib/inline-media.ts`) and refusing anything else.

The single display component, `apps/web/src/components/media/Artwork.tsx`,
takes a `DisplayMedia` and renders the right thing: an `<img>` through
the existing proxy-resize + gateway-rotation cascade for images and
video posters, a native `<video>` with its own gateway rotation when no
poster exists, and a placeholder when there is nothing to show. The
landing page (`ReleaseVenue`, `AvailableNow`) and collection cards
(`lib/collection-artwork.ts`) all resolve media through
`getDisplayMedia` and render it through `Artwork`.

The activity feed (`apps/web/src/lib/v2-activity.ts`) batches
`getMediaDeliveries` for the page's tokens and routes every inline
`data:` candidate through the token media route
(`apps/web/src/lib/activity-media.ts`), preferring a ready delivery's
thumbnail or poster over the raw metadata URI.

## The `@pnd/media` package

Two entrypoints:

- `@pnd/media` (`packages/media/src/index.ts`) is browser-safe and pure:
  no Node built-ins. `MediaRecord` is the delivery-state shape (source
  URL, resolved URL, kind, status, thumbnail/poster URL, dimensions,
  hashes, retry state); `recordKey(contract, tokenId)` keys one.
  `chooseDisplayMedia(meta, record, ref, opts)` is the display resolver:
  a ready record wins, else the metadata's image or animation URL, else
  nothing. `opts.inlineUrl(ref)` supplies the URL that serves an inline
  `data:` image outside page HTML, so the package carries no PND route.
  `MediaManifest` plus `parseManifest` and `manifestLookup` are how a
  static site carries its records without a database: a JSON file keyed
  by `recordKey`, read at build or request time in place of a Postgres
  read. `derivativeKey(prefix, sha256, ext)` builds a content-addressed
  object key.
- `@pnd/media/node` (`packages/media/src/node/index.ts`) has the I/O:
  `resolvePublicHttpUrl`/`safeFetch`/`readBounded` (SSRF-safe fetching
  that pins the validated address into the socket, rejects private/
  loopback hosts, and bounds every read), `decodeDataUri`,
  `loadMediaSource`/`classifyMedia`/`deriveImageThumbnail`
  (sharp)/`deriveVideoPoster` (ffmpeg/ffprobe)/`deriveMedia` (the full
  load+classify+derive+hash pipeline), a `MediaStore` interface with two
  adapters (`s3Store`/`mediaStoreFromEnv` for S3-compatible object
  storage, `fileStore` for a local directory plus a public base URL), and
  `decodeInlineMedia` (kept here rather than the pure entry because it
  needs `Buffer`).

`bin/pnd-media.mjs` (published as `pnd-media`) runs the CLI:

```
pnd-media derive --input <json> --out <dir> --public-base <url-or-path> --manifest <path>
```

`--input` is a JSON array of `{contract, tokenId, sourceUrl}`. Each item
derives through `fileStore` at concurrency 2, merges into the manifest at
`--manifest` (created if absent), and writes it back. A per-item failure
is recorded as a `failed` record; it never aborts the run.

An artist site build runs this against its own token list, writes the
derivatives under `public/media`, and ships the manifest alongside the
build. At request or render time, `manifestLookup(manifest)` gives a
`(ref) => MediaRecord | null` to pass into `chooseDisplayMedia`, no
database required.

Next steps, not yet built: a Storacha (artist-pinned) `MediaStore`
adapter, so an artist's derivatives land on their own storage instead of
a local directory; and wiring the CLI plus a manifest into
`templates/artist-page/`'s build so a deployed artist site gets delivery
derivatives without running PND's worker.

## Env vars

Worker (object storage, all required together or the task no-ops):

- `MEDIA_OBJECT_ENDPOINT` (S3-compatible endpoint, https)
- `MEDIA_OBJECT_BUCKET`
- `MEDIA_OBJECT_PUBLIC_BASE_URL` (https base the derivatives are served from)
- `MEDIA_OBJECT_ACCESS_KEY_ID`
- `MEDIA_OBJECT_SECRET_ACCESS_KEY`
- `MEDIA_OBJECT_REGION` (optional, default `auto`)
- `MEDIA_OBJECT_PREFIX` (optional, default `media-cache/v1`)

Optional tuning: `MEDIA_DERIVE_BATCH_SIZE`, `MEDIA_DERIVE_MAX_ATTEMPTS`,
`MEDIA_DERIVE_MAX_INPUT_BYTES`, `MEDIA_DERIVE_MAX_PIXELS`,
`MEDIA_DERIVE_WIDTH`.

When the object storage vars are unset, `derive-token-media` logs one
line and returns without touching the database. Web still works in
this state; it just never gets a delivery derivative to prefer over
the raw metadata URI.

## Rollout

1. Create an S3-compatible bucket and public read access for its objects.
2. Set the `MEDIA_OBJECT_*` vars on the Railway worker service.
3. Run `pnpm db:migrate` against the target database (applies
   `027_media_delivery.sql`; it creates `token_media_delivery` and adds
   columns to `collection_media`, both additive).
4. Deploy the worker. `derive-token-media` runs every 5 minutes once
   Ponder is ready.

Web deploys independently and before the migration runs. Every read of
`token_media_delivery` (`getMediaDeliveries`, and transitively
`getDisplayMedia`) catches the missing-relation error and returns an
empty map, so a web deploy ahead of the migration serves metadata-only
media exactly as before.

## What still bypasses the layer (phase 2)

These call sites build an image URL directly from `ipfsToHttp` or
`useOptimizedImage` outside the landing page and activity feed, so an
artist's inline `data:` media can still reach them un-proxied:

- `apps/web/src/app/[handle]/[tokenId]/page.tsx`
- `apps/web/src/app/api/meta/[contract]/[tokenId]/route.ts`
- `apps/web/src/app/auction/[house]/[auctionId]/page.tsx`
- `apps/web/src/app/collections/[address]/[tokenId]/live/route.ts`
- `apps/web/src/app/collections/[address]/[tokenId]/page.tsx`
- `apps/web/src/app/collections/[address]/page.tsx`
- `apps/web/src/components/OptimizedImage.tsx`
- `apps/web/src/components/auction/TokenPreview.tsx`
- `apps/web/src/components/catalog/CatalogRowLabels.tsx`
- `apps/web/src/components/collections/homage/HomageTokenDetail.tsx`
- `apps/web/src/components/home/AuctionCard.tsx`
- `apps/web/src/components/home/WorkArtistCard.tsx`
- `apps/web/src/components/listings/SovereignBulkPanel.tsx`
- `apps/web/src/lib/artist-queries.ts`
- `apps/web/src/lib/onchain-discovery.ts`

Moving one of these onto `getDisplayMedia` + `Artwork` is a small,
self-contained change per call site: replace the direct URL build with
a batched `getDisplayMedia` call and render the result through
`Artwork`.
