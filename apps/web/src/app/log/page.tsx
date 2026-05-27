import type { Metadata } from "next"

const TITLE = "Build log"
const DESCRIPTION =
  "What PND has shipped, in the order it shipped. A timeline of artist-owned infrastructure built one tool at a time."

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: { title: TITLE, description: DESCRIPTION, type: "website" },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
}

type LogEntry = {
  /** ISO date or a short human label. Used both for the time element
   *  and the visible date marker on the timeline. */
  date: string
  title: string
  summary: string
  forArtists?: string
  technical?: string
  /** Optional in-app link, rendered as a small footer link on the
   *  entry. Use the path as the label when it is informative on its
   *  own (e.g. "/catalog"); otherwise pass a short verb phrase. */
  link?: { href: string; label: string }
}

// What goes in this log
// ─────────────────────
// Include only value-adding events. Moments where the work shipped
// something a person could newly do or see, or a milestone that
// matters to artists, collectors, or the project's story.
//
// Include:
//   • New capabilities. A flow, an action, support for a platform
//     or wallet pattern an artist couldn't use through PND before.
//   • New public surfaces. A new page, a new home-page state, a
//     new footer module, a new artist-facing template.
//   • Milestones. Mainnet deploys, the campaign hitting its
//     threshold, a project pivot, a contract becoming immutable.
//
// Skip:
//   • Polish and copy tweaks on something that already shipped
//     (e.g. "supporters footer now shows per-supporter mint counts":
//     the footer itself is the entry, the count column is not).
//   • Bug fixes, performance improvements, and reliability work,
//     unless the change unlocks a new user-visible capability.
//   • Internal infrastructure (indexers, caches, RPC plumbing)
//     that doesn't change what artists or collectors can do.
//   • Refactors, dependency bumps, design-system touch-ups.
//
// Rule of thumb: if the most honest summary is "X now also Y" or
// "X is faster / more reliable", it probably doesn't belong here.
// If it's "X is now possible", it does.
//
// Also: no em or en dashes in copy. Use periods, commas, or
// parentheses instead. Hyphens in compound words ("artist-owned",
// "multi-platform") are fine.
//
// Newest first.
const ENTRIES: LogEntry[] = [
  {
    date: "May 25, 2026",
    title: "Smaller changes",
    summary:
      "A batch of polish and reliability across the site. Bulk delist now seeds from the full Foundation listing history (not just the current active snapshot), routes its metadata fetches through the cached /api/meta route, and chunks EIP-5792 batches to MetaMask's 10-call cap so wallets stop rejecting large batches. Token pages show a 'Token not found' state for non-existent IDs instead of a blank artwork shell, and reserve auctions with no bids correctly read 'Awaiting first bid' instead of 'Live auction'. Video tokens that omit a file extension on their image field now play instead of breaking the layout. Catalog import pre-populates from PND's own indexed data when available, so an artist doesn't always need a self-published feed to seed it. Various artist-page and self-hosted-template reliability fixes (bid panel updates promptly, transient metadata failures stop sticking, content-presence guard for resolved media).",
  },
  {
    date: "May 22, 2026",
    title: "Self-serve metadata refresh",
    summary:
      "Token pages on PND and on artist-owned sites now have a Refresh metadata button. Owners, creators, and site admins can force PND to re-fetch a token's title, image, and animation URL from the source contract, so reveals, corrections, and swapped media show up promptly instead of after the cache expires. Token metadata that failed to resolve on its first try (a transient gateway error, a slow IPFS pin) also self-heals on next view instead of staying blank for a week.",
    forArtists:
      "When you reveal a token, swap its media, or fix a typo in the metadata, the change shows on PND within about a minute instead of a day. New mints with metadata that takes a few minutes to propagate populate themselves the first time someone loads the page.",
    technical:
      "Per-token cache tag plus a single-token revalidation route, rate-limited to once per hour per token. The resolver now distinguishes 'fetch failed' from 'empty source' (only sets raw_uri on a real fetch), so failed rows are retried on a short cadence and on read, while resolved rows are still fetched exactly once.",
  },
  {
    date: "May 21, 2026",
    title: "ERC1155 edition count and mint history",
    summary:
      "Token pages for editions (ERC1155 tokens with multiple copies) now show the total minted count and a per-mint provenance trail. Those fields were previously blank.",
    forArtists:
      "If you mint editions instead of one-of-ones, the page reflects that. Collectors see how many copies exist and who minted each one.",
    technical:
      "Worker records one row per TransferSingle/TransferBatch from the zero address and derives total supply from SUM(amount) per token. Falls back to the on-chain totalSupply() only when the contract implements ERC1155Supply (several common edition contracts, including Mint protocol, revert on totalSupply()). Token pages read from Postgres; no per-view RPC.",
  },
  {
    date: "May 21, 2026",
    title: "Off-platform auctions populate their token pages",
    summary:
      "When an artist uses the Sovereign auction contract on a token from a contract PND doesn't otherwise index (a random ERC-721 they own), the token's page now shows artist, owner, image, and provenance. Previously only the auction panel rendered; the rest of the page was blank.",
    forArtists:
      "The /auction/new flow that lets you auction any ERC-721 you own now produces a complete token page, not a placeholder around the auction panel.",
    technical:
      "Worker task ingests (contract, tokenId) pairs that appear in pnd_auctions but not in artist_tokens. Mint recipient is credited as creator only when it equals an auction seller or a known artist; otherwise the row is skipped rather than asserting a wrong attribution.",
  },
  {
    date: "May 21, 2026",
    title: "IPNS token URIs and media resolve",
    summary:
      "Tokens whose tokenURI or embedded image points at ipns:// now load. PND previously only recognized ipfs:// and HTTPS gateways, so IPNS-backed metadata fell through to a failed fetch and the token showed a placeholder.",
    forArtists:
      "If your tokens use IPNS for mutable pointers (so you can update where the media lives without changing the on-chain reference), they now render on PND like any other token.",
  },
  {
    date: "May 21, 2026",
    title: "Catalog page pre-fills from PND's indexed work",
    summary:
      "When a catalog owner visits their own /catalog/[address] page, a checklist of work PND has indexed for that address appears inline, pre-normalized against what's already declared on-chain. The owner can tick the works they want to include and sign a batched commit without leaving the page. Catalog import via a self-published feed lives on as a separate route for sources PND doesn't index.",
    forArtists:
      "If your work is already on a platform PND covers (Foundation, Sovereign, Manifold, SuperRare V2, Transient Labs, Mint), declaring it in your on-chain catalog is a few clicks instead of typing each contract address by hand.",
    technical:
      "Server component on /catalog/[address] fetches the indexed plan via the pnd-indexed import source, normalizes it against the live Catalog snapshot, and renders IndexedWorkSection above the manual entry form. The standalone /artist/[address]/import route is unchanged and continues to cover adapter-based sources (a self-published feed like Bryan Brinkman's JSON-LD).",
    link: { href: "/catalog", label: "/catalog" },
  },
  {
    date: "May 21, 2026",
    title: "Backend rebuild: a worker that keeps the database warm",
    summary:
      "PND moved to a three-app architecture. The web app reads only from Postgres. A long-running worker owns every on-chain scan, metadata fetch, and ENS lookup, and writes the results to the database the web app reads. A separate Ponder indexer tracks a small set of fixed shared contracts. The web app no longer hits the chain on a request path.",
    forArtists:
      "Pages load consistently even when an RPC provider is throttling or down. Anonymous traffic to PND can't accidentally burn through its RPC quota and take the site offline. The data behind your artist page is the same record every other PND page reads.",
    technical:
      "Worker runs 14 background tasks on its own scheduler (transfer scans, owner resolution, metadata warmup, ENS enrichment, per-platform artist refreshes, mint-history ingestion), all gated on the known_artists view so RPC work is bounded by who's actually using PND, not by anonymous traffic. The Ponder indexer is narrowed to a small set of fixed shared contracts; per-artist clone scanning lives in the worker so the indexer doesn't blow up against the long tail of artist-deployed Manifold and Mint collections. Multi-provider RPC fallback (publicnode, llamarpc, ankr, drpc, with Alchemy as a paid backstop) plus a global rate limiter survives any one provider going flaky.",
  },
  {
    date: "May 15, 2026",
    title: "Mint protocol (Visualize Value) support",
    summary:
      "PND now reads work minted via Mint, the open ERC-1155 minting platform from Visualize Value. Artists who deploy a Mint collection are picked up automatically, and their tokens show on artist pages alongside Foundation, Sovereign, SuperRare V2, Manifold, and Transient Labs.",
    forArtists:
      "If you minted on Mint, your work shows up on your artist page. Anyone who deploys a Mint collection from this point on is added to the artist index without needing to ask.",
    technical:
      "A topic-filtered scan of the Mint Factory's Created event returns each artist's full clone list in one call. New clones are enumerated via TransferSingle and TransferBatch from the zero address. The Factory itself is indexed into known_artists so new Mint deployers auto-promote into the per-artist scanner.",
  },
  {
    date: "May 14, 2026",
    title: "Catalog import planner",
    summary:
      "/artist/[address]/import turns an artist's self-published registry (currently Bryan Brinkman's JSON-LD feed at bryanbrinkman.com/api/artworks) into a one-click bulk-import flow for the Catalog contract. The planner filters to mainnet, deduplicates against what's already on-chain, surfaces non-mainnet and off-chain entries transparently, and batches the writes into a few multicall transactions.",
    forArtists:
      "Declaring 200+ works one at a time was never going to happen. If you publish your own canonical list of work, PND can translate it into your on-chain Catalog in a handful of transactions.",
    technical:
      "Pluggable adapter registry under apps/web/src/lib/import-sources/. Per-contract granularity toggle (token-by-token vs. full contract), hidden for known shared platforms. Multicall hook chunks at 50 ops per tx. End-to-end verified on an anvil fork: 229 ops across 5 multicall txs against the live Catalog contract.",
  },
  {
    date: "May 14, 2026",
    title: "Indexed every artist active on a supported platform",
    summary:
      "PND now keeps a server-side index of every address that has acted as an artist on a contract PND supports (Sovereign house owners, Foundation creators and minters, Catalog declarants), and a per-artist index of their work across every supported platform (Foundation, Sovereign, Manifold, SuperRare V2, Transient Labs). The data lives in PND's own database, not refetched against the chain on each page load.",
    forArtists:
      "Wherever PND shows your work, it's reading from one consistent record of what you've made across the platforms it covers. That same record is the substrate the catalog tooling reads from, so flows like the import planner can pull from what you've already minted instead of asking you to track down contract addresses.",
    technical:
      "known_artists is a Postgres view over Ponder tables (Sovereign house owners, Foundation creators and artist-token minters, Catalog declarants). Per-artist token enumeration on the external platforms (Manifold, SR V2, Transient Labs) is stored in three status tables with incremental eth_getLogs cursors. Refreshes are background-only and gated on the known set, so anonymous traffic can't drive RPC fan-out.",
  },
  {
    date: "May 13, 2026",
    title: "Catalog mainnet deploy + /catalog and /dependency pages",
    summary:
      "The Catalog contract went live on Ethereum mainnet. Artists can publish an authoritative on-chain list of which contracts, tokens, and token ranges belong to their public record. /catalog/[address] is the read view and the owner's edit flow. /dependency/[address] is a contract-centric companion that asks which artist any given contract belongs to. The artist page surfaces a compact Catalog section when an artist has declared anything.",
    forArtists:
      "If a collector or another artist asks 'is this really yours?', the answer can now live on-chain in a place you control, separate from any one platform. Galleries, archives, and tools can read it without trusting PND.",
    technical:
      "Immutable, public-infrastructure contract: no admin, no owner, no upgrade path, no fees. Deployed via CREATE2 so the same address applies on every EVM chain given identical bytecode and salt. Multicall and operator delegation. Add/remove events include the actor so audit trails are self-contained. Indexed by Ponder so /catalog reads from Postgres rather than fanning out to RPC on every visit.",
  },
  {
    date: "May 12, 2026",
    title: "/delist landing page",
    summary:
      "A dedicated /delist page explains the bulk-cancel tool and previews any wallet's active Foundation and SuperRare listings without requiring a connection. Paste an address or ENS to see what's listed. Connect that wallet to cancel selected rows. Linked from the For-artists nav and a new /guides/delist explainer.",
    forArtists:
      "If a collector or another artist asks whether they have stale Foundation or SuperRare listings, you can send them one URL. They see what's listed before being asked to connect anything.",
  },
  {
    date: "May 11, 2026",
    title: "Guides section, with the first guide on auction contracts",
    summary:
      "/auctions explains the artist-owned auction contracts in plain language. Who deploys and owns each contract, how listing, bidding, and settlement actually happen, what continues to work if the PND frontend disappears, and the tradeoffs against a shared platform contract. Linked from a new /guides hub and from a new 'For artists' dropdown in the navbar.",
    forArtists:
      "When a collector or another artist asks how your contract actually works, you can link them to one page that answers it. Same job /about does for the project, scoped to the contracts themselves.",
  },
  {
    date: "May 11, 2026",
    title: "Build log added",
    summary:
      "This page. A timeline of what PND has shipped, in the order it shipped.",
    forArtists:
      "If you want to see where the project has been before deciding whether to use it, or whether to support it, the answer is now on one page instead of scattered across PRs and X posts.",
  },
  {
    date: "May 9, 2026",
    title: "funding-works campaign hit its threshold",
    summary:
      "The FundingWorksRipe campaign funding PND closed past its minimum threshold. Supporters minted, streams activated, and the work continues without VC money or platform fees.",
    forArtists:
      "PND's runway for the next phase is funded by people who believe artist-owned infrastructure should exist. Not by taking a cut from your sales.",
    technical:
      "FundingWorks streams funds to ripe over time. Supporters hold a token connected to the campaign and can burn it to redeem the unvested remainder if the relationship stops feeling aligned. The supporters list lives in the global footer of every PND page.",
  },
  {
    date: "May 6, 2026",
    title: "About page added",
    summary:
      "/about explains what PND is, why it started, and what it has shipped so far.",
    forArtists:
      "If a collector or another artist asks 'what is this,' you can link them to one page instead of explaining it in DMs.",
  },
  {
    date: "May 6, 2026",
    title: "Supporters thanked in the global footer",
    summary:
      "Every page now thanks the people who minted from the funding-works campaign that funds PND.",
  },
  {
    date: "May 5, 2026",
    title: "Activity feed promoted to the home page",
    summary:
      "The home page now shows a live, lazy-loading feed of auctions, bids, mints, and settlements across the platforms PND covers.",
    forArtists:
      "First-time visitors see the work happening right now, not an empty search box.",
  },
  {
    date: "May 3, 2026",
    title: "/sites landing page + fork-friendly deploys",
    summary:
      "A dedicated /sites page explains the self-hosted artist site option. The deploy path was reshaped so an artist can fork the template and deploy to Netlify with only a wallet address. No PND-issued keys required.",
    forArtists:
      "You can run your own auction site on your own domain. If PND goes away, your site keeps working against your contract.",
  },
  {
    date: "May 2, 2026",
    title: "Artist-owned site template MVP",
    summary:
      "A standalone Next.js template that reads an artist's auction contract directly, with the same design system as the main PND app.",
    forArtists:
      "Your auctions can live on a site you control, separate from PND.",
    technical:
      "Token-page layout, sticky artwork, Owner + Provenance sections, dynamic favicon, theme-aware bid history. Cache keys include artistAddress so multiple sites can coexist.",
  },
  {
    date: "May 1, 2026",
    title: "Transient Labs support + /auction/new for any owned ERC-721",
    summary:
      "PND now reads Transient Labs galleries and bid histories. Artists can also start an auction on any ERC-721 they own, not just tokens from a supported platform.",
  },
  {
    date: "April 30, 2026",
    title: "Platform adapters: SuperRare V2, Manifold, Foundation",
    summary:
      "PND moved from being Foundation-specific to a multi-platform reader. Artist galleries, collector views, last-sale lookups, and auction interactions now loop over a registered set of platform adapters.",
    forArtists:
      "Your artist page now shows work across the platforms you've used, not just one.",
    technical:
      "Introduced an adapter interface + registry; refactored gallery, last-sale, and collector paths to fan out across Foundation, Sovereign, SuperRare V2, Manifold, and (later) Transient Labs.",
  },
  {
    date: "April 30, 2026",
    title: "Multi-platform delist + relist",
    summary:
      "Artists can delist from Foundation and SuperRare V2 in a single flow, then relist into their own auction contract.",
  },
  {
    date: "April 29, 2026",
    title: "Home: work + artist grid",
    summary:
      "The home page replaced its search-only landing with a shuffled grid of work and artists.",
    forArtists:
      "Visitors see who's on PND immediately, instead of having to know what to search for.",
  },
  {
    date: "April 27, 2026",
    title: "Sovereign Auction House v1.0.0 mainnet deploy",
    summary:
      "The artist-owned auction contract went live on Ethereum mainnet. Immutable, zero platform fee, no admin role, no PND-controlled upgrade path.",
    forArtists:
      "Auctions you run through this contract belong to you. The contract keeps working whether or not the PND frontend does.",
    technical:
      "Houses are EIP-1167 minimal-proxy clones from an immutable factory. Ownership is locked at deploy. Reads are public; writes are callable from any wallet that can call functions.",
  },
  {
    date: "April 27, 2026",
    title: "Migrate UI: Foundation → Sovereign",
    summary:
      "A guided flow to delist a token from Foundation and relist it into the artist's own Sovereign auction contract in one session.",
  },
  {
    date: "April 26, 2026",
    title: "Bulk delist from Foundation (EIP-5792)",
    summary:
      "Artists can delist many Foundation listings at once. Wallets that support EIP-5792 batch the calls; others fall back to one-by-one.",
    forArtists:
      "Cleaning up old Foundation listings stops being a 20-transaction afternoon.",
  },
  {
    date: "April 25, 2026",
    title: "Foundation reserve auction panel with on-chain bidding",
    summary:
      "After Foundation's frontend went offline, PND added a panel for placing bids, viewing bid history, and resolving ENS on existing Foundation reserve auctions.",
    forArtists:
      "Auctions that were already running on Foundation stayed usable.",
  },
  {
    date: "April 16, 2026",
    title: "Artist profile + preserve flow",
    summary:
      "The first usable shape of PND: an artist profile with a Preserve flow that discovers the tokens an artist had on Foundation and lets them pin the media to IPFS through their own pinning provider.",
    forArtists:
      "If Foundation's storage ever stopped resolving, your work would still have a home you control.",
    technical:
      "Pinata as the default, with Filebase and 4EVERLAND as alternatives for free-tier artists. Pin failure reasons are surfaced instead of swallowed. Discovery is scoped to Foundation-pinned tokens, with stable already-pinned counts via batch status checks.",
  },
]

