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
    const res = await fetch(`${FOUREVERLAND_API}/pins?cid=${hash}&limit=1`, {
      headers: this.headers(),
    })

    if (!res.ok) return "unknown"

    const data = await res.json()
    if (data.results?.length > 0) {
      return mapStatus(data.results[0].status)
    }
    return "unknown"
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
