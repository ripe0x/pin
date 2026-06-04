import type { Metadata } from "next"
import { CreateEditionForm } from "@/components/editions/CreateEditionForm"

export const metadata: Metadata = {
  title: "New edition",
  description: "Deploy your own ERC721A edition in one step.",
}

export default function NewEditionPage() {
  return (
    <div className="mx-auto max-w-xl px-4 py-10 md:py-14 space-y-6">
      <header className="space-y-2">
        <h1 className="text-xl md:text-2xl font-medium tracking-tight">Create an edition</h1>
        <p className="text-sm text-fg-muted leading-relaxed">
          One step, one transaction: configure your edition and deploy your own
          ERC721A contract. You own it. Every token a collector mints keeps its
          own identity and onchain Mint Mark.
        </p>
      </header>
      <CreateEditionForm />
    </div>
  )
}
