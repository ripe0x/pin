"use client"

import { useEffect } from "react"

/** Root error boundary for pages without a segment-level one. */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("Page error:", error)
  }, [error])

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <div className="mx-auto max-w-md text-center">
        <h1 className="text-xl font-semibold">Could not load this page.</h1>
        <p className="mt-2 text-sm text-gray-600">This usually clears in a moment.</p>
        <button
          type="button"
          onClick={reset}
          className="mt-6 inline-flex items-center justify-center rounded border border-fg px-4 py-2 text-sm font-medium text-fg transition-colors hover:bg-fg hover:text-bg"
        >
          Try again
        </button>
        {error.digest && (
          <p className="mt-6 text-xs text-gray-400">Reference: {error.digest}</p>
        )}
      </div>
    </div>
  )
}
