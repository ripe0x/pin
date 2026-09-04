import { describe, expect, it, vi } from "vitest"
import { resolveTokenPreview } from "./token-preview"

describe("resolveTokenPreview", () => {
  it("decodes inline image metadata", async () => {
    const uri = `data:application/json,${encodeURIComponent(JSON.stringify({ image: "data:image/svg+xml;base64,AA==" }))}`
    await expect(resolveTokenPreview(uri)).resolves.toEqual({
      image: "data:image/svg+xml;base64,AA==",
      animationUrl: null,
      kind: "image",
    })
  })

  it("classifies extensionless animation metadata as HTML", async () => {
    const uri = `data:application/json,${encodeURIComponent(JSON.stringify({ animation_url: "https://example.test/art" }))}`
    await expect(resolveTokenPreview(uri)).resolves.toMatchObject({ kind: "html" })
  })

  it("returns reduced failure when metadata cannot be loaded", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")))
    await expect(resolveTokenPreview("https://example.test/meta.json")).resolves.toBeNull()
    vi.unstubAllGlobals()
  })
})

