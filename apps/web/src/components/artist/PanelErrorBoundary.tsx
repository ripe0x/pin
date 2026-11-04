"use client"

import { Component, type ReactNode } from "react"
import { useRouter } from "next/navigation"

/**
 * Catches a failed profile tab panel so one cold read can't take the
 * header and the other tabs down with it (the route's error.tsx would
 * replace the whole page). Retry re-runs the server render.
 */
export class PanelErrorBoundary extends Component<
  { label: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: unknown) {
    console.error(`[profile] ${this.props.label} panel failed:`, error)
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <PanelUnavailable
        label={this.props.label}
        onRetry={() => this.setState({ failed: false })}
      />
    )
  }
}

/** "Could not load" with a Retry that refreshes the server render. */
export function PanelUnavailable({
  label,
  onRetry,
}: {
  label: string
  onRetry?: () => void
}) {
  const router = useRouter()
  return (
    <div role="alert" className="rounded-md border border-gray-200 p-5">
      <p className="text-sm text-fg-muted">
        Could not load {label} right now. This usually clears in a moment.
      </p>
      <button
        type="button"
        onClick={() => {
          onRetry?.()
          router.refresh()
        }}
        className="mt-3 text-xs font-mono underline underline-offset-4 hover:text-gray-600"
      >
        Retry
      </button>
    </div>
  )
}
