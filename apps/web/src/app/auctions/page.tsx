import type { Metadata } from "next"

const TITLE = "Artist-owned auction contracts"
const DESCRIPTION =
  "How PND's artist-owned auction contracts work: who deploys them, who owns them, how listing, bidding, and settlement work, and what happens if PND disappears."

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: { title: TITLE, description: DESCRIPTION, type: "website" },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
}

export default function AuctionsGuidePage() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-12 space-y-8">
      <header className="space-y-5">
        <h1 className="text-3xl font-semibold tracking-tight">
          Artist-owned auction contracts
        </h1>
        <p className="text-base text-fg-muted leading-relaxed">
          PND lets an artist deploy and run their own onchain auction
          contract. This is a plain-language guide to how that works.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          The mechanics here are not exotic. They are an ERC-721 reserve
          auction with anti-snipe protection. The difference is who owns
          the contract.
        </p>
      </header>

      <section className="space-y-4">
        <h2 className="text-xl sm:text-2xl font-semibold tracking-tight pt-4">
          What the contract does
        </h2>
        <p className="text-base text-fg-muted leading-relaxed">
          An auction house contract holds NFTs you list, accepts ETH
          bids, enforces the reserve price and the 5% minimum bid
          increment, extends the auction by 15 minutes when a bid lands
          in the final 15 minutes (anti-snipe), and settles by sending
          the NFT to the winning bidder and the ETH to you, minus any
          protocol fee that was set when the contract was deployed.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          One contract per owner. One auction per token at a time.
          ETH-only. ERC-721 only.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl sm:text-2xl font-semibold tracking-tight pt-4">
          Who deploys it
        </h2>
        <p className="text-base text-fg-muted leading-relaxed">
          You do. A factory contract handles the deployment. You sign one
          transaction and you get back an auction house contract that is
          yours. The transaction is cheap because the factory uses a
          minimal-proxy clone, so the per-deploy cost is closer to a
          token transfer than to deploying a full contract.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          The factory only lets one auction house exist per wallet. If
          you already have one, the factory will point you to it instead
          of deploying a second.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl sm:text-2xl font-semibold tracking-tight pt-4">
          Who owns it
        </h2>
        <p className="text-base text-fg-muted leading-relaxed">
          The wallet that called the factory. That is locked at deploy
          time. The owner cannot be transferred and cannot be renounced.
          PND has no admin role, no upgrade path, no pause switch, and
          no ability to change any of the contract&rsquo;s parameters
          after deployment.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          If you want different terms, you deploy a new contract under a
          different wallet from a different factory.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl sm:text-2xl font-semibold tracking-tight pt-4">
          How listing works
        </h2>
        <p className="text-base text-fg-muted leading-relaxed">
          You call <code className="font-mono text-sm">createAuction</code>{" "}
          on your house with the NFT&rsquo;s contract address, its token
          ID, a duration, and a reserve price. The contract takes
          custody of the NFT in the same transaction.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          The clock does not start when you list. It starts on the first
          bid that meets the reserve. Before that first bid, you can
          edit the reserve price, cancel the auction, or just leave it
          sitting.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl sm:text-2xl font-semibold tracking-tight pt-4">
          How bidding works
        </h2>
        <p className="text-base text-fg-muted leading-relaxed">
          Anyone can bid. The first bid must meet or beat the reserve.
          Every later bid must beat the current high bid by at least 5%.
          When a new bid lands, the previous bidder is automatically
          refunded their ETH in the same transaction.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          If a bid arrives in the last 15 minutes, the auction extends
          by another 15 minutes. This keeps sniping at the last second
          from being a winning strategy.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          If a refund to a previous bidder ever fails (some smart-contract
          wallets reject the direct send), the refund is held inside the
          contract and that bidder can withdraw it at any time.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl sm:text-2xl font-semibold tracking-tight pt-4">
          How settlement works
        </h2>
        <p className="text-base text-fg-muted leading-relaxed">
          After the timer runs out, anyone can call{" "}
          <code className="font-mono text-sm">endAuction</code>. That
          single transaction transfers the NFT to the winning bidder and
          sends the ETH to you, minus the protocol fee if one was set
          when your house was deployed. The factory PND deploys from
          today sets that fee to zero.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          You do not have to be the one to settle. A collector,
          observer, or PND&rsquo;s frontend can call it on your behalf.
          Once settled, the slot is cleared and you can list the same
          token again later if you want.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl sm:text-2xl font-semibold tracking-tight pt-4">
          What PND&rsquo;s frontend does
        </h2>
        <p className="text-base text-fg-muted leading-relaxed">
          The frontend is a convenience layer. It lets you deploy your
          house in one click, list NFTs without opening a block explorer,
          browse other artists&rsquo; houses, place bids, see live
          activity, and settle auctions. There is also a per-artist site
          template that reads a single house directly, so an artist can
          point collectors at their own URL.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          The frontend reads the contracts. It is not in the path of any
          transaction. Bids are signed by the bidder and sent to the
          contract directly. ETH and NFTs never pass through PND.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl sm:text-2xl font-semibold tracking-tight pt-4">
          What happens if PND&rsquo;s frontend disappears
        </h2>
        <p className="text-base text-fg-muted leading-relaxed">
          The auction contracts keep working.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          You can list, cancel, settle, recover stuck tokens, and edit
          reserves directly against the contract from a block explorer
          or any wallet&rsquo;s contract-interaction view. Bidders can
          place bids, withdraw failed refunds, and trigger settlement
          the same way. The contracts have no dependency on PND being
          online.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          Anyone can also build a new frontend on top of the same
          contracts. The factory and the houses are public and
          permissionless to read. Other interfaces can coexist with
          PND&rsquo;s, replace it, or specialize in a slice of it.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl sm:text-2xl font-semibold tracking-tight pt-4">
          Why this is useful
        </h2>
        <p className="text-base text-fg-muted leading-relaxed">
          You own the selling layer for your own work. The contract
          cannot be reassigned away from you, the fee is whatever was
          set at deploy and cannot be raised on you, and listings cannot
          be silently removed by a third party. If a platform you
          previously sold through closes, takes a listing down, or
          changes terms, none of that affects auctions that live in
          your own contract.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          Provenance reads cleanly too. The collector record points at
          your contract, not at a marketplace router.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl sm:text-2xl font-semibold tracking-tight pt-4">
          Tradeoffs vs a shared platform contract
        </h2>
        <p className="text-base text-fg-muted leading-relaxed">
          A shared marketplace already has an audience, a search index,
          a feed, and a brand collectors recognize. An artist-owned
          contract has whoever the artist brings. Distribution is the
          honest tradeoff.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          You also take on a little operational responsibility. You
          (or your collector, or PND&rsquo;s frontend) call settle,
          you decide reserves, you decide when to list. The contract
          will not chase a buyer for you.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          Liquidity does not pool. Your house is not part of a global
          order book. For some artists that is a feature; for others
          it is a real cost.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          A platform can still add taste, curation, context, and a
          collector relationship around your contract. Those things
          do not require owning the contract itself. Artist-owned
          contracts are about removing the dependency on any single
          platform existing forever, not about replacing what platforms
          actually do well.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl sm:text-2xl font-semibold tracking-tight pt-4">
          Getting started
        </h2>
        <p className="text-base text-fg-muted leading-relaxed">
          Deploy your house at{" "}
          <a
            href="/auction/new"
            className="underline hover:text-fg transition-colors"
          >
            /auction/new
          </a>
          . If you want a dedicated site for your auctions, see{" "}
          <a
            href="/sites"
            className="underline hover:text-fg transition-colors"
          >
            /sites
          </a>
          .
        </p>
      </section>
    </div>
  )
}
