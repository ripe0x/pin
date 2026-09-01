import { describe, expect, it } from "vitest"
import { remoteImageResponseIsUsable } from "./artist-image"

describe("artist avatar response validation", () => {
  it("rejects image-shaped error responses such as removed-host placeholders", () => {
    expect(remoteImageResponseIsUsable(404, "image/png")).toBe(false)
  })

  it("accepts successful images and rejects successful non-images", () => {
    expect(remoteImageResponseIsUsable(200, "image/jpeg")).toBe(true)
    expect(remoteImageResponseIsUsable(200, "text/html")).toBe(false)
  })
})
