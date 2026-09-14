import { describe, expect, it } from "vitest"
import {
  IPFS_GATEWAYS,
  extractArweavePath,
  extractIpfsPath,
  gatewayCandidates,
  resolveMediaUrl,
} from "./media-fallback"

describe("media gateway normalization", () => {
  it("rewrites IPFS and legacy gateway URLs to the browser-safe primary", () => {
    expect(resolveMediaUrl("ipfs://QmExample/art.png")).toBe(
      `${IPFS_GATEWAYS[0]}QmExample/art.png`,
    )
    expect(resolveMediaUrl("https://dweb.link/ipfs/QmExample/art.png")).toBe(
      `${IPFS_GATEWAYS[0]}QmExample/art.png`,
    )
  })

  it("preserves IPFS paths and produces every fallback candidate", () => {
    const uri = "ipfs://ipfs/QmExample/art.png?size=large"
    expect(extractIpfsPath(uri)).toBe("QmExample/art.png?size=large")
    expect(gatewayCandidates(uri)).toEqual(
      IPFS_GATEWAYS.map((gateway) => `${gateway}QmExample/art.png?size=large`),
    )
  })

  it("recognizes valid Arweave paths without rewriting unrelated URLs", () => {
    const id = "a".repeat(43)
    expect(extractArweavePath(`ar://${id}/index.html`)).toBe(`${id}/index.html`)
    expect(resolveMediaUrl("https://example.com/art.png")).toBe(
      "https://example.com/art.png",
    )
  })
})
