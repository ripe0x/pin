/**
 * Homage ("Homage to the Punk") — redeemable, $111-backed Albers homages,
 * one per CryptoPunk (`tokenId == punkId`, supply 10,000).
 *
 * Homage is a SOVEREIGN TWO-CONTRACT protocol (rebuilt from the earlier
 * single-monolith `Homage.sol`): the token lives in a pooled PND Collection
 * (a plain ERC-721 core), and minting/economics/redeem run through a
 * separate `HomageMinter` engine that mints INTO that collection.
 *
 *   - `homageMinterAbi`     — HomageMinter: every write (single + batch mint
 *     across all phases: `mint` / `mintBatch` / `mintTo` / `mintBatchTo`,
 *     `allowlistMint` / `allowlistMintBatch` / `allowlistMintFor` /
 *     `allowlistMintBatchFor`, `claim*`, `redeem`, `reserve*`, admin
 *     setters), every view, every event, and every custom `error`, so viem
 *     decodes a revert selector to a named reason (`NotPunkOwner()`) instead
 *     of a bare `0x...` on a failed mint.
 *   - `homageCollectionAbi` — the pooled PND Collection (the ERC-721 core
 *     itself): `ownerOf` / `balanceOf` / `tokenURI` / `Transfer` ONLY.
 *     Ownership, transfers, and metadata live here; economics/schedule/
 *     supply/redeem do NOT — read those from the minter.
 *
 * The indexer keeps its own events-focused subset in
 * `apps/indexer/abis/Homage.ts`; this one carries the full write surface for
 * the web `/mint/homage` venue.
 *
 * `homageMinterAbi` is the EXACT verified ABI of the deployed mainnet
 * HomageMinter at `0xe516668f7CE220d7418eB0e9D24AF89B23Be59F8` (fetched from
 * Etherscan, chainid 1). It is a full mirror, not a hand-curated subset: the
 * prior curated snapshot drifted and was missing `allowlistMintBatch` and the
 * other batch/`*For` entrypoints. Re-fetch and diff against the deployed
 * address if the minter is ever redeployed.
 */
