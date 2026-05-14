import type { Metadata } from "next"
import { CatalogLanding } from "@/components/catalog/CatalogLanding"

export const metadata: Metadata = {
  title: "Artist catalog",
  description:
    "Public on-chain catalog where an artist can publish the contracts, tokens, and token ranges that belong in their catalog.",
}

export default function RecordHomePage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-10 space-y-8">
      <header className="space-y-2">
        <div className="text-xs uppercase tracking-wide text-gray-500">
          Artist catalog
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">
          Your on-chain artist catalog
        </h1>
        <p className="text-sm text-gray-600">
          A public catalog of the contracts, tokens, and token ranges
          you want associated with your work. It is generic public
          infrastructure: anyone can index it, no platform owns it.
        </p>
      </header>

      <CatalogLanding />

      <div className="border border-gray-200 rounded-md p-5 space-y-3">
        <h2 className="font-semibold">What does the catalog mean?</h2>
        <p className="text-sm text-gray-600">
          Adding a pointer means: <em>this artist address added this
          pointer to its public catalog.</em> It does not prove
          authorship, ownership, or endorsement. Downstream tools
          interpret what each pointer means.
        </p>
        <p className="text-sm text-gray-600">
          You can declare:
        </p>
        <ul className="text-sm text-gray-600 space-y-1 list-disc pl-5">
          <li>Whole contracts that belong in your catalog</li>
          <li>Single tokens on contracts (e.g. specific 1/1s)</li>
          <li>Token ranges (e.g. a drop you shipped)</li>
        </ul>
      </div>
    </div>
  )
}
