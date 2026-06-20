"use client"

/**
 * Developer-facing metadata viewer for a token: the parsed attributes, the full
 * decoded metadata JSON, and the raw `tokenURI` string exactly as the contract
 * returns it. Data is read straight from the token contract's `tokenURI`
 * (see getPieceToken) — this just presents it.
 */

import { Fragment, useState } from "react"

type Attr = { trait_type?: string; value?: unknown; display_type?: string }

function formatVal(v: unknown): string {
  if (v === null || v === undefined) return "—"
  if (typeof v === "object") {
    try {
      return JSON.stringify(v)
    } catch {
      return String(v)
    }
  }
  return String(v)
}

function safeStringify(o: unknown): string {
  try {
    return JSON.stringify(o, null, 2)
  } catch {
    return String(o)
  }
}

export function TokenMetadataViewer({
  rawTokenUri,
  metadata,
}: {
  rawTokenUri: string
  metadata: Record<string, unknown> | null
}) {
  const attributes = Array.isArray(metadata?.attributes)
    ? (metadata.attributes as Attr[])
    : []
  const prettyJson = metadata ? safeStringify(metadata) : null

  return (
    <section className="py-5 border-b border-gray-100 space-y-4">
      <h2 className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
        Onchain metadata
      </h2>

      {attributes.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">Attributes</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[11px] font-mono">
            {attributes.map((a, i) => (
              <Fragment key={i}>
                <dt className="text-gray-400 break-words">{a.trait_type ?? "—"}</dt>
                <dd className="text-right break-words tabular-nums">{formatVal(a.value)}</dd>
              </Fragment>
            ))}
          </dl>
        </div>
      )}

      {prettyJson ? (
        <Collapsible label="Parsed metadata (JSON)" copyText={prettyJson} defaultOpen>
          <Pre>{prettyJson}</Pre>
        </Collapsible>
      ) : (
        <p className="text-[11px] font-mono text-gray-500">
          tokenURI is not a decodable JSON data URI.
        </p>
      )}

      <Collapsible
        label={`Token URI (raw · ${rawTokenUri.length.toLocaleString()} chars)`}
        copyText={rawTokenUri}
        openHref={rawTokenUri}
      >
        <Pre>{rawTokenUri}</Pre>
      </Collapsible>
    </section>
  )
}

function Pre({ children }: { children: React.ReactNode }) {
  return (
    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded border border-gray-200 bg-surface-muted/40 p-2 text-[10px] font-mono leading-relaxed text-gray-600">
      {children}
    </pre>
  )
}

function Collapsible({
  label,
  copyText,
  openHref,
  defaultOpen = false,
  children,
}: {
  label: string
  copyText: string
  openHref?: string
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
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
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="text-[10px] font-mono uppercase tracking-wider text-gray-400 hover:text-fg"
        >
          {open ? "▾" : "▸"} {label}
        </button>
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
      {open && children}
    </div>
  )
}
