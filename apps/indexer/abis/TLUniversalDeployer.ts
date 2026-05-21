/**
 * Transient Labs Universal Deployer ABI — events only.
 *
 * Source: https://github.com/Transient-Labs/tl-creator-contracts
 * Confirmed against verified mainnet source at
 * 0x7c24805454F7972d36BEE9D139BD93423AA29f3f.
 *
 * Emits `ContractDeployed` for every ERC721TL / ERC1155TL clone the
 * Universal Deployer creates. The web app's existing scanner filtered
 * to `cType.startsWith("ERC721")` to skip ERC-1155 contracts — we
 * preserve that scope at the handler level (see `ponder/src/TL.ts`)
 * so this migration is behavior-preserving against the prior
 * lazy-table reads. ERC-1155 support can be added later by extending
 * the handler to also subscribe to TransferSingle/Batch on the clones.
 *
 * `sender` is the deployer (the artist for self-deploys, or an
 * operator for managed deploys). `cType` carries the contract family
 * tag (e.g. "ERC721TL"), `version` carries the contract version
 * string (e.g. "3.1.0").
 */
export const tlUniversalDeployerAbi = [
  {
    type: "event",
    name: "ContractDeployed",
    inputs: [
      {
        name: "sender",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "deployedContract",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "implementation",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      { name: "cType", type: "string", indexed: false, internalType: "string" },
      {
        name: "version",
        type: "string",
        indexed: false,
        internalType: "string",
      },
    ],
    anonymous: false,
  },
] as const
