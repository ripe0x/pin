import type { PinningProvider, PinResult, PinStatus } from "./types"

const W3S_API = "https://api.web3.storage"

/** Strip any path suffix from a CID (e.g. "QmXXX/metadata.json" → "QmXXX") */
function baseCid(cid: string): string {
  const slash = cid.indexOf("/")
  return slash === -1 ? cid : cid.slice(0, slash)
}

/**
 * web3.storage IPFS pinning provider.
 *
 * Uses the web3.storage Pinning Service API to pin existing CIDs.
 * Free, backed by Filecoin for long-term decentralized storage.
 */
export class Web3StorageProvider implements PinningProvider {
  readonly name = "web3.storage"
  readonly type = "web3storage" as const
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
    const res = await fetch(`${W3S_API}/pins`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        cid: hash,
        name: name ?? `pin: ${hash.slice(0, 12)}`,
      }),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => "")
      // Already pinned
      if (res.status === 409) {
        return { cid, status: "pinned" }
      }
      throw new Error(`web3.storage pin failed (${res.status}): ${text}`)
    }

    const data = await res.json()
    return {
      cid,
      status: mapStatus(data.status),
    }
  }

  async checkPin(cid: string): Promise<PinStatus> {
    const hash = baseCid(cid)
    const res = await fetch(`${W3S_API}/pins?cid=${hash}&limit=1`, {
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
      // List pins with limit=1 to test auth
      const res = await fetch(`${W3S_API}/pins?limit=1`, {
        headers: this.headers(),
      })
      return res.ok
    } catch {
      return false
    }
  }
}

/** Map IPFS Pinning Service API status to our PinStatus. */
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
