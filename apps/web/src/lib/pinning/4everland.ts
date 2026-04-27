import type { PinningProvider, PinResult, PinStatus } from "./types"

const FOUREVERLAND_API = "https://api.4everland.dev"

/** Strip any path suffix from a CID (e.g. "QmXXX/metadata.json" → "QmXXX") */
function baseCid(cid: string): string {
  const slash = cid.indexOf("/")
  return slash === -1 ? cid : cid.slice(0, slash)
}

/**
 * 4EVERLAND 4EVER Pin provider.
 *
 * Uses the standard IPFS Pinning Service API spec. Free tier allows
 * pin-by-CID (6 GB/month). Auth is a Bearer access token generated on
 * the 4EVER Pin dashboard.
 */
export class FourEverlandProvider implements PinningProvider {
  readonly name = "4EVERLAND"
  readonly type = "4everland" as const
  private token: string

  constructor(token: string) {
    this.token = token
  }

  private headers(): HeadersInit {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
    }
  }

  async pinByCid(cid: string, name?: string): Promise<PinResult> {
    const hash = baseCid(cid)

    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(`${FOUREVERLAND_API}/pins`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          cid: hash,
          name: name ?? `pin: ${hash.slice(0, 12)}`,
        }),
      })

      if (res.ok) {
        const data = await res.json()
        return { cid, status: mapStatus(data.status) }
      }

      const text = await res.text().catch(() => "")
      if (res.status === 409) {
        return { cid, status: "pinned" }
      }

      if (res.status === 429 && attempt < 2) {
        const wait = (attempt + 1) * 2000
        await new Promise((r) => setTimeout(r, wait))
        continue
      }

      if (res.status === 401 || res.status === 403) {
        throw new Error("4EVERLAND access token is invalid or lacks permissions. Regenerate it from the 4EVER Pin dashboard.")
      }
      if (res.status === 429) {
        throw new Error("4EVERLAND rate limit exceeded. Wait a minute and try again.")
      }

      throw new Error(`4EVERLAND pin failed (${res.status}): ${text.slice(0, 200)}`)
    }

    throw new Error("4EVERLAND pin failed after retries")
  }

  async checkPin(cid: string): Promise<PinStatus> {
    const hash = baseCid(cid)
    // Pass an explicit status filter — the IPFS Pinning Service spec
    // defaults to `pinned` only, which would hide queued/pinning pins.
    const url =
      `${FOUREVERLAND_API}/pins?cid=${hash}` +
      `&status=queued,pinning,pinned,failed&limit=1`
    try {
      const data = await this.fetchJsonWithRetry(url)
      if (data.results?.length > 0) {
        return mapStatus(data.results[0].status)
      }
      return "unknown"
    } catch {
      return "unknown"
    }
  }

  /**
   * Bulk pin-status lookup. Chunks input CIDs into groups of 10 (the
   * IPFS Pinning Service spec maximum for the `cid` filter) and
   * issues one request per chunk with retry-on-429.
   */
  async checkManyPins(cids: string[]): Promise<Map<string, PinStatus>> {
    const result = new Map<string, PinStatus>()
    if (cids.length === 0) return result

    // Group input CIDs by their base hash so we can map results back even
    // when the input had a /path suffix (e.g. "QmXXX/metadata.json").
    const byHash = new Map<string, string[]>()
    for (const cid of cids) {
      const h = baseCid(cid)
      const list = byHash.get(h)
      if (list) list.push(cid)
      else byHash.set(h, [cid])
    }

    const hashes = [...byHash.keys()]
    for (let i = 0; i < hashes.length; i += 10) {
      const chunk = hashes.slice(i, i + 10)
      const url =
        `${FOUREVERLAND_API}/pins?cid=${chunk.join(",")}` +
        `&status=queued,pinning,pinned,failed&limit=${chunk.length}`
      const data = await this.fetchJsonWithRetry(url)
      for (const r of data.results ?? []) {
        const status = mapStatus(r.status)
        const hash = r.pin?.cid ?? ""
        const inputs = byHash.get(hash) ?? []
        for (const original of inputs) result.set(original, status)
      }
    }

    return result
  }

  /**
   * GET helper that retries 429s with exponential backoff (2s, 4s) and
   * throws actionable errors for auth / quota issues. Mirrors the retry
   * policy in `pinByCid` so a transient rate-limit doesn't silently
   * poison the result.
   */
  private async fetchJsonWithRetry(url: string): Promise<any> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(url, { headers: this.headers() })
      if (res.ok) return res.json()

      if (res.status === 429 && attempt < 2) {
        const wait = (attempt + 1) * 2000
        await new Promise((r) => setTimeout(r, wait))
        continue
      }

      if (res.status === 401 || res.status === 403) {
        throw new Error(
          "4EVERLAND access token is invalid or lacks permissions. Regenerate it from the 4EVER Pin dashboard.",
        )
      }
      if (res.status === 429) {
        throw new Error(
          "4EVERLAND rate limit exceeded. Wait a minute and try again.",
        )
      }

      const text = await res.text().catch(() => "")
      throw new Error(
        `4EVERLAND request failed (${res.status}): ${text.slice(0, 200)}`,
      )
    }
    throw new Error("4EVERLAND request failed after retries")
  }

  async validateKey(): Promise<boolean> {
    try {
      const res = await fetch(`${FOUREVERLAND_API}/pins?limit=1`, {
        headers: this.headers(),
      })
      return res.ok
    } catch {
      return false
    }
  }
}

function mapStatus(status: string): PinStatus {
  switch (status) {
    case "pinned":
      return "pinned"
    case "pinning":
      return "pinning"
    case "queued":
      return "queued"
    case "failed":
      return "failed"
    default:
      return "unknown"
  }
}
