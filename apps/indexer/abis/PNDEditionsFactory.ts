// PNDEditionsFactory discovery ABI (event only). The factory emits one
// ProjectCreated per project deploy; `owner` is the artist, indexed for cheap
// topic-filtered enumeration. Mirrors the MintFactory.Created discovery shape.
//
// NOTE: not yet wired into ponder.config.ts — Ponder needs the deployed
// factory address + start block to register it. See
// docs/pnd-editions-integration.md for the post-deploy wiring.
export const pndEditionsFactoryAbi = [
  {
    type: "event",
    name: "ProjectCreated",
    inputs: [
      { name: "owner", type: "address", indexed: true, internalType: "address" },
      { name: "project", type: "address", indexed: true, internalType: "address" },
      { name: "mode", type: "uint8", indexed: false, internalType: "enum ProjectMode" },
    ],
    anonymous: false,
  },
] as const
