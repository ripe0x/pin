import type { Metadata } from "next"
import { Suspense } from "react"
import { SupportersList } from "@/components/SupportersList"

export const metadata: Metadata = {
  title: "Supporters",
  description: "The collectors and artists who supported PND's independent infrastructure.",
}

export default function SupportersPage() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <header className="max-w-2xl space-y-3">
        <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
          Community
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">PND supporters</h1>
        <p className="text-sm leading-relaxed text-gray-500">
          Artists and collectors who helped fund artist-owned infrastructure.
          Some people are both, which is exactly the point.
        </p>
      </header>
      <div className="mt-10">
        <Suspense
          fallback={<p className="text-xs font-mono text-gray-400">Loading supporters…</p>}
        >
          <SupportersList />
        </Suspense>
      </div>
    </main>
  )
}
