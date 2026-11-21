import type { Metadata } from "next"

const artwork = "/archive/singularity.gif"
const metadataFile = "/archive/singularity.metadata.json"
const token = "https://basescan.org/token/0x86A484FaC6642Bb86cd45DB2bc24f20d21E2cdc2?a=1"

export const metadata: Metadata = {
  title: "Singularity by ripe",
  description: "Singularity, exhibited in Minimal, curated by ranxdeer.",
  alternates: { canonical: "/archive/singularity" },
  openGraph: {
    title: "Singularity by ripe",
    description: "Exhibited in Minimal, curated by ranxdeer.",
    images: [{ url: artwork, alt: "Singularity by ripe" }],
  },
}

export default function SingularityArchivePage() {
  return (
    <article className="mx-auto max-w-5xl space-y-8 px-6 py-12">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Singularity</h1>
        <p>by ripe · Base · Token #1</p>
        <p className="text-fg-muted">
          Exhibited in <cite>Minimal</cite>, curated by ranxdeer.
        </p>
      </header>
      {/* A same-origin copy of the token's original GIF, not the portfolio rendition. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="h-auto w-full" src={artwork} width={2378} height={530} alt="Singularity by ripe" />
      <p className="text-fg-muted">
        Extreme gravitational forces and a breakdown of the conventional laws of physics.
      </p>
      <ul className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
        <li>
          <a className="underline" href={token}>
            View token on BaseScan
          </a>
        </li>
        <li>
          <a className="underline" href={metadataFile}>
            View original metadata
          </a>
        </li>
        <li>
          <a className="underline" href={artwork} download>
            Download original GIF
          </a>
        </li>
      </ul>
    </article>
  )
}
