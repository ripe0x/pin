import type { PinningProvider, PinResult, PinStatus } from "./types"

const PINATA_API = "https://api.pinata.cloud"

/** Strip any path suffix from a CID (e.g. "QmXXX/metadata.json" → "QmXXX") */
function baseCid(cid: string): string {
  const slash = cid.indexOf("/")
  return slash === -1 ? cid : cid.slice(0, slash)
}

/**
 * Pinata IPFS pinning provider.
 *
 * Uses Pinata's REST API with a JWT token provided by the artist.
 * Pins existing CIDs (no re-upload needed — the data is already on IPFS).
 */
export class PinataProvider implements PinningProvider {
  readonly name = "Pinata"
  readonly type = "pinata" as const
  private jwt: string

  constructor(jwt: string) {
    this.jwt = jwt
  }

  private headers(): HeadersInit {
    return {
      Authorization: `Bearer ${this.jwt}`,
      "Content-Type": "application/json",
    }
  }

  async pinByCid(cid: string, name?: string): Promise<PinResult> {
    const hash = baseCid(cid)
    const res = await fetch(`${PINATA_API}/pinning/pinByHash`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        hashToPin: hash,
        pinataMetadata: { name: name ?? `CommonGround: ${hash.slice(0, 12)}` },
      }),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => "")
      // Pinata returns 400 if already pinned — treat as success
      if (res.status === 400 && text.includes("DUPLICATE_OBJECT")) {
        return { cid, status: "pinned" }
      }
      throw new Error(`Pinata pin failed (${res.status}): ${text}`)
    }

    return { cid, status: "queued" }
  }

  async checkPin(cid: string): Promise<PinStatus> {
    const hash = baseCid(cid)
    const res = await fetch(
      `${PINATA_API}/data/pinList?status=pinned&hashContains=${hash}&pageLimit=1`,
      { headers: this.headers() },
    )

    if (!res.ok) return "unknown"

    const data = await res.json()
    if (data.rows?.length > 0) return "pinned"

    // Check if queued
    const queueRes = await fetch(
      `${PINATA_API}/data/pinList?status=searching&hashContains=${hash}&pageLimit=1`,
      { headers: this.headers() },
    )
    if (queueRes.ok) {
      const queueData = await queueRes.json()
      if (queueData.rows?.length > 0) return "queued"
    }

    return "unknown"
  }

  async validateKey(): Promise<boolean> {
    try {
      const res = await fetch(`${PINATA_API}/data/testAuthentication`, {
        headers: this.headers(),
      })
      return res.ok
    } catch {
      return false
    }
  }
}
