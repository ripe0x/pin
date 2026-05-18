export const nftMarketAbi = [
  //
  // ── Reserve Auctions ────────────────────────────────────────────────
  //
  {
    type: "function",
    name: "createReserveAuction",
    inputs: [
      { name: "nftContract", type: "address", internalType: "address" },
      { name: "tokenId", type: "uint256", internalType: "uint256" },
      { name: "reservePrice", type: "uint256", internalType: "uint256" },
      { name: "duration", type: "uint256", internalType: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "placeBidV2",
    inputs: [
      { name: "auctionId", type: "uint256", internalType: "uint256" },
      { name: "amount", type: "uint256", internalType: "uint256" },
      { name: "referrer", type: "address", internalType: "address payable" },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "getMinBidAmount",
    inputs: [
      { name: "auctionId", type: "uint256", internalType: "uint256" },
    ],
    outputs: [
      { name: "minimum", type: "uint256", internalType: "uint256" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getFeesAndRecipients",
    inputs: [
      { name: "nftContract", type: "address", internalType: "address" },
      { name: "tokenId", type: "uint256", internalType: "uint256" },
      { name: "price", type: "uint256", internalType: "uint256" },
    ],
    outputs: [
      { name: "totalFees", type: "uint256", internalType: "uint256" },
      { name: "creatorRev", type: "uint256", internalType: "uint256" },
      { name: "creatorRecipients", type: "address[]", internalType: "address payable[]" },
      { name: "creatorShares", type: "uint256[]", internalType: "uint256[]" },
      { name: "sellerRev", type: "uint256", internalType: "uint256" },
      { name: "seller", type: "address", internalType: "address payable" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "finalizeReserveAuction",
    inputs: [
      { name: "auctionId", type: "uint256", internalType: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "cancelReserveAuction",
    inputs: [
      { name: "auctionId", type: "uint256", internalType: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "updateReserveAuction",
    inputs: [
      { name: "auctionId", type: "uint256", internalType: "uint256" },
      { name: "reservePrice", type: "uint256", internalType: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "getReserveAuction",
    inputs: [
      { name: "auctionId", type: "uint256", internalType: "uint256" },
    ],
    outputs: [
      {
        name: "auction",
        type: "tuple",
        internalType: "struct NFTMarketReserveAuction.ReserveAuction",
        components: [
          { name: "nftContract", type: "address", internalType: "address" },
          { name: "tokenId", type: "uint256", internalType: "uint256" },
          { name: "seller", type: "address", internalType: "address payable" },
          { name: "duration", type: "uint256", internalType: "uint256" },
          { name: "extensionDuration", type: "uint256", internalType: "uint256" },
          { name: "endTime", type: "uint256", internalType: "uint256" },
          { name: "bidder", type: "address", internalType: "address payable" },
          { name: "amount", type: "uint256", internalType: "uint256" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getReserveAuctionIdFor",
    inputs: [
      { name: "nftContract", type: "address", internalType: "address" },
      { name: "tokenId", type: "uint256", internalType: "uint256" },
    ],
    outputs: [
      { name: "auctionId", type: "uint256", internalType: "uint256" },
    ],
    stateMutability: "view",
  },

  //
  // ── Buy Now ─────────────────────────────────────────────────────────
  //
  {
    type: "function",
    name: "setBuyPrice",
    inputs: [
      { name: "nftContract", type: "address", internalType: "address" },
      { name: "tokenId", type: "uint256", internalType: "uint256" },
      { name: "price", type: "uint256", internalType: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "cancelBuyPrice",
    inputs: [
      { name: "nftContract", type: "address", internalType: "address" },
      { name: "tokenId", type: "uint256", internalType: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "buyV2",
    inputs: [
      { name: "nftContract", type: "address", internalType: "address" },
      { name: "tokenId", type: "uint256", internalType: "uint256" },
      { name: "maxPrice", type: "uint256", internalType: "uint256" },
      { name: "referrer", type: "address", internalType: "address payable" },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "getBuyPrice",
    inputs: [
      { name: "nftContract", type: "address", internalType: "address" },
      { name: "tokenId", type: "uint256", internalType: "uint256" },
    ],
    outputs: [
      {
        name: "buyPrice",
        type: "tuple",
        internalType: "struct NFTMarketBuyPrice.BuyPrice",
        components: [
          { name: "seller", type: "address", internalType: "address payable" },
          { name: "price", type: "uint256", internalType: "uint256" },
        ],
      },
    ],
    stateMutability: "view",
  },

  //
  // ── Offers ──────────────────────────────────────────────────────────
  //
  {
    type: "function",
    name: "makeOfferV2",
    inputs: [
      { name: "nftContract", type: "address", internalType: "address" },
      { name: "tokenId", type: "uint256", internalType: "uint256" },
      { name: "amount", type: "uint256", internalType: "uint256" },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "acceptOffer",
    inputs: [
      { name: "nftContract", type: "address", internalType: "address" },
      { name: "tokenId", type: "uint256", internalType: "uint256" },
      { name: "offerFrom", type: "address", internalType: "address" },
      { name: "minAmount", type: "uint256", internalType: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "cancelOffer",
    inputs: [
      { name: "nftContract", type: "address", internalType: "address" },
      { name: "tokenId", type: "uint256", internalType: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "getOffer",
    inputs: [
      { name: "nftContract", type: "address", internalType: "address" },
      { name: "tokenId", type: "uint256", internalType: "uint256" },
    ],
    outputs: [
      {
        name: "offer",
        type: "tuple",
        internalType: "struct NFTMarketOffer.Offer",
        components: [
          { name: "buyer", type: "address", internalType: "address payable" },
          { name: "amount", type: "uint256", internalType: "uint256" },
          { name: "expiration", type: "uint256", internalType: "uint256" },
        ],
      },
    ],
    stateMutability: "view",
  },

  //
  // ── Reserve Auction Events ──────────────────────────────────────────
  //
  {
    type: "event",
    name: "ReserveAuctionCreated",
    inputs: [
      { name: "seller", type: "address", indexed: true, internalType: "address" },
      { name: "nftContract", type: "address", indexed: true, internalType: "address" },
      { name: "tokenId", type: "uint256", indexed: true, internalType: "uint256" },
      { name: "duration", type: "uint256", indexed: false, internalType: "uint256" },
      { name: "extensionDuration", type: "uint256", indexed: false, internalType: "uint256" },
      { name: "reservePrice", type: "uint256", indexed: false, internalType: "uint256" },
      { name: "auctionId", type: "uint256", indexed: false, internalType: "uint256" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "ReserveAuctionBidPlaced",
    inputs: [
      { name: "auctionId", type: "uint256", indexed: true, internalType: "uint256" },
      { name: "bidder", type: "address", indexed: true, internalType: "address" },
      { name: "amount", type: "uint256", indexed: false, internalType: "uint256" },
      { name: "endTime", type: "uint256", indexed: false, internalType: "uint256" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "ReserveAuctionFinalized",
    inputs: [
      { name: "auctionId", type: "uint256", indexed: true, internalType: "uint256" },
      { name: "seller", type: "address", indexed: true, internalType: "address" },
      { name: "bidder", type: "address", indexed: true, internalType: "address" },
      { name: "totalFees", type: "uint256", indexed: false, internalType: "uint256" },
      { name: "creatorRev", type: "uint256", indexed: false, internalType: "uint256" },
      { name: "sellerRev", type: "uint256", indexed: false, internalType: "uint256" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "ReserveAuctionCanceled",
    inputs: [
      { name: "auctionId", type: "uint256", indexed: true, internalType: "uint256" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "ReserveAuctionUpdated",
    inputs: [
      { name: "auctionId", type: "uint256", indexed: true, internalType: "uint256" },
      { name: "reservePrice", type: "uint256", indexed: false, internalType: "uint256" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "ReserveAuctionInvalidated",
    inputs: [
      { name: "auctionId", type: "uint256", indexed: true, internalType: "uint256" },
    ],
    anonymous: false,
  },

  //
  // ── Buy Now Events ──────────────────────────────────────────────────
  //
  {
    type: "event",
    name: "BuyPriceSet",
    inputs: [
      { name: "nftContract", type: "address", indexed: true, internalType: "address" },
      { name: "tokenId", type: "uint256", indexed: true, internalType: "uint256" },
      { name: "seller", type: "address", indexed: true, internalType: "address" },
      { name: "price", type: "uint256", indexed: false, internalType: "uint256" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "BuyPriceCanceled",
    inputs: [
      { name: "nftContract", type: "address", indexed: true, internalType: "address" },
      { name: "tokenId", type: "uint256", indexed: true, internalType: "uint256" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "BuyPriceAccepted",
    inputs: [
      { name: "nftContract", type: "address", indexed: true, internalType: "address" },
      { name: "tokenId", type: "uint256", indexed: true, internalType: "uint256" },
      { name: "seller", type: "address", indexed: true, internalType: "address" },
      { name: "buyer", type: "address", indexed: false, internalType: "address" },
      { name: "totalFees", type: "uint256", indexed: false, internalType: "uint256" },
      { name: "creatorRev", type: "uint256", indexed: false, internalType: "uint256" },
      { name: "sellerRev", type: "uint256", indexed: false, internalType: "uint256" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "BuyPriceInvalidated",
    inputs: [
      { name: "nftContract", type: "address", indexed: true, internalType: "address" },
      { name: "tokenId", type: "uint256", indexed: true, internalType: "uint256" },
    ],
    anonymous: false,
  },

  //
  // ── Offer Events ────────────────────────────────────────────────────
  //
  {
    type: "event",
    name: "OfferMade",
    inputs: [
      { name: "nftContract", type: "address", indexed: true, internalType: "address" },
      { name: "tokenId", type: "uint256", indexed: true, internalType: "uint256" },
      { name: "buyer", type: "address", indexed: true, internalType: "address" },
      { name: "amount", type: "uint256", indexed: false, internalType: "uint256" },
      { name: "expiration", type: "uint256", indexed: false, internalType: "uint256" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "OfferAccepted",
    inputs: [
      { name: "nftContract", type: "address", indexed: true, internalType: "address" },
      { name: "tokenId", type: "uint256", indexed: true, internalType: "uint256" },
      { name: "buyer", type: "address", indexed: true, internalType: "address" },
      { name: "seller", type: "address", indexed: false, internalType: "address" },
      { name: "totalFees", type: "uint256", indexed: false, internalType: "uint256" },
      { name: "creatorRev", type: "uint256", indexed: false, internalType: "uint256" },
      { name: "sellerRev", type: "uint256", indexed: false, internalType: "uint256" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "OfferCanceled",
    inputs: [
      { name: "nftContract", type: "address", indexed: true, internalType: "address" },
      { name: "tokenId", type: "uint256", indexed: true, internalType: "uint256" },
      { name: "buyer", type: "address", indexed: true, internalType: "address" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "OfferInvalidated",
    inputs: [
      { name: "nftContract", type: "address", indexed: true, internalType: "address" },
      { name: "tokenId", type: "uint256", indexed: true, internalType: "uint256" },
    ],
    anonymous: false,
  },
] as const;
