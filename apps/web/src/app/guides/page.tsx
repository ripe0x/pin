import type { Metadata } from "next"
import Link from "next/link"

const TITLE = "Guides"
const DESCRIPTION =
  "Plain-language explanations of how PND works. The contracts, the tools, and the tradeoffs."

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: { title: TITLE, description: DESCRIPTION, type: "website" },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
}

type Guide = {
  href: string
  title: string
  blurb: string
}

const GUIDES: Guide[] = [
  {
    href: "/auctions",
    title: "Artist-owned auction contracts",
    blurb:
      "How the auction contracts work, who deploys and owns them, how listing, bidding, and settlement happen, and what happens if PND's frontend disappears.",
  },
]

export default function GuidesIndexPage() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-12 space-y-8">
      <header className="space-y-4">
        <h1 className="text-3xl font-semibold tracking-tight">Guides</h1>
        <p className="text-base text-fg-muted leading-relaxed">
          Plain-language explanations of how PND works. The contracts,
          the tools, and the tradeoffs. More guides will land here as
          common questions show up.
        </p>
      </header>

      <ul className="space-y-6">
        {GUIDES.map((g) => (
          <li key={g.href}>
            <Link
              href={g.href}
              className="group block space-y-2 border-l-2 border-gray-200 pl-4 transition-colors hover:border-fg"
            >
              <h2 className="text-lg font-medium text-fg group-hover:underline">
                {g.title}
              </h2>
              <p className="text-sm text-fg-muted leading-relaxed">
                {g.blurb}
              </p>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
