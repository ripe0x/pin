// Minimal Manifold Creator Core ABI fragments (ERC721 + ERC1155), const-asserted
// for wagmi/viem type inference. Only the functions PND's MURI mint flow needs:
//   - supportsInterface: classify the contract
//   - isAdmin / owner: confirm the connected wallet controls the contract
//   - getExtensions: detect whether the MURI extension is already registered
//   - registerExtension: one-time setup write (authorize the MURI extension)
// `isAdmin` comes from Manifold's AdminControl; the MURI extension's mint
// entrypoints are `contractAdminRequired`, so this is the authoritative gate.

const creatorCoreShared = [
  {
    type: "function",
    name: "supportsInterface",
    inputs: [{ name: "interfaceId", type: "bytes4", internalType: "bytes4" }],
    outputs: [{ name: "", type: "bool", internalType: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "isAdmin",
    inputs: [{ name: "admin", type: "address", internalType: "address" }],
    outputs: [{ name: "", type: "bool", internalType: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "owner",
    inputs: [],
    outputs: [{ name: "", type: "address", internalType: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getExtensions",
    inputs: [],
    outputs: [{ name: "", type: "address[]", internalType: "address[]" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "registerExtension",
    inputs: [
      { name: "extension", type: "address", internalType: "address" },
      { name: "baseURI", type: "string", internalType: "string" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const

export const ierc721CreatorCoreAbi = creatorCoreShared
export const ierc1155CreatorCoreAbi = creatorCoreShared
