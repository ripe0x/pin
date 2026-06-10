import type { Metadata } from "next"
import Link from "next/link"
import { CreateReleaseForm } from "@/components/releases/CreateReleaseForm"
import { getFactorySurfaceFee } from "@/lib/releases-onchain"
import { releaseFactoryAddress } from "@/lib/releases"

export const metadata: Metadata = {
  title: "Open a release",
  description:
    "Deploy your own release contract: a timed open edition with your terms fixed in bytecode. You get 100% of your price.",
}

export default async function NewReleasePage() {
  const factory = releaseFactoryAddress()
  const surfaceFee = factory ? await getFactorySurfaceFee(factory) : null

  return (
    <div className="mx-auto max-w-xl px-4 py-10 md:py-16 space-y-8">
      <header className="space-y-3">
        <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
          <Link href="/releases" className="hover:text-fg transition-colors">
            Releases
          </Link>{" "}
          / new
        </p>
        <h1 className="text-2xl font-medium tracking-tight">Open a release</h1>
        <p className="text-sm text-fg-muted leading-relaxed">
          One transaction deploys your own contract with the terms fixed
          forever: price, window, supply, gate. Free means gas only. You get
          everything you priced. The surface earns only when chosen.
        </p>
      </header>
      <CreateReleaseForm surfaceFeeWei={surfaceFee} />
    </div>
  )
}
