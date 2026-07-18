"use client"

/**
 * Tertiary slide-out for the raw, developer-facing metadata: the full parsed
 * tokenURI JSON and the raw tokenURI string. A subtle trigger opens a drawer
 * from the right; the data is read straight from the token contract's tokenURI
 * (see getPieceToken). Parsed attribute traits live in their own always-visible
 * section (TokenAttributes), not here.
 */

import { useEffect, useState } from "react"

function safeStringify(o: unknown): string {
  try {
    return JSON.stringify(o, null, 2)
  } catch {
    return String(o)
  }
}

export function MetadataDrawer({
  rawTokenUri,
  metadata,
}: {
  rawTokenUri: string
  metadata: Record<string, unknown> | null
}) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    window.addEventListener("keydown", onKey)
    document.body.style.overflow = "hidden"
    return () => {
      window.removeEventListener("keydown", onKey)
      document.body.style.overflow = ""
    }
  }, [open])

  const prettyJson = metadata ? safeStringify(metadata) : null

  return (
    <div className="pt-5">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-[10px] font-mono uppercase tracking-wider text-gray-400 underline underline-offset-2 hover:text-fg"
      >
        Onchain metadata ↗
      </button>

      <div className={`fixed inset-0 z-50 ${open ? "" : "pointer-events-none"}`} aria-hidden={!open}>
        <div
          onClick={() => setOpen(false)}
          className={`absolute inset-0 bg-black/40 transition-opacity duration-300 ${open ? "opacity-100" : "opacity-0"}`}
        />
        <aside
          role="dialog"
          aria-label="Onchain metadata"
          className={`absolute right-0 top-0 flex h-full w-[min(92vw,540px)] flex-col border-l border-gray-200 bg-surface shadow-xl transition-transform duration-300 ${open ? "translate-x-0" : "translate-x-full"}`}
        >
          <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
            <h2 className="text-[11px] font-mono uppercase tracking-wider text-gray-500">
              Onchain metadata
            </h2>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="text-gray-400 hover:text-fg leading-none"
            >
              ✕
            </button>
          </div>

          <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
            {prettyJson ? (
              <Block label="Parsed metadata (JSON)" copyText={prettyJson}>
                <Pre>{prettyJson}</Pre>
              </Block>
            ) : (
              <p className="text-[11px] font-mono text-gray-500">
                tokenURI is not a decodable JSON data URI.
              </p>
            )}
            <Block
              label={`Token URI (raw · ${rawTokenUri.length.toLocaleString()} chars)`}
              copyText={rawTokenUri}
              openHref={rawTokenUri}
            >
              <Pre>{rawTokenUri}</Pre>
            </Block>
          </div>
        </aside>
      </div>
    </div>
  )
}

function Pre({ children }: { children: React.ReactNode }) {
  return (
    <pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap break-all rounded border border-gray-200 bg-surface-muted/40 p-2 text-[10px] font-mono leading-relaxed text-gray-600">
      {children}
    </pre>
  )
}

function Block({
  label,
  copyText,
  openHref,
  children,
}: {
  label: string
  copyText: string
  openHref?: string
  children: React.ReactNode
}) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(copyText)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable */
    }
  }
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-mono uppercase tracking-wider text-gray-400">{label}</span>
        <span className="flex items-center gap-3">
          {openHref && (
            <a
              href={openHref}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] font-mono uppercase tracking-wider text-gray-400 underline hover:text-fg"
            >
              Open ↗
            </a>
          )}
          <button
            type="button"
            onClick={copy}
            className="text-[10px] font-mono uppercase tracking-wider text-gray-400 hover:text-fg"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </span>
      </div>
      {children}
    </div>
  )
}