export const homageMinterAbi = [
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "collection_",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "token111_",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "feeRecipient_",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "poolManager_",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "currency0_",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "currency1_",
        "type": "address"
      },
      {
        "internalType": "uint24",
        "name": "fee_",
        "type": "uint24"
      },
      {
        "internalType": "int24",
        "name": "tickSpacing_",
        "type": "int24"
      },
      {
        "internalType": "address",
        "name": "hooks_",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "punksMarket_",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "delegateRegistry_",
        "type": "address"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "constructor"
  },
  {
    "inputs": [],
    "name": "AllowlistClosed",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "AllowlistRootFrozen",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "AlreadyActivated",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "AlreadyMinted",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "BadPunkId",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "BadSchedule",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ClaimClosed",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "CollectionAlreadyMinted",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "CollectionNotPooled",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "ethNeeded",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "ethBudget",
        "type": "uint256"
      }
    ],
    "name": "CostExceedsBudget",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "DrawPoolDesync",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ExitFeeOutOfBounds",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "FeeGraceOutOfBounds",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "FeeScheduleOutOfBounds",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "FeeTransferFailed",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "required",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "provided",
        "type": "uint256"
      }
    ],
    "name": "InsufficientValue",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "qty",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "maxBatch",
        "type": "uint256"
      }
    ],
    "name": "InvalidBatchQuantity",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidThreshold",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "MinterNotGranted",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "MinterNotLocked",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "id",
        "type": "uint256"
      }
    ],
    "name": "NonexistentToken",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotActivated",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotAllowlisted",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotBacked",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "dependency",
        "type": "address"
      }
    ],
    "name": "NotContract",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotDelegated",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotManager",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotPunkOwner",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotTokenOwner",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NothingToCollect",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NothingToRescue",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "owner",
        "type": "address"
      }
    ],
    "name": "OwnableInvalidOwner",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "account",
        "type": "address"
      }
    ],
    "name": "OwnableUnauthorizedAccount",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "PublicClosed",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "RedeemDelayOutOfBounds",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "opensAt",
        "type": "uint256"
      }
    ],
    "name": "RedeemLocked",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ReentrancyGuardReentrantCall",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "RefundFailed",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ReleaseNotOpen",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "RescueTransferFailed",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ReservationClosed",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "token",
        "type": "address"
      }
    ],
    "name": "SafeERC20FailedOperation",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "received",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "needed",
        "type": "uint256"
      }
    ],
    "name": "Slippage",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "SoldOut",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "SupplyCapTooLow",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ThresholdLocked",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "expected",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "provided",
        "type": "uint256"
      }
    ],
    "name": "WrongExitFee",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "WrongPoolCurrency",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ZeroAddress",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ZeroDependency",
    "type": "error"
  },
  {
    "anonymous": false,
    "inputs": [],
    "name": "Activated",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "bytes32",
        "name": "root",
        "type": "bytes32"
      }
    ],
    "name": "AllowlistRootSet",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "to",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "uint256",
        "name": "punkId",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "ethSwapped",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "received111",
        "type": "uint256"
      }
    ],
    "name": "Claimed",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "exitFee",
        "type": "uint256"
      }
    ],
    "name": "ExitFeeSet",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "feeGraceMints",
        "type": "uint256"
      }
    ],
    "name": "FeeGraceMintsSet",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "address",
        "name": "feeRecipient",
        "type": "address"
      }
    ],
    "name": "FeeRecipientSet",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "baseFee",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "feeGrowthBps",
        "type": "uint256"
      }
    ],
    "name": "FeeScheduleSet",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "to",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "uint256",
        "name": "punkId",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "ethSwapped",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "received111",
        "type": "uint256"
      }
    ],
    "name": "Minted",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "previousOwner",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "newOwner",
        "type": "address"
      }
    ],
    "name": "OwnershipTransferred",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "uint64",
        "name": "redeemDelay",
        "type": "uint64"
      }
    ],
    "name": "RedeemDelaySet",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "from",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "uint256",
        "name": "punkId",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "amount111",
        "type": "uint256"
      }
    ],
    "name": "Redeemed",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "uint256",
        "name": "punkId",
        "type": "uint256"
      }
    ],
    "name": "ReservationReleased",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "uint256",
        "name": "punkId",
        "type": "uint256"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "by",
        "type": "address"
      }
    ],
    "name": "Reserved",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "uint64",
        "name": "claimStart",
        "type": "uint64"
      },
      {
        "indexed": false,
        "internalType": "uint64",
        "name": "allowlistStart",
        "type": "uint64"
      },
      {
        "indexed": false,
        "internalType": "uint64",
        "name": "publicStart",
        "type": "uint64"
      }
    ],
    "name": "ScheduleSet",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "threshold",
        "type": "uint256"
      }
    ],
    "name": "ThresholdSet",
    "type": "event"
  },
  {
    "inputs": [],
    "name": "MAX_BATCH",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "MAX_EXIT_FEE",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "MAX_FEE_GRACE_MINTS",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "MAX_FEE_GROWTH_BPS",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "MAX_MINT_FEE",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "MAX_REDEEM_DELAY",
    "outputs": [
      {
        "internalType": "uint64",
        "name": "",
        "type": "uint64"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "SUPPLY",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "activate",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "activated",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32[]",
        "name": "proof",
        "type": "bytes32[]"
      }
    ],
    "name": "allowlistMint",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "payable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "qty",
        "type": "uint256"
      },
      {
        "internalType": "bytes32[]",
        "name": "proof",
        "type": "bytes32[]"
      }
    ],
    "name": "allowlistMintBatch",
    "outputs": [
      {
        "internalType": "uint256[]",
        "name": "ids",
        "type": "uint256[]"
      }
    ],
    "stateMutability": "payable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "vault",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "qty",
        "type": "uint256"
      },
      {
        "internalType": "bytes32[]",
        "name": "proof",
        "type": "bytes32[]"
      }
    ],
    "name": "allowlistMintBatchFor",
    "outputs": [
      {
        "internalType": "uint256[]",
        "name": "ids",
        "type": "uint256[]"
      }
    ],
    "stateMutability": "payable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "vault",
        "type": "address"
      },
      {
        "internalType": "bytes32[]",
        "name": "proof",
        "type": "bytes32[]"
      }
    ],
    "name": "allowlistMintFor",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "payable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "allowlistRoot",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "allowlistRootFrozen",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "allowlistStart",
    "outputs": [
      {
        "internalType": "uint64",
        "name": "",
        "type": "uint64"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "baseFee",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "punkId",
        "type": "uint256"
      }
    ],
    "name": "claim",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "payable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "punkId",
        "type": "uint256"
      },
      {
        "internalType": "address",
        "name": "vault",
        "type": "address"
      }
    ],
    "name": "claimFor",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "payable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "claimStart",
    "outputs": [
      {
        "internalType": "uint64",
        "name": "",
        "type": "uint64"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "punkId",
        "type": "uint256"
      }
    ],
    "name": "claimTo",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "payable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "collectFees",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "collection",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "currency0",
    "outputs": [
      {
        "internalType": "Currency",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "currency1",
    "outputs": [
      {
        "internalType": "Currency",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "delegateRegistry",
    "outputs": [
      {
        "internalType": "contract IDelegateRegistry",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "drawableRemaining",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "exitFee",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "n",
        "type": "uint256"
      }
    ],
    "name": "feeForCount",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "feeGraceMints",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "feeGrowthBps",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "feeRecipient",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "punkId",
        "type": "uint256"
      }
    ],
    "name": "isMinted",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "name": "isReserved",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "liveBackedSupply",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "mint",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "punkId",
        "type": "uint256"
      }
    ],
    "stateMutability": "payable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "qty",
        "type": "uint256"
      }
    ],
    "name": "mintBatch",
    "outputs": [
      {
        "internalType": "uint256[]",
        "name": "ids",
        "type": "uint256[]"
      }
    ],
    "stateMutability": "payable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address[]",
        "name": "tos",
        "type": "address[]"
      }
    ],
    "name": "mintBatchTo",
    "outputs": [
      {
        "internalType": "uint256[]",
        "name": "ids",
        "type": "uint256[]"
      }
    ],
    "stateMutability": "payable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "name": "mintCount",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "who",
        "type": "address"
      }
    ],
    "name": "mintFeeOf",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "to",
        "type": "address"
      }
    ],
    "name": "mintTo",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "punkId",
        "type": "uint256"
      }
    ],
    "stateMutability": "payable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "payer",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "to",
        "type": "address"
      }
    ],
    "name": "mintToFeeOf",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "owner",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "pendingFees",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "poolFee",
    "outputs": [
      {
        "internalType": "uint24",
        "name": "",
        "type": "uint24"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "poolHooks",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "poolManager",
    "outputs": [
      {
        "internalType": "contract IPoolManager",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "poolTickSpacing",
    "outputs": [
      {
        "internalType": "int24",
        "name": "",
        "type": "int24"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "publicStart",
    "outputs": [
      {
        "internalType": "uint64",
        "name": "",
        "type": "uint64"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "punksMarket",
    "outputs": [
      {
        "internalType": "contract ICryptoPunksMarket",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "who",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "qty",
        "type": "uint256"
      }
    ],
    "name": "quoteBatchFee",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "total",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address[]",
        "name": "tos",
        "type": "address[]"
      }
    ],
    "name": "quoteBatchFeeTo",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "total",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "payer",
        "type": "address"
      },
      {
        "internalType": "address[]",
        "name": "tos",
        "type": "address[]"
      }
    ],
    "name": "quoteBatchFeeTo",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "total",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "punkId",
        "type": "uint256"
      }
    ],
    "name": "redeem",
    "outputs": [],
    "stateMutability": "payable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "redeemDelay",
    "outputs": [
      {
        "internalType": "uint64",
        "name": "",
        "type": "uint64"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "redeemOpen",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "redeemOpensAt",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "redeemOpensAtFrozen",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "max",
        "type": "uint256"
      }
    ],
    "name": "releaseReserved",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "released",
        "type": "uint256"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "remaining",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "renounceOwnership",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "to",
        "type": "address"
      }
    ],
    "name": "rescueETH",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "reservationOpen",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256[]",
        "name": "ids",
        "type": "uint256[]"
      }
    ],
    "name": "reserve",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256[]",
        "name": "ids",
        "type": "uint256[]"
      }
    ],
    "name": "reserveMine",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256[]",
        "name": "ids",
        "type": "uint256[]"
      },
      {
        "internalType": "address",
        "name": "vault",
        "type": "address"
      }
    ],
    "name": "reserveVia",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "reservedCount",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "reservedRemaining",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "root",
        "type": "bytes32"
      }
    ],
    "name": "setAllowlistRoot",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "exitFee_",
        "type": "uint256"
      }
    ],
    "name": "setExitFee",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "feeGraceMints_",
        "type": "uint256"
      }
    ],
    "name": "setFeeGraceMints",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "f",
        "type": "address"
      }
    ],
    "name": "setFeeRecipient",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "baseFee_",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "feeGrowthBps_",
        "type": "uint256"
      }
    ],
    "name": "setFeeSchedule",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint64",
        "name": "redeemDelay_",
        "type": "uint64"
      }
    ],
    "name": "setRedeemDelay",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint64",
        "name": "claimStart_",
        "type": "uint64"
      },
      {
        "internalType": "uint64",
        "name": "allowlistStart_",
        "type": "uint64"
      },
      {
        "internalType": "uint64",
        "name": "publicStart_",
        "type": "uint64"
      }
    ],
    "name": "setSchedule",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "newThreshold",
        "type": "uint256"
      }
    ],
    "name": "setThreshold",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "id",
        "type": "uint256"
      }
    ],
    "name": "svg",
    "outputs": [
      {
        "internalType": "string",
        "name": "",
        "type": "string"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "id",
        "type": "uint256"
      }
    ],
    "name": "svgPfp",
    "outputs": [
      {
        "internalType": "string",
        "name": "",
        "type": "string"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "threshold",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "token111",
    "outputs": [
      {
        "internalType": "contract IERC20",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "totalMinted",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "newOwner",
        "type": "address"
      }
    ],
    "name": "transferOwnership",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes",
        "name": "data",
        "type": "bytes"
      }
    ],
    "name": "unlockCallback",
    "outputs": [
      {
        "internalType": "bytes",
        "name": "",
        "type": "bytes"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  }
] as const

