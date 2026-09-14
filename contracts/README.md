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
| SovereignAuctionHouseV2Factory | [`0x77aB853543286C9Cdd7dd6c01222A7cC4Ac93d63`](https://evm.now/address/0x77aB853543286C9Cdd7dd6c01222A7cC4Ac93d63?chainId=1) |
| SovereignAuctionHouseV2 (implementation) | [`0x88b48793f38EF7370F2e7BC12E2f73DC565C117F`](https://evm.now/address/0x88b48793f38EF7370F2e7BC12E2f73DC565C117F?chainId=1) |

The Auction House V2 pair deployed 2026-09-02 from commit `49a5a696`
(`DeployAuctionV2.s.sol`, 0 bps fee, zero fee recipient): implementation at
block 25901755 (tx `0x2c538141…6ddd`), factory at block 25901772 (tx
`0x5202cc23…52cb`). Both sources are verified on Etherscan under the default
profile. The v1 factory and implementation stay live for existing houses; V2
houses settle with escrow-and-wait (seller paid only after verified delivery).
The drift guard is `test/AuctionV2MainnetDeployment.t.sol`.

Reproduce the deployed bytecode with the default profile (solc 0.8.24,
optimizer runs 200, no via-ir). The 2026-07-22 deploy (commit `fa5af29`) built
under that profile: its `foundry.toml` set no `evm_version` and no `via_ir`, so
a plain `forge build` byte-matches mainnet:

```bash
forge verify-bytecode \
  0xdB81d3F33EF3D84685486916E0d372E247558094 SurfaceFactory \
  --rpc-url "$MAINNET_RPC_URL" --etherscan-api-key "$ETHERSCAN_API_KEY"
```

The runtime bytecode of Surface, PooledSurface, and FixedPriceMinter matches
exactly under the default profile except the trailing 53-byte CBOR metadata
hash (`forge verify-bytecode` ignores it); SurfaceFactory additionally differs
in its baked-in immutable constructor args. Do not enable via-ir to reproduce
the deploy: the via-ir build is ~1300 bytes smaller per contract and does not
match.

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

Always pass `--slow` on a multi-transaction broadcast. The mainnet deployer
key is an EIP-7702 delegated account, and nodes allow a delegated account only
one in-flight transaction with no nonce gaps (`gapped-nonce tx from delegated
accounts`). Without `--slow` a two-contract script lands the first transaction
and rejects the rest. A run that failed midway resumes with `--resume --slow`,
which sends only the unsent transactions; confirm the deployer nonce has not
moved first.

Required env vars:

| Var | Purpose |
|---|---|
| `PND_FEE_RECIPIENT` | Treasury that receives protocol fees. Use `0x0` only when fee bps is `0` (the constructor enforces that pairing). Locked forever once deployed. |
| `PND_PROTOCOL_FEE_BPS` | Optional. Protocol fee bps. Default `0`. Capped at `500` (5%). Locked forever once deployed. |
| `MAINNET_RPC_URL` | RPC endpoint. |
| `DEPLOYER_PK` | Deployer private key (or use `--account <keystore>` instead). |
| `ETHERSCAN_API_KEY` | For verification. Also resolved from `[etherscan]` block in `foundry.toml`. |

```bash
forge script script/Deploy.s.sol \
  --rpc-url $MAINNET_RPC_URL \
  --private-key $DEPLOYER_PK \
  --broadcast --slow \
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

## Surface v2 deploy

One deploy path for the Surface v2 core (SurfaceV2 implementation,
FixedPriceMinterV2 implementation, RenderAssets, DefaultRenderer,
SurfaceFactoryV2) across every environment: `script/DeploySurfaceV2.s.sol` is
the only deploy script, `script/deploy.sh <env>` is the only wrapper, and
`script/env/<env>.env` holds the per-environment values (no secrets). Anvil,
the fork test, sepolia and mainnet all run the same script and the same
guards; only the env file's values differ.

Simulate first, then broadcast:

```bash
DRY_RUN=1 script/deploy.sh sepolia
script/deploy.sh sepolia
```

`DRY_RUN=1` runs every guard and the full script simulation with no wallet,
no `--broadcast`, and no record written. A dropped connection mid-broadcast
resumes with:

```bash
script/deploy.sh sepolia --resume
```

Keystore setup for `WALLET_MODE=keystore` (sepolia and mainnet):

```bash
cast wallet import ripe0x --interactive
export DEPLOYER_ACCOUNT=ripe0x
```

`DEPLOYER_PASSWORD_FILE` (chmod 600) replaces the interactive password
prompt when set. Mainnet's env file ships `DEPLOYER` and `CATALOG` empty on
purpose: the wrapper refuses to run, `DRY_RUN` included, until both are
filled in.

The mainnet deployer is EIP-7702 delegated and accepts only one in-flight
transaction; `deploy.sh` always broadcasts with `--slow` regardless of
target, so a multi-transaction deploy never lands a gapped nonce.

`RENDER_ASSETS` and `DEFAULT_RENDERER` are reused when the env file names an
address with deployed code, otherwise the script deploys fresh instances.
`CATALOG` must already exist on sepolia and mainnet; a local chain deploys
one when left empty.

After a real broadcast, `deploy.sh` patches `factoryDeployBlock` and
`txHashes` into `deployments/<chainId>.json` from the broadcast receipts and
prints an on-chain readback of the factory's wiring. `deployments/31337.json`
and other local-chain test records are gitignored; a sepolia or mainnet
record is a real deployment and stays tracked.

## Regenerating ABIs for the web app

After any contract change:

```bash
forge build
node ../scripts/emit-sovereign-abi.mjs
```
