"use client"

import { useState } from "react"
import { allowlistProofIn, useAllowlist } from "@/lib/homage/allowlist"

/**
 * Collapsible allowlist checker — a pure client-side lookup against the
 * build's baked merkle proofs (zero RPC, no wallet needed). Surfaced in every
 * phase up to the public mint (pre-mint teaser, claim, allowlist) so a visitor
 * can confirm eligibility before the allowlist window opens; hidden once
 * public is live, where anyone can mint and the check is moot.
 */
export function AllowlistCheck() {
  const [text, setText] = useState("")
  const trimmed = text.trim()
  const valid = /^0x[0-9a-fA-F]{40}$/.test(trimmed)
  // the 3.6MB proof file loads on the first valid input, not at page load
  const allowlist = useAllowlist(valid)
  const listed = valid && allowlist ? allowlistProofIn(allowlist, trimmed) !== null : null
  return (
    <details className="group">
      <summary className="font-mono text-[11px] text-(--dim) hover:text-(--ink) cursor-pointer list-none marker:content-none">
        <span className="group-open:hidden">▸ check an address against the allowlist</span>
        <span className="hidden group-open:inline">▾ allowlist checker</span>
      </summary>
      <div className="mt-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="0x…"
          spellCheck={false}
          className="w-full bg-transparent font-mono text-[12px] text-(--ink) outline-none border-b border-(--line) focus:border-(--ink) py-1"
          aria-label="address to check against the allowlist"
        />
        <p className="mt-1.5 font-mono text-[11px] min-h-4 text-(--dim)">
          {!trimmed
            ? ""
            : !valid
              ? "not an address"
              : !allowlist
                ? "checking…"
                : listed
                  ? "on the allowlist ✓"
                  : "not on the allowlist"}
        </p>
      </div>
    </details>
  )
}