/**
 * The pooled PND Collection — the ERC-721 Homage mints INTO. Ownership,
 * transfers, and metadata (tokenURI delegates to the renderer slot) live
 * here; economics/schedule/redeem do NOT (see `homageMinterAbi`). This is
 * the ONLY contract whose `Transfer` events are the mint-reveal signal.
 */
export const homageCollectionAbi = [
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
] as const

/**
 * HomageRendererSovereign — the shared punk-derived renderer behind the
 * collection's `tokenURI` (its base, `HomageRenderer`, does the actual Albers
 * art / color distillation / attributes; the Sovereign adapter only maps the
 * PND Collection renderer-slot calling convention onto it — see
 * `contracts/src/HomageRendererSovereign.sol`). Renders any punk id 0..9999
 * (minted or not) from the onchain punk pixels + live market status, so the
 * collection hero can show a representative homage without a token existing.
 *
 * Two call surfaces, both on this one renderer address:
 *   - the base `HomageRenderer` punk-id surface: `tokenURI(uint256)` (live
 *     market status, square form), `tokenURI(uint256,uint8,bool)` and
 *     `renderSVG(uint256,uint8,bool)` (explicit status + form, `circle` for
 *     the PFP treatment), `pfpSVG(uint256,uint8)`, `colorCount(uint256)`,
 *     `statusOf(uint256)`, and the owner-settable `collectionName()` /
 *     `collectionDescription()` getters.
 *   - the `IPreviewRenderer`/`IRenderer` adapter surface the PND Collection
 *     itself calls: `tokenURI(address,uint256)`, `contractURI(address)`,
 *     `previewURI(address,uint256,bytes32)` (a random-punk preview keyed by
 *     seed; `collection`/`tokenId` are ignored on all three).
 *
 * Reconstructed from `contracts/src/HomageRenderer.sol` and
 * `HomageRendererSovereign.sol` (sovereign-rebuild branch) after the prior
 * version of this ABI drifted from a pre-rebuild renderer with a different
 * function surface (`tokenURIPfp`, `renderSVGPfp`, `previewSVG`,
 * `previewTokenURI`, `previewSVGPfp`, `previewTokenURIPfp` never existed on
 * the deployed contract). Same hand-synced / pre-audit-freeze caveat as
 * `homageMinterAbi` above.
 */
