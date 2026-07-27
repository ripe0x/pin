// Hand-written from the spec in docs/pnd-surface-second-launch.md
// ("Architecture: batch editions live entirely in renderer-land"). No
// contract source exists yet — a separate work item is authoring
// BatchRenderRouter.sol; re-derive this from
// contracts/out/IBatchRenderRouter.sol/IBatchRenderRouter.json via
// scripts/emit-surface-abi.mjs once it lands, and drop this hand-written
// copy.
//
// Interface: IBatchRenderRouter is IRenderer, IERC165.
//   struct Batch { uint256 startId; uint256 endId; address renderer; string label; }
//   addBatch(uint256 startId, uint256 endId, address renderer, string label) — owner/admin
//   batchCount() view returns (uint256)
//   batchAt(uint256 index) view returns (Batch)
//   batchOf(uint256 tokenId) view returns (Batch)
//   requestRefresh(uint256 tokenId) — registered renderers only, relays to
//     ISurfaceCore(collection).notifyMetadataUpdate(tokenId, tokenId)
//   tokenURI(address collection, uint256 tokenId) view returns (string) — from IRenderer
//   supportsInterface(bytes4) view returns (bool) — from IERC165
export const iBatchRenderRouterAbi = [
  {
    type: "function",
    name: "addBatch",
    stateMutability: "nonpayable",
    inputs: [
      { name: "startId", type: "uint256" },
      { name: "endId", type: "uint256" },
      { name: "renderer", type: "address" },
      { name: "label", type: "string" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "batchCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "batchAt",
    stateMutability: "view",
    inputs: [{ name: "index", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "startId", type: "uint256" },
          { name: "endId", type: "uint256" },
          { name: "renderer", type: "address" },
          { name: "label", type: "string" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "batchOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "startId", type: "uint256" },
          { name: "endId", type: "uint256" },
          { name: "renderer", type: "address" },
          { name: "label", type: "string" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "requestRefresh",
    stateMutability: "nonpayable",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "tokenURI",
    stateMutability: "view",
    inputs: [
      { name: "collection", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "contractURI",
    stateMutability: "view",
    inputs: [{ name: "collection", type: "address" }],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "supportsInterface",
    stateMutability: "view",
    inputs: [{ name: "interfaceId", type: "bytes4" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const

/**
 * ERC-165 interface id for IBatchRenderRouter, matching
 * contracts/src/surface/interfaces/IBatchRenderRouter.sol (interface
 * IBatchRenderRouter is IRenderer) and BatchRenderRouter.sol's
 * supportsInterface, which checks type(IBatchRenderRouter).interfaceId.
 * Solidity's type().interfaceId XORs only the selectors declared directly
 * in the interface and EXCLUDES inherited functions, so this is the XOR of
 * addBatch, batchCount, batchAt, batchOf, and requestRefresh; the inherited
 * IRenderer selectors (tokenURI, contractURI) are not included. Verified by
 * compiling type(IBatchRenderRouter).interfaceId. Re-derive the same way if
 * the interface's own function set changes.
 */
export const BATCH_RENDER_ROUTER_INTERFACE_ID = "0xee4ae0b4" as const
