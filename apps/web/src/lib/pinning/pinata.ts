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

    // Retry up to 3 times with backoff for rate limits
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(`${PINATA_API}/pinning/pinByHash`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          hashToPin: hash,
          pinataMetadata: { name: name ?? `pin: ${hash.slice(0, 12)}` },
        }),
      })

      if (res.ok) {
        return { cid, status: "queued" }
      }

      const text = await res.text().catch(() => "")

      // Pinata returns 400 if already pinned — treat as success
      if (res.status === 400 && text.includes("DUPLICATE_OBJECT")) {
        return { cid, status: "pinned" }
      }

      // Rate limited — wait and retry
      if (res.status === 429 && attempt < 2) {
        const wait = (attempt + 1) * 2000 // 2s, 4s
        await new Promise((r) => setTimeout(r, wait))
        continue
      }

      // Provide clear error messages for common issues
      if (res.status === 401 || res.status === 403) {
        throw new Error("Pinata API key is invalid or missing 'pinByHash' permission. Regenerate your key with pinByHash enabled under Legacy Endpoints.")
      }
      if (res.status === 429) {
        throw new Error("Pinata rate limit exceeded. Wait a minute and try again, or upgrade to a paid plan.")
      }
      if (res.status === 402) {
        throw new Error("Pinata pin limit reached. Free tier allows 500 pins — upgrade your plan or unpin unused CIDs.")
      }

      throw new Error(`Pinata pin failed (${res.status}): ${text.slice(0, 200)}`)
    }

    // Should not reach here, but satisfy TypeScript
    throw new Error("Pinata pin failed after retries")
  }

  /**
   * Upload new file bytes to IPFS via pinFileToIPFS (multipart). Works on
   * Pinata's free tier (unlike pinByHash, which needs a paid plan). Returns
   * the CID Pinata assigns. Do NOT set Content-Type — fetch derives the
   * multipart boundary from the FormData body.
   */
  async uploadFile(file: Blob, name?: string): Promise<{ cid: string }> {
    const form = new FormData()
    form.append("file", file, name ?? "artwork")
    form.append(
      "pinataMetadata",
      JSON.stringify({ name: name ?? "MURI artwork" }),
    )

    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(`${PINATA_API}/pinning/pinFileToIPFS`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.jwt}` },
        body: form,
      })

      if (res.ok) {
        const data = (await res.json()) as { IpfsHash?: string }
        if (!data.IpfsHash) {
          throw new Error("Pinata upload succeeded but returned no CID")
        }
        return { cid: data.IpfsHash }
      }

      if (res.status === 429 && attempt < 2) {
        await new Promise((r) => setTimeout(r, (attempt + 1) * 2000))
        continue
      }

      const text = await res.text().catch(() => "")
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          "Pinata API key is invalid or missing 'pinFileToIPFS' permission. Regenerate your key with file pinning enabled.",
        )
      }
      if (res.status === 402) {
        throw new Error(
          "Pinata storage limit reached. Free up space or upgrade your plan.",
        )
      }
      throw new Error(`Pinata upload failed (${res.status}): ${text.slice(0, 200)}`)
    }
    throw new Error("Pinata upload failed after retries")
  }

  async checkPin(cid: string): Promise<PinStatus> {
    const hash = baseCid(cid)
    try {
      const data = await this.fetchJsonWithRetry(
        `${PINATA_API}/data/pinList?status=pinned&hashContains=${hash}&pageLimit=1`,
      )
      if (data.rows?.length > 0) return "pinned"

      const queueData = await this.fetchJsonWithRetry(
        `${PINATA_API}/data/pinList?status=searching&hashContains=${hash}&pageLimit=1`,
      )
      if (queueData.rows?.length > 0) return "queued"

      return "unknown"
    } catch {
      return "unknown"
    }
  }

  /**
   * Bulk pin-status lookup. Pinata's `pinList` doesn't accept a
   * CID-IN filter, so we walk the account's pin set in 1000-row pages
   * (once for `pinned`, once for `searching`) and look up locally.
   * Cheaper than 2 × N hashContains queries for any artist with a few
   * hundred works.
   */
  async checkManyPins(cids: string[]): Promise<Map<string, PinStatus>> {
    const result = new Map<string, PinStatus>()
    if (cids.length === 0) return result

    const inputsByHash = new Map<string, string[]>()
    for (const cid of cids) {
      const h = baseCid(cid)
      const list = inputsByHash.get(h)
      if (list) list.push(cid)
      else inputsByHash.set(h, [cid])
    }

    for (const status of ["pinned", "searching"] as const) {
      let pageOffset = 0
      while (true) {
        const url =
          `${PINATA_API}/data/pinList?status=${status}` +
          `&pageLimit=1000&pageOffset=${pageOffset}`
        const data = await this.fetchJsonWithRetry(url)
        const rows = (data.rows ?? []) as Array<{ ipfs_pin_hash?: string }>
        for (const row of rows) {
          const hash = row.ipfs_pin_hash
          if (!hash) continue
          const inputs = inputsByHash.get(hash)
          if (!inputs) continue
          const mapped: PinStatus = status === "pinned" ? "pinned" : "queued"
          for (const original of inputs) {
            // Don't downgrade an already-found "pinned" with a later "queued" pass.
            if (result.get(original) !== "pinned") result.set(original, mapped)
          }
        }
        if (rows.length < 1000) break
        pageOffset += rows.length
      }
    }

    return result
  }

  /**
   * GET helper that retries 429s with backoff and throws actionable
   * errors for auth / quota issues. Mirrors `pinByCid`'s retry policy.
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
          "Pinata API key is invalid or missing 'pinList' permission. Regenerate your key with pinList enabled under Legacy Endpoints.",
        )
      }
      if (res.status === 429) {
        throw new Error(
          "Pinata rate limit exceeded. Wait a minute and try again, or upgrade to a paid plan.",
        )
      }

      const text = await res.text().catch(() => "")
      throw new Error(
        `Pinata request failed (${res.status}): ${text.slice(0, 200)}`,
      )
    }
    throw new Error("Pinata request failed after retries")
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
