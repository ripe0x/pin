import { describe, expect, it } from "vitest"
import { assertSafeRemoteUrl, isPublicNetworkAddress } from "./safe-fetch"

describe("NFT metadata URL safety", () => {
  it("rejects loopback, private, link-local, and metadata-network addresses", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "::1",
      "fd00::1",
    ]) {
      expect(isPublicNetworkAddress(address)).toBe(false)
    }
    expect(isPublicNetworkAddress("8.8.8.8")).toBe(true)
    expect(isPublicNetworkAddress("2606:4700:4700::1111")).toBe(true)
  })

  it("requires HTTPS and rejects private literal hosts", async () => {
    await expect(assertSafeRemoteUrl("http://example.com/meta.json")).rejects.toThrow(
      "HTTPS",
    )
    await expect(
      assertSafeRemoteUrl("https://127.0.0.1/meta.json"),
    ).rejects.toThrow("non-public")
    await expect(
      assertSafeRemoteUrl("https://localhost/meta.json"),
    ).rejects.toThrow("not allowed")
  })
})
