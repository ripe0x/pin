import type { Metadata } from "next"
import { CreateReleaseFlow } from "@/components/editions/CreateReleaseFlow"

export const metadata: Metadata = {
  title: "New release",
  description: "Deploy your own ERC721A contract and configure a release.",
}

export default function NewEditionPage() {
  return (
    <div className="mx-auto max-w-xl px-4 py-10 md:py-14 space-y-6">
      <header className="space-y-2">
        <h1 className="text-xl md:text-2xl font-medium tracking-tight">Create a release</h1>
        <p className="text-sm text-fg-muted leading-relaxed">
          Two onchain steps: deploy your project contract, then publish a
          release inside it. You own the contract. Each token a collector mints
          keeps its own identity and onchain Mint Mark.
        </p>
      </header>
      <CreateReleaseFlow />
    </div>
  )
}
