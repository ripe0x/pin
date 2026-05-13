import type { Metadata } from "next"

const TITLE = "Cancel marketplace listings in one transaction"
const DESCRIPTION =
  "How the bulk delist tool works across Foundation and SuperRare, which listings it can cancel, and what the tool costs (gas only, no fees)."

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: { title: TITLE, description: DESCRIPTION, type: "website" },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
}

export default function DelistGuidePage() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-12 space-y-8">
      <header className="space-y-5">
        <h1 className="text-3xl font-semibold tracking-tight">
          Cancel marketplace listings in one transaction
        </h1>
        <p className="text-base text-fg-muted leading-relaxed">
          The bulk delist tool reads your active listings off the
          Foundation and SuperRare contracts and lets you cancel them
          in one batched transaction. You pay gas. There are no fees,
          and nothing routes through this site.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          Try it at{" "}
          <a
            href="/delist"
            className="underline hover:text-fg transition-colors"
          >
            /delist
          </a>
          .
        </p>
      </header>

      <section className="space-y-4">
        <h2 className="text-xl sm:text-2xl font-semibold tracking-tight pt-4">
          What it cancels
        </h2>
        <p className="text-base text-fg-muted leading-relaxed">
          The tool scans the marketplace contracts directly and
          surfaces every listing the connected wallet still owns. Today
          it supports:
        </p>
        <ul className="text-base text-fg-muted leading-relaxed list-disc pl-6 space-y-2">
          <li>
            Foundation reserve auctions that have not received a bid
            (Foundation only allows cancelling before the first bid
            arrives).
          </li>
          <li>Foundation buy-now listings.</li>
          <li>SuperRare V2 auctions.</li>
        </ul>
        <p className="text-base text-fg-muted leading-relaxed">
          More platforms can be added as adapters. The cancel
          dispatcher is platform-aware, so any marketplace whose cancel
          path is exposed onchain can be plugged in.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl sm:text-2xl font-semibold tracking-tight pt-4">
          One signature, many cancels
        </h2>
        <p className="text-base text-fg-muted leading-relaxed">
          Each cancel is a separate contract call. Cancelling ten
          listings would normally mean signing ten transactions.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          Smart wallets that support EIP-5792 batched calls,
          including Coinbase Smart Wallet, Safe, and any EIP-7702
          delegated wallet, can bundle all of those cancels into a
          single signature. The tool detects this automatically and
          submits one bundle.
        </p>
        <p className="text-base text-fg-muted leading-relaxed">
          Wallets that do not support batching (MetaMask, Rabby, Frame,
          and most hardware-wallet setups) get the same outcome
          sequentially. You sign one cancel at a time and the tool
          surfaces per-listing progress with links to each transaction
          on Etherscan.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl sm:text-2xl font-semibold tracking-tight pt-4">
          What it costs
        </h2>
        <p className="text-base text-fg-muted leading-relaxed">
          Gas only. The tool charges no fees. It does not touch your
          NFTs or your ETH. Every cancel is signed by your wallet and
          sent directly to the marketplace contract.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl sm:text-2xl font-semibold tracking-tight pt-4">
          What gets refunded
        </h2>
        <p className="text-base text-fg-muted leading-relaxed">
          The NFT returns to your wallet once the cancel transaction
          confirms. For Foundation reserve auctions, since only
          zero-bid auctions are cancellable, no bidder refund is
          involved. For SuperRare V2 auctions and Foundation buy-now
          listings, cancelling restores the NFT and removes the
          listing record without affecting anyone else.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl sm:text-2xl font-semibold tracking-tight pt-4">
          Previewing without connecting
        </h2>
        <p className="text-base text-fg-muted leading-relaxed">
          You can paste any address or ENS name into{" "}
          <a
            href="/delist"
            className="underline hover:text-fg transition-colors"
          >
            /delist
          </a>{" "}
          and see what is currently listed. The data comes from public
          onchain reads, so anyone can verify their own work, or
          another artist&rsquo;s, without signing in. Cancelling
          requires connecting the wallet that owns the listings.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl sm:text-2xl font-semibold tracking-tight pt-4">
          What happens if this site goes away
        </h2>
        <p className="text-base text-fg-muted leading-relaxed">
          The cancel function on each marketplace contract is public
          and permissionless. You can call it from a block explorer
          or any wallet&rsquo;s contract-interaction view. This tool
          is a convenience layer that finds the right contracts and
          batches the calls. It is not in the path of the
          transaction.
        </p>
      </section>
    </div>
  )
}
