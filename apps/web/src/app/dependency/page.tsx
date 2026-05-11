import type { Metadata } from "next"
import { DependencyScanForm } from "@/components/dependency/DependencyScanForm"
import { InitialFieldNote } from "@/components/dependency/InitialFieldNote"

export const metadata: Metadata = {
  title: "Artist dependency check",
  description:
    "Enter an artist wallet to see what PND can verify today, what needs review, and what still needs checking.",
}

export default function DependencyHomePage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-10 space-y-8">
      <header className="space-y-2">
        <div className="text-xs uppercase tracking-wide text-gray-500">
          Artist dependency scan
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">
          Artist dependency check
        </h1>
        <p className="text-sm text-gray-600">
          Enter an artist wallet to see what PND can verify today, what
          needs review, and what still needs checking.
        </p>
      </header>

      <DependencyScanForm />

      <InitialFieldNote />
    </div>
  )
}
