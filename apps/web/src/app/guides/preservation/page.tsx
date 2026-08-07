import type { Metadata } from "next"
import Link from "next/link"

const TITLE = "What preservation means"
const DESCRIPTION =
  "How to read a work's preservation grade: what it needs to render, what is locked, and what is fragile. The liveness tiers in plain language."

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: { title: TITLE, description: DESCRIPTION, type: "website" },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
}

function Tier({ name, blurb }: { name: string; blurb: string }) {
  return (
    <div className="space-y-1">
      <h3 className="text-sm font-medium tracking-tight">{name}</h3>
      <p className="text-sm text-fg-muted leading-relaxed">{blurb}</p>
    </div>
  )
}

export default function PreservationGuidePage() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-12 space-y-10">
      <header className="space-y-5">
        <h1 className="text-3xl font-semibold tracking-tight">{TITLE}</h1>
        <p className="text-base text-fg-muted leading-relaxed">
          Every collection and token page shows a Preservation card: a short
          list of facts about what the work needs to render and what the artist
          has locked. The facts are derived from what is verifiable onchain,
          and nothing is overstated. This page explains what they mean.
        </p>
      </header>

      <section className="space-y-4">
        <h2 className="text-xl font-medium tracking-tight">The liveness tiers</h2>
        <p className="text-sm text-fg-muted leading-relaxed">
          Liveness is what a work reads at the moment it renders. The less it
          depends on, the longer it keeps rendering unchanged.
        </p>
        <div className="space-y-5 pt-1">
          <Tier
            name="Pure onchain"
            blurb="Renders from chain data alone: the token's seed and the code stored onchain, nothing else. Given the same chain, it produces the same image indefinitely. A work rendered as an onchain SVG, with no JavaScript runtime at all, is the strongest form of this."
          />
          <Tier
            name="Chain-live"
            blurb="Reads other onchain contracts at render time, so its output tracks that live state rather than freezing at mint. Homage to the Punk reads the CryptoPunks contract, so each piece follows its source punk. The dependency is onchain and permanent, but the output is not fixed."
          />
          <Tier
            name="External-live"
            blurb="Reads an offchain URL at render time. This is the most fragile shape: if the URL stops resolving, the work stops rendering as intended. A work is only marked this way when it genuinely depends on something outside the chain."
          />
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-medium tracking-tight">The other facts</h2>
        <div className="space-y-5 pt-1">
          <Tier
            name="Art code stored onchain"
            blurb="The work's code and its dependencies live in onchain storage, not on a server. Anyone can read and reassemble the exact document the renderer produces."
          />
          <Tier
            name="Renderer locked permanently"
            blurb="The renderer pointer is pinned and cannot be swapped. When it is not locked, the artist can still change how the work renders."
          />
          <Tier
            name="Static image captured"
            blurb="A static image stored onchain for marketplaces that cannot run the live work. For a chain-live work this image is a snapshot, not the work itself; the live render is always the source of truth."
          />
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-medium tracking-tight">Why derived, not declared</h2>
        <p className="text-sm text-fg-muted leading-relaxed">
          There is no onchain field that declares a work's tier today, so the
          grade is derived from verifiable facts and reviewed per work. When a
          fact cannot be established, the card says so ("liveness not declared")
          rather than guessing. A future onchain declaration can replace the
          reviewed data without changing what the card shows.
        </p>
      </section>

      <footer className="pt-4">
        <Link
          href="/collections"
          className="text-[11px] font-mono uppercase tracking-wider text-gray-400 underline hover:text-fg"
        >
          Browse collections
        </Link>
      </footer>
    </div>
  )
}
