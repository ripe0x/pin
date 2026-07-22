export default function AboutPage() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-12 space-y-8">
      <header className="space-y-5">
        <h1 className="text-3xl font-semibold tracking-tight">What PND is</h1>
        <p className="text-base text-fg-muted leading-relaxed">
          PND helps artists preserve, publish, auction, and operate their
          work with more control over the systems around it.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          The work, the contract, the auction, and the provenance can all
          live on Ethereum. PND exists so the layer between an artist and
          that work (pinning, listing, bidding, settling, viewing) does
          not have to depend on a single platform staying online.
        </p>
      </header>

      <section className="space-y-4">
        <h2 className="text-xl sm:text-2xl font-semibold tracking-tight pt-4">
          Why it started
        </h2>
        <p className="text-base text-fg-muted leading-relaxed">
          PND started after Foundation announced it was closing.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          The work was still there. The contracts were still there. The
          records were still there. But the main interface artists and
          collectors used to see, manage, list, delist, and bid on that
          work was going away.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          That made the dependency visible. Artists on Ethereum should not
          have to rely on a platform existing forever to preserve, manage,
          sell, or move their work.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl sm:text-2xl font-semibold tracking-tight pt-4">
          What PND has shipped
        </h2>
        <p className="text-base text-fg-muted leading-relaxed">
          PND has grown one tool at a time, in response to what artists
          actually needed.
        </p>
        <ul className="text-base text-fg-muted leading-relaxed space-y-3 list-none">
          <li>
            <strong className="text-fg font-medium">Preserve.</strong> Pin
            your own work to IPFS so the media is not tied to any single
            host.
          </li>
          <li>
            <strong className="text-fg font-medium">Foundation tools.</strong>{" "}
            Interact with existing Foundation auction contracts after the
            original frontend was gone. Delist work where needed.
          </li>
          <li>
            <strong className="text-fg font-medium">
              Artist-owned auctions.
            </strong>{" "}
            Deploy your own auction contract that you control. Zero
            platform fees. No upgrade path controlled by PND.
          </li>
          <li>
            <strong className="text-fg font-medium">A bidding frontend.</strong>{" "}
            Browse, list, and bid through PND. Each artist also gets a
            site that reads their auction contract directly.
          </li>
          <li>
            <strong className="text-fg font-medium">Surface.</strong>{" "}
            Publish editions and generative releases from a collection
            contract you own. Collectors can mint through PND or through
            a page the artist hosts themselves, on the same contracts.
          </li>
        </ul>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl sm:text-2xl font-semibold tracking-tight pt-4">
          Fees
        </h2>
        <p className="text-base text-fg-muted leading-relaxed">
          PND&apos;s contracts take no protocol fee, and auctions have no
          PND fee at all.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          On Surface mints, a referral share of up to 10% of the mint
          price goes to whichever interface hosts the mint. Minting
          through PND, that share supports PND. Minting on the
          artist&apos;s own site, the artist keeps it. Which interface to
          use, and what the share is, stays the artist&apos;s choice.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl sm:text-2xl font-semibold tracking-tight pt-4">
          What PND is not trying to do
        </h2>
        <p className="text-base text-fg-muted leading-relaxed">
          PND is not trying to replace every platform.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          Platforms can still provide taste, trust, curation, context,
          distribution, and collector relationships. Those are real and
          they take work to build.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          PND covers the layer underneath that. The pieces that should
          keep working whether or not any particular platform stays
          online.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl sm:text-2xl font-semibold tracking-tight pt-4">
          The point
        </h2>
        <p className="text-base text-fg-muted leading-relaxed">
          PND exists so artists are not dependent on a platform existing
          forever to preserve, manage, sell, or move their work.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          The project is open source and built in public. It was created
          by{" "}
          <a
            href="https://x.com/ripe0x"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-fg transition-colors"
          >
            ripe
          </a>
          , an artist and developer working onchain.
        </p>
      </section>
    </div>
  )
}
