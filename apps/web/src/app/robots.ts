import type { MetadataRoute } from "next"

/**
 * Crawl policy. Artist + token pages stay indexable on purpose (they
 * carry the OG/SEO surface); what's fenced off is the stuff that's
 * expensive or useless to bots:
 *
 *  - /api/ — JSON endpoints (each already rejects crawler UAs and
 *    rate-limits per IP; disallowing saves polite bots the trip).
 *  - ?page= deep pagination — gallery pages beyond the first fan out
 *    enrichment work per page; bots get everything they need from
 *    page one.
 *  - /studio — owner workspaces (also noindex'd at the layout); no
 *    crawlable content, and every page would cost a per-address
 *    identity resolve.
 *
 * crawlDelay paces the polite crawlers across the ~49k artist URLs so
 * a full-site sweep trickles instead of bursting. Impolite bots ignore
 * this file entirely — they're handled by the per-IP rate limits and
 * the server-side resolution budget (see enrichTokens).
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        disallow: ["/api/", "/studio", "/*?page="],
        crawlDelay: 2,
      },
    ],
  }
}