export const homageRendererAbi = [
  // ── base HomageRenderer punk-id surface ────────────────────────────
  {
    type: "function",
    name: "tokenURI",
    inputs: [{ name: "id", type: "uint256", internalType: "uint256" }],
    outputs: [{ name: "", type: "string", internalType: "string" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "tokenURI",
    inputs: [
      { name: "id", type: "uint256", internalType: "uint256" },
      { name: "status", type: "uint8", internalType: "uint8" },
      { name: "circle", type: "bool", internalType: "bool" },
    ],
    outputs: [{ name: "", type: "string", internalType: "string" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "renderSVG",
    inputs: [
      { name: "id", type: "uint256", internalType: "uint256" },
      { name: "status", type: "uint8", internalType: "uint8" },
      { name: "circle", type: "bool", internalType: "bool" },
    ],
    outputs: [{ name: "", type: "string", internalType: "string" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "pfpSVG",
    inputs: [
      { name: "id", type: "uint256", internalType: "uint256" },
      { name: "status", type: "uint8", internalType: "uint8" },
    ],
    outputs: [{ name: "", type: "string", internalType: "string" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "statusOf",
    inputs: [{ name: "id", type: "uint256", internalType: "uint256" }],
    outputs: [{ name: "", type: "uint8", internalType: "uint8" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "colorCount",
    inputs: [{ name: "id", type: "uint256", internalType: "uint256" }],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "collectionName",
    inputs: [],
    outputs: [{ name: "", type: "string", internalType: "string" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "collectionDescription",
    inputs: [],
    outputs: [{ name: "", type: "string", internalType: "string" }],
    stateMutability: "view",
  },

  // ── IPreviewRenderer / IRenderer adapter surface (PND Collection calls
  //    these; `collection` is ignored — the art derives only from the punk
  //    id / seed) ─────────────────────────────────────────────────────
  {
    type: "function",
    name: "tokenURI",
    inputs: [
      { name: "", type: "address", internalType: "address" },
      { name: "id", type: "uint256", internalType: "uint256" },
    ],
    outputs: [{ name: "", type: "string", internalType: "string" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "contractURI",
    inputs: [{ name: "", type: "address", internalType: "address" }],
    outputs: [{ name: "", type: "string", internalType: "string" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "previewURI",
    inputs: [
      { name: "", type: "address", internalType: "address" },
      { name: "", type: "uint256", internalType: "uint256" },
      { name: "seed", type: "bytes32", internalType: "bytes32" },
    ],
    outputs: [{ name: "", type: "string", internalType: "string" }],
    stateMutability: "view",
  },
] as const
