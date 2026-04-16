import type { PinningProvider, PinResult, PinStatus } from "./types"

const FILEBASE_API = "https://api.filebase.io/v1/ipfs"

/** Strip any path suffix from a CID (e.g. "QmXXX/metadata.json" → "QmXXX") */
function baseCid(cid: string): string {
  const slash = cid.indexOf("/")
  return slash === -1 ? cid : cid.slice(0, slash)
}

/**
 * Filebase IPFS pinning provider.
 *
 * Uses the IPFS Pinning Service API spec. S3-compatible with 5GB free tier.
 * Auth uses a Bearer token (Filebase access token).
 */
export class FilebaseProvider implements PinningProvider {
  readonly name = "Filebase"
  readonly type = "filebase" as const
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
    const res = await fetch(`${FILEBASE_API}/pins`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        cid: hash,
        name: name ?? `CommonGround: ${hash.slice(0, 12)}`,
      }),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => "")
      if (res.status === 409) {
        return { cid, status: "pinned" }
      }
      throw new Error(`Filebase pin failed (${res.status}): ${text}`)
    }

    const data = await res.json()
    return {
      cid,
      status: mapStatus(data.status),
    }
  }

  async checkPin(cid: string): Promise<PinStatus> {
    const hash = baseCid(cid)
    const res = await fetch(`${FILEBASE_API}/pins?cid=${hash}&limit=1`, {
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
      const res = await fetch(`${FILEBASE_API}/pins?limit=1`, {
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