export default function LogPage() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-12 space-y-10">
      <header className="space-y-4">
        <h1 className="text-3xl font-semibold tracking-tight">Build log</h1>
        <p className="text-base text-fg-muted leading-relaxed">
          PND grew one tool at a time, in response to what artists kept
          running into. This page is the log of what shipped, in the
          order it shipped.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          It is not a roadmap. Nothing here is a promise about what
          comes next. It is a record of what is already done.
        </p>
      </header>

      <Timeline entries={ENTRIES} />
    </div>
  )
}

function Timeline({ entries }: { entries: LogEntry[] }) {
  return (
    <ol className="relative space-y-10 border-l border-gray-200 pl-6">
      {entries.map((entry, i) => (
        <TimelineItem key={i} entry={entry} />
      ))}
    </ol>
  )
}

function TimelineItem({ entry }: { entry: LogEntry }) {
  return (
    <li className="relative">
      {/* Dot on the timeline rail. The rail sits at the parent's left
          border (border-l on the <ol>). The dot is positioned so its
          center lines up with the rail. */}
      <span
        aria-hidden
        className="absolute -left-[1.6rem] top-[0.55rem] h-2 w-2 rounded-full bg-fg"
      />
      <article className="space-y-3">
        <time className="block font-mono text-xs uppercase tracking-wider text-gray-400">
          {entry.date}
        </time>
        <h2 className="text-base font-medium text-fg leading-snug">
          {entry.title}
        </h2>
        <p className="text-base text-fg-muted leading-relaxed">
          {entry.summary}
        </p>
        {entry.forArtists && (
          <p className="text-sm text-fg-muted leading-relaxed">
            <span className="font-medium text-fg">
              Why this matters for artists.
            </span>{" "}
            {entry.forArtists}
          </p>
        )}
        {entry.technical && (
          <details className="group">
            <summary className="cursor-pointer list-none font-mono text-xs text-gray-400 transition-colors hover:text-fg">
              <span className="group-open:hidden">▸ technical detail</span>
              <span className="hidden group-open:inline">▾ technical detail</span>
            </summary>
            <p className="mt-2 text-sm text-fg-muted leading-relaxed">
              {entry.technical}
            </p>
          </details>
        )}
        {entry.link && (
          <p className="text-sm">
            <a
              href={entry.link.href}
              className="font-mono text-fg underline decoration-gray-300 underline-offset-4 transition-colors hover:decoration-fg"
            >
              {entry.link.label}
            </a>
          </p>
        )}
      </article>
    </li>
  )
}
