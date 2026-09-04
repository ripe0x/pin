/**
 * Shared parsing for the V2 auction "listing expiry" field, used by
 * AuctionTermsForm (single) and SovereignBulkPanel (bulk). A blank field
 * means no expiry, `create1155Auction` / `createAuction` /
 * `bulkCreateAuctions` all take `listingExpiry_` as a uint64 seconds value
 * where 0 means none.
 */
export type ListingExpiryResult = {
  /** null when the field was left blank (no expiry). */
  seconds: bigint | null
  error: string | null
}

/**
 * Converts a `<input type="datetime-local">` value (interpreted in the
 * browser's local time, same as the input renders it) to a uint64 seconds
 * listing expiry. Rejects a non-future timestamp, the contract has no use
 * for an already-expired listing.
 */
export function parseListingExpiry(value: string, nowSec: number): ListingExpiryResult {
  const trimmed = value.trim()
  if (trimmed === "") return { seconds: null, error: null }
  const ms = Date.parse(trimmed)
  if (Number.isNaN(ms)) return { seconds: null, error: "Invalid date" }
  const sec = Math.floor(ms / 1000)
  if (sec <= nowSec) return { seconds: null, error: "Listing expiry must be in the future" }
  return { seconds: BigInt(sec), error: null }
}
