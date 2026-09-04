export default function AboutPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-12 space-y-12">
      <header className="space-y-5">
        <p className="text-[11px] font-mono font-medium uppercase tracking-wider text-gray-500">
          About PND
        </p>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-5xl">
          A venue for artist-owned releases.
        </h1>
        <p className="max-w-2xl text-lg text-fg-muted leading-relaxed">
          Artists can launch on PND, operate independently, or use the same
          release tools on their own sites. Collectors get a clear place to
          discover the work and a durable public record around it.
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
          What PND provides
        </h2>
        <p className="text-base text-fg-muted leading-relaxed">
          PND combines a public venue with infrastructure artists can carry
          elsewhere. The public experience starts with the work, while the
          underlying contracts and tools remain usable beyond this site.
        </p>
        <ul className="text-base text-fg-muted leading-relaxed space-y-3 list-none">
          <li>
            <strong className="text-fg font-medium">Releases.</strong>{" "}
            Publish editions, generative work, and other bodies of work from
            an artist-owned Surface contract.
          </li>
          <li>
            <strong className="text-fg font-medium">Auctions.</strong>{" "}
            Deploy and operate an artist-owned auction house with no PND fee
            and no PND-controlled upgrade path.
          </li>
          <li>
            <strong className="text-fg font-medium">Public record.</strong>{" "}
            Keep available, created, sold, transferred, and collected work
            legible without forcing artists and collectors into separate identities.
          </li>
          <li>
            <strong className="text-fg font-medium">Catalog.</strong>{" "}
            Let an artist declare the contracts and tokens that belong to
            their body of work through a general onchain registry.
          </li>
          <li>
            <strong className="text-fg font-medium">Preservation.</strong>{" "}
            Pin media and surface permanence information so the work is not
            silently tied to one application host.
          </li>
        </ul>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl sm:text-2xl font-semibold tracking-tight pt-4">
          Portability without a badge
        </h2>
        <p className="text-base text-fg-muted leading-relaxed">
          The contracts and release tools do not depend on PND remaining the
          primary interface. PND is building a shared release kit, exportable
          configuration, and guided deployment paths so an artist can use the
          same release on a site they control.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          PND does not label artists as “independent” or try to monitor what
          they do after exporting. A site link is shown only when an artist
          voluntarily provides one. Compatibility checks can confirm that a
          submitted page resolves and references the expected collection, but
          they cannot prove lasting ownership or permanence.
        </p>
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
          A venue, not a closed marketplace
        </h2>
        <p className="text-base text-fg-muted leading-relaxed">
          PND can provide presentation, context, distribution, and collector
          access while keeping the release infrastructure portable.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          Artists do not need to leave PND to demonstrate independence, and a
          missing external site is not unfinished work. The exit path exists
          because it is useful, not because PND needs to observe or score it.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          Editorially presented releases and the complete permissionless
          Surface record remain distinct. PND can exercise taste as a venue
          without hiding the underlying public record.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl sm:text-2xl font-semibold tracking-tight pt-4">
          The point
        </h2>
        <p className="text-base text-fg-muted leading-relaxed">
          PND exists to give artists a strong place to launch, portable tools
          to operate elsewhere, and a durable record that collectors can read.
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
