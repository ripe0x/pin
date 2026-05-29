// Mint protocol (Visualize Value, mint.vv.xyz) edition clone.
// Source: github.com/visualizevalue/mint — contracts/contracts/Mint.sol.
// Deployed via MintFactory 0xd717Fe677072807057B03705227EC3E3b467b670.
//
// We only call `mint`. The 24h window is derived off-chain (mint_time + 24h),
// supply + metadata come from the worker / existing token reads, and price is
// computed from the current base fee (unitPrice = block.basefee * 60_000), so
// no read functions are needed here.
export const mintEditionAbi = [
  {
    type: "function",
    name: "mint",
    inputs: [
      { name: "tokenId", type: "uint256", internalType: "uint256" },
      { name: "amount", type: "uint256", internalType: "uint256" },
    ],
    outputs: [],
    stateMutability: "payable",
  },
] as const;
