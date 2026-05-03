/**
 * Crawler / link-preview-bot detection.
 *
 * Why this exists: Twitter, Discord, Slack, iMessage, Facebook, Telegram,
 * WhatsApp, LinkedIn etc. all unfurl shared URLs by issuing GET requests
 * for the OG metadata. They don't render or interact — they want the
 * `<title>`, `<meta og:image>`, `<meta og:description>`. They DO NOT need
 * the page body's RPC reads (auction state, gallery enrichment, etc.).
 *
 * Without filtering, a single share to a popular Discord server can
 * spawn dozens of crawler hits in a few seconds, each triggering the
 * cold-cache RPC fan-out for the same artist or token. That's the
 * spike pattern in the Alchemy "$1 every few minutes" bills.
 *
 * The detection is intentionally permissive: false positives (real users
 * matching the regex) just get a lighter render — the page still works,
 * they just won't see the live gallery / auction state. False negatives
 * (a bot that doesn't identify itself) fall through to the normal
 * render path. The pattern catches Twitter/Discord/Slack/Facebook/etc.,
 * which is where the burst traffic actually originates.
 */
import { headers } from "next/headers"

const CRAWLER_RE =
  /bot\b|crawl|spider|preview|facebookexternalhit|slackbot|discord|twitterbot|whatsapp|telegram|linkedinbot|googlebot|bingbot|applebot|skypeuripreview|embedly/i

export async function isCrawler(): Promise<boolean> {
  const ua = (await headers()).get("user-agent") ?? ""
  return CRAWLER_RE.test(ua)
}

export function isCrawlerUserAgent(ua: string | null | undefined): boolean {
  if (!ua) return false
  return CRAWLER_RE.test(ua)
}
