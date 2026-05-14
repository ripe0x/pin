"use client"

import { useEffect, useState } from "react"

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

export type TokenInfo = {
  name: string | null
  description: string | null
  image: string | null
}

/**
 * Fetch metadata for a single token via the existing `/api/meta`
 * route. Used by the Add form's preview when the artist enters a
 * single token ID — they see name + thumbnail to confirm they have
 * the right one.
 *
 * `null` token id (e.g. blank input or a range) returns no data.
 */
export function useTokenInfo(
  contract: string,
  tokenId: string | null,
  debounceMs = 350,
) {
  const [data, setData] = useState<TokenInfo | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const c = contract.trim()
    if (!ADDRESS_RE.test(c) || !tokenId) {
      setData(null)
      setIsLoading(false)
      setError(null)
      return
    }
    setIsLoading(true)
    setError(null)
    const ctrl = new AbortController()
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/meta/${c.toLowerCase()}/${tokenId}`, {
          signal: ctrl.signal,
        })
        if (!res.ok) {
          setData(null)
          setIsLoading(false)
          return
        }
        const json = (await res.json()) as {
          metadata: { name?: string; description?: string; image?: string } | null
          mediaUri: string | null
        }
        if (!json.metadata) {
          setData(null)
        } else {
          setData({
            name: json.metadata.name ?? null,
            description: json.metadata.description ?? null,
            image: json.mediaUri ?? json.metadata.image ?? null,
          })
        }
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
  }, [contract, tokenId, debounceMs])

  return { data, isLoading, error }
}
