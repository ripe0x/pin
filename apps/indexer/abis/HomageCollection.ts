/**
 * HomageCollection ABI — the subset PND's indexer needs.
 *
 * The pooled-mode token side of Homage ("Homage to the Punk")'s sovereign
 * two-contract split: a clone of the generic, shared PND
 * `PooledCollection`/`CollectionCore` (deployed via `CollectionFactory`),
 * NOT a bespoke Homage-specific ERC721 contract. Ownership, transfers, and
 * `tokenURI` live here; `HomageMinter` (abis/HomageMinter.ts) drives minting
 * by calling `mintToId(...)` on this contract as an authorized extension
 * minter.
 *
 * As of this pass, the generic PND Surface/Collection system has NO existing
 * Ponder subscription of its own (no CollectionFactory `factory()` pattern is
 * wired into ponder.config.ts yet — confirmed via repo-wide grep). So this
 * collection's Transfer events are NOT already covered by anything else in
 * this indexer; Homage keeps its historical "fixed shared singleton, indexed
 * directly" treatment (like MURI) rather than going through a not-yet-built
 * generic Surface indexer. FLAG: if/when a generic Surface `factory()`
 * subscription is added to ponder.config.ts, this dedicated HomageCollection
 * subscription would become redundant with it and should be revisited.
 *
 * Registered in ponder.config.ts as the `HomageCollection` contract, deploy-
 * gated alongside `HomageMinter` (see ponder.config.ts's homageContracts
 * block) — both addresses + start blocks must be set together.
 *
 * HAND-SYNCED SNAPSHOT — mirrors /Users/dd/CascadeProjects/homage to the punk
 * (branch sovereign-rebuild) web/lib/homage.ts's `homageCollectionAbi`
 * (a minimal hand-rolled ABI: ownerOf/balanceOf/tokenURI/Transfer — not the
 * full `ICollectionCore` event surface). Re-derive from the audited build
 * before mainnet deploy + Ponder redeploy.
 */
export const homageCollectionAbi = [
  // ── Events ──────────────────────────────────────────────────────────
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true, internalType: "address" },
      { name: "to", type: "address", indexed: true, internalType: "address" },
      { name: "tokenId", type: "uint256", indexed: true, internalType: "uint256" },
    ],
    anonymous: false,
  },

  // ── Views (parity / debug — handlers do NOT read these per-event) ────
  {
    type: "function",
    name: "ownerOf",
    inputs: [{ name: "id", type: "uint256", internalType: "uint256" }],
    outputs: [{ name: "", type: "address", internalType: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "owner", type: "address", internalType: "address" }],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "tokenURI",
    inputs: [{ name: "id", type: "uint256", internalType: "uint256" }],
    outputs: [{ name: "", type: "string", internalType: "string" }],
    stateMutability: "view",
  },
] as const
