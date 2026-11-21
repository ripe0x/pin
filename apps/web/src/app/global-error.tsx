"use client"

import { useEffect } from "react"

/**
 * Last-resort boundary for errors in the root layout itself. It replaces the
 * layout, so it renders its own <html>/<body> and uses inline styles rather
 * than the site stylesheet, which may not have loaded.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("Root layout error:", error)
  }, [error])

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "system-ui, -apple-system, sans-serif",
          background: "#fff",
          color: "#111",
        }}
      >
        <div style={{ maxWidth: 420, padding: 24, textAlign: "center" }}>
          <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Something went wrong.</h1>
          <p style={{ marginTop: 8, fontSize: 14, color: "#555" }}>
            This usually clears in a moment.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: 24,
              padding: "8px 16px",
              fontSize: 14,
              fontWeight: 500,
              border: "1px solid #111",
              borderRadius: 4,
              background: "transparent",
              color: "#111",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
          {error.digest && (
            <p style={{ marginTop: 24, fontSize: 12, color: "#999" }}>Reference: {error.digest}</p>
          )}
        </div>
      </body>
    </html>
  )
}
