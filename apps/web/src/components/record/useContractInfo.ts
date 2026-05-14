"use client"

import { useEffect, useState } from "react"

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

export type ContractInfo = {
  address: string
  hasBytecode: boolean
  name: string | null
  symbol: string | null
  totalSupply: string | null
  isERC721: boolean
  isERC1155: boolean
}

/**
 * Fetch lightweight contract identity (name / symbol / standard /
 * totalSupply / has-bytecode) from `/api/contract-info`. Debounced so
 * a user typing an address doesn't fire a request on every keystroke.
 *
 * Returns:
 *   - `data` once the most-recent valid address has resolved
 *   - `isLoading` while a request is in flight
 *   - `error` when the request failed (non-fatal; the form still allows submission)
 *
 * On the client the request is plain fetch — the route caches L2 + L1
 * server-side, so repeated lookups are free across users.
 */
export function useContractInfo(address: string, debounceMs = 350) {
  const [data, setData] = useState<ContractInfo | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const trimmed = address.trim()
    if (!ADDRESS_RE.test(trimmed)) {
      setData(null)
      setIsLoading(false)
      setError(null)
      return
    }
    const lower = trimmed.toLowerCase()
    if (data && data.address === lower) return

    setIsLoading(true)
    setError(null)
    const ctrl = new AbortController()
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/contract-info/${lower}`, {
          signal: ctrl.signal,
        })
        if (!res.ok) throw new Error(`lookup ${res.status}`)
        const json = (await res.json()) as ContractInfo
        setData(json)
      } catch (e) {
        if ((e as Error).name === "AbortError") return
        setError((e as Error).message)
        setData(null)
      } finally {
        setIsLoading(false)
      }
    }, debounceMs)

    return () => {
      ctrl.abort()
      clearTimeout(timer)
    }
  }, [address, debounceMs, data])

  return { data, isLoading, error }
}
