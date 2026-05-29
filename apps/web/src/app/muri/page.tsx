import { MuriMintFlow } from "@/components/muri/MuriMintFlow"

export default function MuriPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <header className="mx-auto mb-8 max-w-md">
        <h1 className="text-xl font-medium">Preserve on-chain</h1>
        <p className="mt-2 text-sm leading-relaxed text-gray-600">
          Mint a new token through the MURI protocol on your existing Manifold
          contract. Its artwork is pinned to IPFS across several gateways, and a
          SHA-256 integrity hash plus the fallback links are stored on-chain, so
          the piece stays verifiable even if one source disappears.
        </p>
        <p className="mt-2 text-xs text-gray-500">
          This mints a new piece. Tokens you&rsquo;ve already minted can&rsquo;t
          be converted to MURI.
        </p>
      </header>
      <MuriMintFlow />
    </main>
  )
}
