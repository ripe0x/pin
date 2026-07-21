"use client"

// Allowlist Merkle proofs for the homage combined claim+allowlist window. The tree
// includes the curated list PLUS a snapshot of every punk holder (built by the homage
// repo's scripts/snapshot-punk-holders.mjs + build-allowlist.mjs); the proof file is
// vendored BYTE-IDENTICAL from the homage repo's data/allowlist-proofs.json — both
// frontends must verify against the same on-chain root, so re-vendor on any change.
//
// With ~4k punk holders the proofs file is ~3.6MB, so it is NOT statically imported
// (that would sink the mint bundle): it lives in public/data and loads lazily, once,
// the first time something actually needs a proof. Consumers must treat "not loaded
// yet" as UNKNOWN, never as "not allowlisted".

import {useEffect, useState} from "react"

export type ProofFile = {root: `0x${string}`; count: number; proofs: Record<string, `0x${string}`[]>}

let cache: Promise<ProofFile> | null = null

/** Fetch-and-cache the proof file (one request per session, ever). */
export function loadAllowlist(): Promise<ProofFile> {
  cache ??= fetch("/data/homage-allowlist-proofs.json").then((r) => {
    if (!r.ok) {
      cache = null // let a transient failure retry on next call
      throw new Error(`allowlist fetch failed: ${r.status}`)
    }
    return r.json() as Promise<ProofFile>
  })
  return cache
}

/** The Merkle proof for `address` in a loaded file, or null if not on the list. */
export function allowlistProofIn(data: ProofFile, address: string): `0x${string}`[] | null {
  return data.proofs[address.toLowerCase()] ?? null
}

// The full proof file is ~31MB (27k addresses). The pre-public CHECKER only needs
// membership, not proofs, so it loads this ~1MB address-only companion instead; the heavy
// proof file is fetched only when an actual mint needs a proof (post-deploy). Both are
// vendored from the same build, so `root` matches.
export type AddressFile = {root: `0x${string}`; count: number; addresses: string[]}

let addrCache: Promise<Set<string>> | null = null

/** Fetch-and-cache the lightweight membership set (lowercased). One request per session. */
export function loadAllowlistAddresses(): Promise<Set<string>> {
  addrCache ??= fetch("/data/homage-allowlist-addresses.json")
    .then((r) => {
      if (!r.ok) {
        addrCache = null // let a transient failure retry
        throw new Error(`allowlist addresses fetch failed: ${r.status}`)
      }
      return r.json() as Promise<AddressFile>
    })
    .then((d) => new Set(d.addresses.map((a) => a.toLowerCase())))
  return addrCache
}

/** Lazy membership hook: null while loading (UNKNOWN; never render a negative from null),
 *  the lowercased address Set after. Loads the ~1MB list, not the ~31MB proofs, so eligibility
 *  UI can resolve without pulling the heavy file; fetch the proof separately only at mint. */
export function useAllowlistMembership(enabled: boolean): Set<string> | null {
  const [members, setMembers] = useState<Set<string> | null>(null)
  useEffect(() => {
    if (!enabled || members) return
    let cancelled = false
    loadAllowlistAddresses()
      .then((s) => {
        if (!cancelled) setMembers(s)
      })
      .catch(() => {
        /* stays null; a later mount retries via the reset cache */
      })
    return () => {
      cancelled = true
    }
  }, [enabled, members])
  return members
}

/** Lazy allowlist hook: null while loading (UNKNOWN — callers must not render a
 *  negative state from it), the loaded file after. `enabled` defers the 3.6MB fetch
 *  until a surface actually needs eligibility (e.g. the allowlist window is open). */
export function useAllowlist(enabled: boolean): ProofFile | null {
  const [data, setData] = useState<ProofFile | null>(null)
  useEffect(() => {
    if (!enabled || data) return
    let cancelled = false
    loadAllowlist()
      .then((d) => {
        if (!cancelled) setData(d)
      })
      .catch(() => {
        /* stays null; a later mount retries via the reset cache */
      })
    return () => {
      cancelled = true
    }
  }, [enabled, data])
  return data
}
