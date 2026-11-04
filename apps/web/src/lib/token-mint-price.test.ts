/** Sold row -> per-token primary mint price (issue #268 phase 2a), and the
 *  OpenSea deep links (phase 1). */
import { test } from "node:test"
import assert from "node:assert/strict"
import { parseEther } from "viem"
import { formatMintPrice, mintPriceForToken, saleCoversToken, type IndexedSale } from "./token-mint-price.ts"
import { openSeaAddressUrl, openSeaCollectionUrl, openSeaTokenUrl } from "./collection.ts"

const sale = (firstTokenId: bigint, quantity: bigint, paid: bigint, blockNumber = 100n): IndexedSale => ({
  firstTokenId,
  quantity,
  paid,
  blockNumber,
  txHash: `0x${blockNumber.toString(16)}`,
})

test("saleCoversToken: [firstTokenId, firstTokenId + quantity)", () => {
  const s = sale(5n, 3n, 0n)
  assert.equal(saleCoversToken(s, 4n), false)
  assert.equal(saleCoversToken(s, 5n), true)
  assert.equal(saleCoversToken(s, 7n), true)
  assert.equal(saleCoversToken(s, 8n), false)
  assert.equal(saleCoversToken(sale(5n, 0n, 0n), 5n), false)
})

test("mintPriceForToken: single mint is the full payment", () => {
  const p = mintPriceForToken([sale(1n, 1n, parseEther("0.1"))], 1n)
  assert.ok(p)
  assert.equal(p.perToken, parseEther("0.1"))
  assert.equal(p.quantity, 1n)
  assert.equal(formatMintPrice(p), "0.1 ETH")
})

test("mintPriceForToken: a batch splits paid / quantity for every id in the span", () => {
  const sales = [sale(1n, 1n, parseEther("0.05"), 10n), sale(2n, 4n, parseEther("0.2"), 11n)]
  for (const id of [2n, 3n, 4n, 5n]) {
    const p = mintPriceForToken(sales, id)
    assert.ok(p)
    assert.equal(p.perToken, parseEther("0.05"))
    assert.equal(p.quantity, 4n)
    assert.equal(p.paid, parseEther("0.2"))
    assert.equal(p.txHash, "0xb")
  }
  assert.equal(mintPriceForToken(sales, 6n), null)
})

test("mintPriceForToken: uneven totals floor to wei", () => {
  const p = mintPriceForToken([sale(1n, 3n, 10n)], 2n)
  assert.ok(p)
  assert.equal(p.perToken, 3n)
})

test("mintPriceForToken: no covering sale is null, never a guess", () => {
  assert.equal(mintPriceForToken([], 1n), null)
  assert.equal(mintPriceForToken([sale(10n, 2n, 1n)], 9n), null)
})

test("mintPriceForToken: latest covering sale wins", () => {
  const p = mintPriceForToken([sale(1n, 1n, parseEther("1"), 50n), sale(1n, 1n, parseEther("2"), 60n)], 1n)
  assert.ok(p)
  assert.equal(p.perToken, parseEther("2"))
})

test("formatMintPrice: zero reads Free", () => {
  assert.equal(formatMintPrice({ perToken: 0n }), "Free")
  assert.equal(formatMintPrice({ perToken: parseEther("1") }), "1 ETH")
  assert.equal(formatMintPrice({ perToken: parseEther("0.0069") }), "0.0069 ETH")
})

test("OpenSea links: token, collection by address, curated slug", () => {
  const a = "0xb741055bd0467a5831b8b5f7df376cda93a76af1"
  assert.equal(openSeaTokenUrl(a, 7n, 1), `https://opensea.io/assets/ethereum/${a}/7`)
  assert.equal(openSeaTokenUrl(a, "7", 11155111), `https://testnets.opensea.io/assets/sepolia/${a}/7`)
  assert.equal(openSeaCollectionUrl(a, 1), openSeaAddressUrl(a, 1))
  assert.equal(openSeaCollectionUrl(a, 1, "homage-to-the-punk"), "https://opensea.io/collection/homage-to-the-punk")
  assert.equal(openSeaCollectionUrl(a, 11155111, "homage-to-the-punk"), openSeaAddressUrl(a, 11155111))
})
