export default function AboutPage() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-12 space-y-8">
      <header className="space-y-5">
        <h1 className="text-3xl font-semibold tracking-tight">About PND</h1>
        <p className="text-base text-fg-muted leading-relaxed">
          PND is independent artist infrastructure for Ethereum.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          It helps artists run their own auctions, contracts, and sites
          without depending on a single platform frontend existing forever.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          PND was created by{" "}
          <a
            href="https://x.com/ripe0x"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-fg transition-colors"
          >
            ripe
          </a>
          , an artist and developer working onchain. It began from a problem
          he kept running into from different angles: artists can put work on
          Ethereum, but too much of the system around that work still depends
          on platforms they do not control.
        </p>
        <ul className="text-base text-fg-muted leading-relaxed space-y-1">
          <li>The artwork can live onchain.</li>
          <li>The contract can keep existing.</li>
          <li>The auction can still be valid.</li>
          <li>The provenance can still be there.</li>
        </ul>
        <p className="text-base text-fg-muted leading-relaxed">
          But when the only useful interface disappears, artists and
          collectors can lose practical access to the work.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          PND started from that gap.
        </p>
      </header>

      <section className="space-y-4">
        <h2 className="text-xl sm:text-2xl font-semibold tracking-tight pt-4">
          Why PND exists
        </h2>
        <p className="text-base text-fg-muted leading-relaxed">
          When Foundation shut down its marketplace, many artists still had
          work connected to Foundation contracts.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          The work was still there. The auctions were still there. The
          records were still there. But the main interface people used to
          see, manage, list, delist, and bid on that work was gone.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          That made the weak point obvious.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          Artists on Ethereum should not have to depend on a platform
          existing forever to preserve their media, manage their work, or
          sell through contracts that are already onchain.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          So PND started as a practical response.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          First, it helped artists pin their own work to IPFS.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          Then it helped artists view and access work that had been tied to
          Foundation.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          Then it added tools for interacting with Foundation auctions after
          the original frontend was gone.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          Then it added delisting.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          Then it added artist owned auction contracts.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          Then it added a way for artists to create their own auction sites
          around those contracts.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          The project kept growing because the problem was bigger than one
          platform.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl sm:text-2xl font-semibold tracking-tight pt-4">
          What PND does
        </h2>
        <p className="text-base text-fg-muted leading-relaxed">
          PND helps artists run their own auctions, contracts, and sites on
          Ethereum.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          Artists can use PND to preserve media, view supported work,
          interact with existing auction contracts, delist from old auction
          contracts, deploy their own auction contract, list work for sale,
          and share a dedicated site around their work.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          Collectors can use PND to view artist profiles, browse listed
          works, and bid directly through the relevant contracts.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          The goal is practical access.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          If the work exists on Ethereum, artists and collectors should be
          able to reach it.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl sm:text-2xl font-semibold tracking-tight pt-4">
          Artist owned auctions
        </h2>
        <p className="text-base text-fg-muted leading-relaxed">
          PND lets artists deploy their own auction contract.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          Each auction contract belongs to the artist who deploys it. It has
          zero platform fees. It has no upgrade path controlled by PND. It
          exists as a simple selling layer for the artist&rsquo;s work.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          PND can provide the frontend, but the contract does not depend on
          PND as the only way in.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          Other people can build on top of these contracts too.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          That matters because artists should not be trapped inside one
          interface, one company, or one point of failure.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl sm:text-2xl font-semibold tracking-tight pt-4">
          Why zero fees
        </h2>
        <p className="text-base text-fg-muted leading-relaxed">
          The PND auction contracts have zero platform fees.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          That choice is specific to the auction infrastructure PND
          provides. Platforms can still create real value through taste,
          trust, curation, audience, collector relationships, and context.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          When artists bring the audience, context, collectors, and demand,
          they should be able to sell their work without paying a toll.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          PND gives artists that option.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl sm:text-2xl font-semibold tracking-tight pt-4">
          The bigger idea
        </h2>
        <p className="text-base text-fg-muted leading-relaxed">
          Ethereum gives artists the ability to own more of the system
          around their work.
        </p>
        <ul className="text-base text-fg-muted leading-relaxed space-y-1">
          <li>The media.</li>
          <li>The metadata.</li>
          <li>The contract.</li>
          <li>The auction.</li>
          <li>The provenance.</li>
          <li>The collector relationship.</li>
          <li>The site where people encounter the work.</li>
        </ul>
        <p className="text-base text-fg-muted leading-relaxed">
          PND exists to make that ownership usable.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          Every artist does not need to become a developer. Every artist
          does not need custom infrastructure for every project.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          Artists should have the option.
        </p>
        <ul className="text-base text-fg-muted leading-relaxed space-y-1">
          <li>More capability means more freedom.</li>
          <li>More understanding means fewer dependencies.</li>
          <li>
            More artist owned infrastructure means the work has more ways to
            survive.
          </li>
        </ul>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl sm:text-2xl font-semibold tracking-tight pt-4">
          Current status
        </h2>
        <p className="text-base text-fg-muted leading-relaxed">
          PND is active, evolving, and open source.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          Some tools are polished. Some are early. The project is being
          built in public because the needs are real, the surface area is
          large, and the best version should be shaped by the artists who
          use it.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          PND began with a specific platform going away.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          The larger goal is to make artist owned infrastructure normal.
        </p>
      </section>
    </div>
  )
}
