"use client"

/**
 * Paste-in allowlist editor: one address per line (commas/extra whitespace
 * tolerated too), live count + validation, then a "Publish list" button
 * that stores it via the allowlist API and returns the root to activate.
 * Publishing is intentionally permissionless — see gate-api.ts / the API
 * route's doc comment for the trust model this leans on.
 */

import { useMemo, useState } from "react"
import { isAddress } from "viem"
import { BTN, ERROR, HELP, LABEL, TEXTAREA } from "@/components/studio/create/wizard-ui"
import { publishList } from "./gate-api"

function parseAddresses(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export function AllowlistEditor({
  collection,
  onPublished,
}: {
  collection: `0x${string}`
  onPublished: (root: `0x${string}`, count: number) => void
}) {
  const [raw, setRaw] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [published, setPublished] = useState<{ root: `0x${string}`; count: number } | null>(null)

  const parsed = useMemo(() => parseAddresses(raw), [raw])
  const invalid = useMemo(() => parsed.filter((a) => !isAddress(a)), [parsed])
  const unique = useMemo(
    () => new Set(parsed.filter((a) => isAddress(a)).map((a) => a.toLowerCase())),
    [parsed],
  )

  const canPublish = parsed.length > 0 && invalid.length === 0 && !busy

  async function handlePublish() {
    setBusy(true)
    setError(null)
    const result = await publishList(collection, parsed)
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setPublished({ root: result.root, count: result.count })
    onPublished(result.root, result.count)
  }

  return (
    <div className="space-y-3">
      <header className="space-y-1.5">
        <h3 className="text-sm font-medium">Allowlist</h3>
        <p className="text-xs text-gray-500 leading-relaxed">
          One address per line. Publishing stores the list and returns a
          root. It grants nothing on its own until you set that root as
          active in the activation queue below.
        </p>
      </header>

      <label className="block">
        <span className={LABEL}>Addresses</span>
        <textarea
          value={raw}
          onChange={(e) => {
            setRaw(e.target.value)
            setPublished(null)
            setError(null)
          }}
          placeholder={"0xabc…\n0xdef…\n0x123…"}
          spellCheck={false}
          rows={8}
          disabled={busy}
          className={TEXTAREA}
        />
      </label>

      <div className="flex items-center justify-between text-[10px] font-mono text-gray-400">
        <span>
          {unique.size} unique address{unique.size === 1 ? "" : "es"}
          {invalid.length > 0 && <span className="text-red-500"> · {invalid.length} invalid</span>}
        </span>
      </div>

      {invalid.length > 0 && (
        <p className={ERROR}>
          Not an address: {invalid.slice(0, 3).join(", ")}
          {invalid.length > 3 ? `, +${invalid.length - 3} more` : ""}
        </p>
      )}

      <button type="button" onClick={() => void handlePublish()} disabled={!canPublish} className={BTN}>
        {busy ? "Publishing…" : "Publish list"}
      </button>

      {error && <p className={ERROR}>{error}</p>}

      {published && (
        <div className="rounded border border-gray-200 bg-surface-muted/40 px-3 py-2.5 space-y-1">
          <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">Published</p>
          <p className="text-[11px] font-mono text-gray-600">
            Root {published.root.slice(0, 10)}…{published.root.slice(-6)} · {published.count} address
            {published.count === 1 ? "" : "es"}
          </p>
          <p className={HELP}>Set this as the active root below to make it grant anything.</p>
        </div>
      )}
    </div>
  )
}
