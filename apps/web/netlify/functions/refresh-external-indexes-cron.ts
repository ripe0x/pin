/**
 * Netlify Scheduled Function that POSTs to the daily refresh endpoint
 * for the external-platform indexer (Manifold / SuperRare V2 / Transient
 * Labs). The actual work happens in the Next.js API route at
 * `/api/cron/refresh-external-indexes`; this thin wrapper exists only
 * so Netlify's scheduler can invoke it on a cron timer.
 *
 * Schedule is configured in `netlify.toml` (not inline as
 * `export const config = { schedule }`) so we don't need to add the
 * `@netlify/functions` package just for one type. Same outcome.
 *
 * Env required at runtime:
 *   - `URL` (auto-set by Netlify to the site's primary URL)
 *   - `REVALIDATE_SECRET` (matches the same secret used by
 *     `/api/cron/cleanup` and `/api/cron/indexer-drift-check`)
 */
export default async () => {
  const baseUrl = process.env.URL ?? process.env.DEPLOY_PRIME_URL
  const secret = process.env.REVALIDATE_SECRET
  if (!baseUrl) {
    console.error("refresh-external-indexes-cron: URL env not set")
    return new Response("missing URL env", { status: 500 })
  }
  if (!secret) {
    console.error("refresh-external-indexes-cron: REVALIDATE_SECRET not set")
    return new Response("missing REVALIDATE_SECRET env", { status: 500 })
  }

  const target = `${baseUrl}/api/cron/refresh-external-indexes?secret=${encodeURIComponent(secret)}`
  let res: Response
  try {
    res = await fetch(target, { method: "POST" })
  } catch (err) {
    console.error("refresh-external-indexes-cron: fetch failed", err)
    return new Response("fetch failed", { status: 502 })
  }

  const body = await res.text()
  console.log(`refresh-external-indexes-cron: ${res.status}`, body)
  return new Response(body, { status: res.status })
}
