# anton — deployments

Current target: `Form of Solitude` / `SOLITUDE`, supply cap 256. Local and
Sepolia mint price: 0.001 ETH. Mainnet price is configured separately in the
studio. The Sepolia collection below is historical: it was created with a 999
cap and must be updated onchain to 256. Do not infer its live renderer or cap
from this file; read `renderer()` and `config()` before a broadcast.

To update the existing Sepolia collection, run `bash script/update-anton-sepolia.sh`
from `contracts/`. The wrapper uses the existing deploy scripts, checks the
chain, signer, owner, price and receipts, and asks for explicit confirmation
before each transaction. `--plan` only reads state. It saves public addresses
and transaction hashes in ignored `contracts/broadcast/anton-sepolia-update.json`
so an interrupted run can be reconciled and resumed. `DeployAntonWork.s.sol`
creates a *new* collection and must not be used for this update.
Keep writes to the old capture registry paused from the renderer-swap prompt
through its receipt; the wrapper rechecks image parity immediately before
sending, but a separate capture write could otherwise race that swap.
If the first RenderAssets creation failed onchain and the wrapper reports a
pending deployment, use `--retry-failed-render-assets <tx-hash>`. That path
checks the failed receipt, signer, predicted address, absent code and consumed
nonce before retrying with a larger gas estimate. Never clear the recovery
record or blindly rerun a failed deployment.

For a renderer update using editable copy, deploy a new `RenderAssets` with
`tokenDescriptionOf`, `collectionDescriptionOf` and `externalUrlOf`. The old
Sepolia registry at `0xF314c0CAA5E3f55e1046626D1CAdF511c127423F` lacks
those getters. Its capture template for this collection is
`ar://BBUEubbqaZ4AEhfczg9ciU2HkQA3LGHqFsCZRitrEJaX/{id}.png`, bound to
token ID 5; migrate it to the new registry before switching renderers. The
old registry has no cover for this collection. At the pinned review block
11949921, token images 1–5 resolved through the template and 6–25 were empty.
`MigrateAntonCaptures.s.sol` performs this copy as one authorized transaction
and checks every minted token against the old registry before broadcast.

## Sepolia (stateless build, 2026-09-04)

Stateless animation (wall clock + owner offset + seed, no per-frame state),
viewport-filling live canvas, minified script (6.5 KB gz). Reuses the sepolia
`SurfaceFactory` from the previous deploy. Explorer:
https://sepolia.etherscan.io/address/<addr>

| Contract | Address |
| --- | --- |
| collection (Form of Solitude) | `0xE95F98179a6365881aed0cb5331D96976E9Fe09b` |
| minter (stock FixedPriceMinter) | `0x76EA8061A941858001811B003a630EC67029284e` |
| AntonRenderer | `0x7e138d7f5Dc7150734b1b898f2B42ad181A348fA` |
| AntonScriptStore | `0xD6b2bAf7e617B08B0B5E46a90971F23954D508Be` |
| SurfaceFactory (sepolia, reused) | `0x93Ee7F8F854102AF7F1518AD2E6F74681487e09e` |

Shared deps (deterministic): ScriptyBuilderV2 `0xD7587F110E08F4D120A231bA97d3B577A81Df022`,
EthFS `0x8FAA1AAb9DA8c75917C43Fb24fDdb513edDC3245`.

## Sepolia (fully-generative build, 2026-08, superseded)

| Contract | Address |
| --- | --- |
| collection (untitled) | `0xFD383E3dDa1C658E5372f9be0852E834afC8E343` |
| minter (stock FixedPriceMinter) | `0x3c9b0690963AA4427c4E490eE9a9767E48b863Ef` |
| AntonRenderer | `0x4D9C9Bee8eDe61dF0b80c53C5863dA749F1545C4` |
| AntonScriptStore | `0x7740afcef0b1acf9c0dc7431dd050642291bea5c` |
