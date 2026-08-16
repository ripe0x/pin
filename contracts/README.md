# Sovereign Auction House Contracts

ETH-only reserve auctions for ERC721 tokens. Per-owner EIP-1167 minimal-proxy
clones deployed via `SovereignAuctionHouseFactory` — every seller (artist or
collector) deploys and runs their own auction house. Adapted from Zora's
AuctionHouse, ported to Solidity 0.8 and restructured for fully immutable
deployment: no admin keys, no upgrade path, no protocol-level setters.
Ownership of each house is locked at deploy (transferOwnership /
renounceOwnership revert). To change the implementation, fee, or recipient,
deploy a new factory.

## Deployed on Ethereum mainnet

Canonical shared singletons and clone implementations. The machine-readable
source of truth is [`deployments.mainnet.json`](./deployments.mainnet.json);
the docs reference tables resolve from it. Deployed 2026-07-22 from commit
`fa5af29`; source verified against these addresses with `forge verify-bytecode`
(full creation + runtime match). Per-owner collections and auction houses are
EIP-1167 clones and are not listed here.

| Contract | Address |
| --- | --- |
| SurfaceFactory | [`0xdB81d3F33EF3D84685486916E0d372E247558094`](https://evm.now/address/0xdB81d3F33EF3D84685486916E0d372E247558094?chainId=1) |
| Surface (sequential implementation) | [`0xd0cC38cB3BD18FbdAD278f14AD1f40E513f846Ef`](https://evm.now/address/0xd0cC38cB3BD18FbdAD278f14AD1f40E513f846Ef?chainId=1) |
| PooledSurface (pooled implementation) | [`0xd2e3Ac74DbF40c454a4211db5CF137c7355421eA`](https://evm.now/address/0xd2e3Ac74DbF40c454a4211db5CF137c7355421eA?chainId=1) |
| FixedPriceMinter (minter implementation) | [`0x50941e5fd0B177826AB86419502b221049821Ba3`](https://evm.now/address/0x50941e5fd0B177826AB86419502b221049821Ba3?chainId=1) |
| Catalog | [`0x467a9c39e03C595EC3075D856f19C7386b6b915d`](https://evm.now/address/0x467a9c39e03C595EC3075D856f19C7386b6b915d?chainId=1) |
| SovereignAuctionHouseFactory | [`0xaE712abcA452901A74D1FBC0c3919F2cc060EF9f`](https://evm.now/address/0xaE712abcA452901A74D1FBC0c3919F2cc060EF9f?chainId=1) |
| SovereignAuctionHouse (implementation) | [`0xC70D8a99b915BeDA52C5A952E29FFE152CbfCB34`](https://evm.now/address/0xC70D8a99b915BeDA52C5A952E29FFE152CbfCB34?chainId=1) |

Reproduce the deployed bytecode with the `mainnet` profile (pins the deploy-time
compiler settings, `cancun` + `via-ir`):

```bash
FOUNDRY_PROFILE=mainnet forge verify-bytecode \
  0xdB81d3F33EF3D84685486916E0d372E247558094 SurfaceFactory \
  --rpc-url "$MAINNET_RPC_URL" --etherscan-api-key "$ETHERSCAN_API_KEY"
```

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
# Unit tests (67 tests)
forge test --no-match-contract Fork

# Full suite including the mainnet-fork test
export MAINNET_RPC_URL="https://eth-mainnet.g.alchemy.com/v2/<YOUR_KEY>"
forge test --fork-url "$MAINNET_RPC_URL"
```

Layout:

- `test/SovereignAuctionHouse.t.sol` — unit tests (create/bid/settle/cancel/
  reserve-edit/extension/refund-fallback/escrow-check/ownership-lock/
  duplicate-listing/zero-bid)
- `test/SovereignAuctionHouseFork.t.sol` — full flow against a real mainnet
  ERC721 (BAYC) on a forked chain

## Deploy

Required env vars:

| Var | Purpose |
|---|---|
| `PND_FEE_RECIPIENT` | Treasury that receives protocol fees. Use `0x0` only when fee bps is `0` (the constructor enforces that pairing). Locked forever once deployed. |
| `PND_PROTOCOL_FEE_BPS` | Optional. Protocol fee bps. Default `0`. Capped at `500` (5%). Locked forever once deployed. |
| `MAINNET_RPC_URL` | RPC endpoint. |
| `DEPLOYER_PK` | Deployer private key. |
| `ETHERSCAN_API_KEY` | For verification. Also resolved from `[etherscan]` block in `foundry.toml`. |

```bash
forge script script/Deploy.s.sol \
  --rpc-url $MAINNET_RPC_URL \
  --private-key $DEPLOYER_PK \
  --broadcast \
  --verify \
  --etherscan-api-key $ETHERSCAN_API_KEY
```

The script asserts post-deploy that `factory.implementation()`,
`factory.defaultFeeRecipient()`, and `factory.defaultProtocolFeeBps()` match
the constructor inputs. Any mismatch reverts the run loud rather than
silently producing a half-broken factory.

After deploy, paste the factory address into
[`packages/addresses/src/index.ts`](../packages/addresses/src/index.ts)
(`SOVEREIGN_AUCTION_HOUSE_FACTORY`).

## Regenerating ABIs for the web app

After any contract change:

```bash
forge build
node ../scripts/emit-sovereign-abi.mjs
```
