# Media delivery cache

External token media is canonical at the token's original URI. PND's worker
creates small, disposable WebP thumbnails and video posters for gallery
delivery, stores the binaries in S3-compatible object storage, and stores only
their state, measurements, hashes, and URLs in Postgres.

This pipeline deliberately excludes PND Surface collections. Surface captures
are permanent artist-controlled RenderAssets pointers and remain owned by the
client-side capture work in issues #271 and #272. No headless browser or
server-side HTML renderer is part of this cache.

## Deploy

1. Apply `032_media_delivery.sql` before deploying the worker or web build.
2. Create a private S3-compatible bucket with public delivery through its
   provider URL or a custom CDN domain. Cloudflare R2 Standard is the expected
   configuration.
3. Give the worker a key scoped to object writes for only that bucket. Set all
   of these Railway variables together:

   ```text
   MEDIA_OBJECT_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
   MEDIA_OBJECT_BUCKET=pnd-media
   MEDIA_OBJECT_PUBLIC_BASE_URL=https://media.example.com
   MEDIA_OBJECT_ACCESS_KEY_ID=<worker-only key id>
   MEDIA_OBJECT_SECRET_ACCESS_KEY=<worker-only secret>
   MEDIA_OBJECT_REGION=auto
   MEDIA_OBJECT_PREFIX=media-cache/v1
   ```

   The access key and secret never belong in Netlify. The web app reads public
   derivative URLs from Postgres and needs no object-storage credentials.
4. Deploy the worker image. It now installs `ffmpeg` for bounded video poster
   extraction; it does not install Chromium or another browser.
5. Deploy web after worker health shows successful `derive-token-media`
   iterations. It is safe to overlap: missing delivery rows render labeled
   pending/unavailable states, never an indistinguishable blank tile.

Unset every `MEDIA_OBJECT_*` variable to disable new derivative work. A partial
configuration fails closed so media cannot accidentally upload to the wrong
bucket.

## Bounds and cost

Defaults are 12 candidates per five-minute run, one candidate at a time, four
attempts, 25 MiB maximum input, 60 megapixels maximum decode, 800px maximum
output, and a 25-second decode ceiling. Exact source URIs are reused, while
content-addressed object keys deduplicate identical derivative bytes.

Cloudflare's published R2 Standard pricing as checked 2026-08-29 includes 10
GB-month storage, 1 million Class A writes, and 10 million Class B reads per
month, with free direct egress. Beyond that it lists $0.015/GB-month, $4.50 per
million Class A operations, and $0.36 per million Class B operations. Source:
https://developers.cloudflare.com/r2/pricing/

At PND's current known-artist ceiling, 800px WebP derivatives should remain
inside the included tier. Configure a billing alert at $5 and treat either 8 GB
stored or 750,000 monthly writes as a review trigger, leaving margin below the
$10/month product ceiling. Use Standard, not Infrequent Access, because gallery
reads are frequent and Standard alone receives the free tier.

## Rollout and cleanup

Migration 025 briefly modeled Surface PNG bytes in `collection_media.png`.
Migration 032 preserves those old rows as a bounded rollback fallback and adds
metadata needed for a later export, but the scheduler no longer runs that
writer. After RenderAssets capture rollout is verified and any legacy PNGs are
exported or declared disposable, remove the bytea column in a separate measured
migration. Do not copy those cache PNGs into the external derivative table.
