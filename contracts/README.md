# PND Auction Contracts

ETH-only reserve auctions for ERC721 tokens. Per-artist BeaconProxy clones
deployed via `PndAuctionHouseFactory`. Adapted from Zora's AuctionHouse,
ported to Solidity 0.8 and wrapped for upgradeable per-artist deployment.

## Setup

```bash
cd contracts
forge install OpenZeppelin/openzeppelin-contracts --no-git
forge install OpenZeppelin/openzeppelin-contracts-upgradeable --no-git
forge install foundry-rs/forge-std --no-git
forge build
```

## Test

```bash
# Unit + upgrade tests
forge test

# Full suite including the mainnet fork test
export MAINNET_RPC_URL="https://eth-mainnet.g.alchemy.com/v2/<YOUR_KEY>"
forge test --fork-url "$MAINNET_RPC_URL"
```

44 tests across:
- `test/PndAuctionHouse.t.sol` — unit tests (create/bid/settle/cancel/update/extension/cap/refund-fallback)
- `test/PndAuctionHouseUpgrade.t.sol` — beacon upgrade preserves state across all clones
- `test/PndAuctionHouseFork.t.sol` — full flow against a real mainnet ERC721 (BAYC)

## Deploy

Required env vars:

| Var | Purpose |
|---|---|
| `PND_BEACON_OWNER` | Multisig that controls implementation upgrades |
| `PND_FACTORY_OWNER` | Operator that controls factory defaults |
| `PND_FEE_ADMIN` | Multisig that controls per-house fee config |
| `PND_FEE_RECIPIENT` | Treasury that receives protocol fees |
| `PND_INITIAL_FEE_BPS` | Optional. Initial protocol fee bps. Default 0. Capped at 500 (5%). |
| `MAINNET_RPC_URL` | RPC endpoint |
| `DEPLOYER_PK` | Deployer private key |
| `ETHERSCAN_API_KEY` | For verification |

```bash
forge script script/Deploy.s.sol \
  --rpc-url $MAINNET_RPC_URL \
  --private-key $DEPLOYER_PK \
  --broadcast \
  --verify \
  --etherscan-api-key $ETHERSCAN_API_KEY
```

After deploy, paste the factory address into
`packages/addresses/src/index.ts` (`PND_AUCTION_HOUSE_FACTORY`).

## Regenerating ABIs for the web app

After any contract change:

```bash
forge build
node ../scripts/emit-pnd-abi.mjs
```
