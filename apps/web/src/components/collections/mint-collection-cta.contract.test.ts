import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import test from "node:test"

test("PND fixed-price CTA stays on the shared provider and React boundary", async () => {
  const source = await readFile(resolve(import.meta.dirname, "MintCollectionCTA.tsx"), "utf8")
  expect(source, /@pin\/surface-react/)
  expect(source, /createDirectChainSurfaceProvider/)
  expect(source, /releaseAvailability/)
  expect(source, /(?:useMintQuote|provider\.quoteMint)/)
  expect(source, /provider\.prepareMint/)
  expect(source, /useReadContract/ , false)
  expect(source, /prepareFixedPriceMint/, false)
})

function expect(source: string, pattern: RegExp, shouldMatch = true): void {
  const matched = pattern.test(source)
  if (matched !== shouldMatch) throw new Error(`${shouldMatch ? "missing" : "forbidden"} ${pattern}`)
}
