// Hand-written minimal ABI for the deployed ScriptyStorageV2 contract at
// 0xbD11994aABB55Da86DC246EBB17C1Be0af5b7699 (mainnet, same address on most
// other EVM chains via deterministic CREATE2 deploy — see
// packages/addresses/src/index.ts SCRIPTY_STORAGE_V2).
//
// Not auto-extracted (no local Solidity source / forge artifact for this
// contract in this repo) — verified by hand against the real scripty.sol
// source at /Users/dd/Sites/scripty.sol, commit 83b850dff16ff6c82a02df601db5021a5688cc43:
//   contracts/scripty/ScriptyStorageV2.sol
//   contracts/scripty/interfaces/IScriptyStorage.sol
//   contracts/scripty/interfaces/IScriptyContractStorage.sol
//
// Covers exactly what PND's upload flow needs:
//   - createContent(name, details)          — register a new named content slot
//   - addChunkToContent(name, chunk)         — append a sequential code chunk
//   - getContent(name, data)                 — read back the fully merged content
//   - contents(name)                         — existence/read helper: the public
//     `mapping(string => Content) public contents` auto-getter. Returns the
//     Content struct fields (isFrozen, owner, size, details omitted from the
//     auto-getter return per Solidity's dynamic-type-skipping rule for public
//     mapping getters over structs with a `bytes`/`address[]` member — only
//     the scalar fields are returned: isFrozen, owner, size). Use owner !=
//     0x0 as the existence check instead of a dedicated `exists` fn (the
//     contract doesn't expose one).
//
// Intentionally NOT included (not needed by PND): updateDetails,
// freezeContent, submitToEthFSFileStore, submitToEthFSFileStoreWithFileName,
// getContentChunkPointers, the ContentFrozen/ContentDetailsUpdated/
// ContentSubmittedToEthFSFileStore events, or the custom errors. Extend this
// file (re-verify against the same commit) if a future task needs them.
export const scriptyStorageAbi = [
  {
    type: "function",
    name: "createContent",
    stateMutability: "nonpayable",
    inputs: [
      { name: "name", type: "string", internalType: "string" },
      { name: "details", type: "bytes", internalType: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "addChunkToContent",
    stateMutability: "nonpayable",
    inputs: [
      { name: "name", type: "string", internalType: "string" },
      { name: "chunk", type: "bytes", internalType: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getContent",
    stateMutability: "view",
    inputs: [
      { name: "name", type: "string", internalType: "string" },
      { name: "data", type: "bytes", internalType: "bytes" },
    ],
    outputs: [{ name: "content", type: "bytes", internalType: "bytes" }],
  },
  {
    type: "function",
    name: "contents",
    stateMutability: "view",
    inputs: [{ name: "", type: "string", internalType: "string" }],
    outputs: [
      { name: "isFrozen", type: "bool", internalType: "bool" },
      { name: "owner", type: "address", internalType: "address" },
      { name: "size", type: "uint256", internalType: "uint256" },
    ],
  },
  {
    type: "event",
    name: "ContentCreated",
    inputs: [
      { name: "name", type: "string", indexed: true, internalType: "string" },
      { name: "details", type: "bytes", indexed: false, internalType: "bytes" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "ChunkStored",
    inputs: [
      { name: "name", type: "string", indexed: true, internalType: "string" },
      { name: "size", type: "uint256", indexed: false, internalType: "uint256" },
    ],
    anonymous: false,
  },
  {
    type: "error",
    name: "ContentExists",
    inputs: [],
  },
  {
    type: "error",
    name: "NotContentOwner",
    inputs: [],
  },
] as const;
