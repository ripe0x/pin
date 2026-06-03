// Minimal 0xSplits SplitMain ABI: just createSplit + its CreateSplit event.
// Used to deploy an immutable payment split (controller = address(0)) and read
// back the deployed split address from the receipt. https://docs.splits.org
export const splitMainAbi = [
  {
    type: "function",
    name: "createSplit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "accounts", type: "address[]" },
      { name: "percentAllocations", type: "uint32[]" },
      { name: "distributorFee", type: "uint32" },
      { name: "controller", type: "address" },
    ],
    outputs: [{ name: "split", type: "address" }],
  },
  {
    type: "event",
    name: "CreateSplit",
    anonymous: false,
    inputs: [{ name: "split", type: "address", indexed: true }],
  },
] as const;
