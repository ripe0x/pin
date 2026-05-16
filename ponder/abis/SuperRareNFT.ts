/**
 * SuperRare V2 shared 1/1 NFT contract ABI — events only.
 *
 * The shared 1/1 contract at 0xb932a70a57673d89f4acffbe830e8ed7f75fb9e0
 * is a standard ERC-721. We only index `Transfer(from=0x0)` to enumerate
 * mints; the `to` of a mint Transfer is the artist (SR V2's mint flow
 * always mints to the creator, who can then list on Bazaar).
 *
 * SuperRare Spaces (per-artist contracts) are out of scope here —
 * matches the prior lazy-scan adapter's deferral. Adding them would
 * require either iterating known Space contracts or a Spaces-factory
 * source.
 */
export const superrareNftAbi = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true, internalType: "address" },
      { name: "to", type: "address", indexed: true, internalType: "address" },
      {
        name: "tokenId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
] as const
