/**
 * Mint protocol (Visualize Value) Factory ABI — events only.
 *
 * Source: https://github.com/visualizevalue/mint/blob/main/contracts/contracts/Factory.sol
 * Confirmed against verified mainnet source at
 * 0xd717Fe677072807057B03705227EC3E3b467b670.
 *
 * The Factory exposes `create(...)` (full deploy) and `clone(...)`
 * (EIP-1167 minimal proxy); both emit `Created(ownerAddress,
 * contractAddress)` on deploy. We only need that event — the per-clone
 * token activity is handled via the dynamic-factory source in
 * `ponder.config.ts` which subscribes to TransferSingle/TransferBatch
 * on each emitted `contractAddress`.
 */
export const mintFactoryAbi = [
  {
    type: "event",
    name: "Created",
    inputs: [
      {
        name: "ownerAddress",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "contractAddress",
        type: "address",
        indexed: false,
        internalType: "address",
      },
    ],
    anonymous: false,
  },
] as const
