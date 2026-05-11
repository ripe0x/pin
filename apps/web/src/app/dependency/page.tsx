import type { Metadata } from "next"
import { DependencyScanForm } from "@/components/dependency/DependencyScanForm"
import { InitialFieldNote } from "@/components/dependency/InitialFieldNote"

export const metadata: Metadata = {
  title: "Artist dependency report",
  description:
    "Enter an artist wallet to see where the work lives, which contracts it sits on, and which systems around it may need a closer look.",
}

export default function DependencyHomePage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-10 space-y-8">
      <header className="space-y-2">
        <div className="text-xs uppercase tracking-wide text-gray-500">
          Artist systems report
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">
          Artist dependency report
        </h1>
        <p className="text-sm text-gray-600">
          Enter an artist wallet to see where the work lives, which contracts
          it sits on, and which systems around it may need a closer look.
        </p>
      </header>

      <DependencyScanForm />

      <InitialFieldNote />
    </div>
  )
}
