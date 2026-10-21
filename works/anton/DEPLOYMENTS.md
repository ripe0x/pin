# anton — deployments

Current target: `Form of Solitude` / `SOLITUDE`, supply cap 256. Local and
Sepolia mint price: 0.001 ETH. Mainnet price is configured separately in the
studio. Read `renderer()` and `config()` before any further broadcast.

To update the existing Sepolia collection, run `bash script/update-anton-sepolia.sh`
from `contracts/`. The wrapper uses the existing deploy scripts, checks the
chain, signer, owner, price and receipts, and asks for explicit confirmation
before each transaction. `--plan` only reads state. It saves public addresses
and transaction hashes in ignored `contracts/broadcast/anton-sepolia-update.json`
so an interrupted run can be reconciled and resumed. `DeployAntonWork.s.sol`
creates a *new* collection and must not be used for this update.
By default, Foundry prompts for the `ripe0x` keystore password; the wrapper
does not choose a password file. To use an existing file deliberately, set
`ANTON_PASSWORD_FILE` to its path before running.
Keep writes to the old capture registry paused from the renderer-swap prompt
through its receipt; the wrapper rechecks image parity immediately before
sending, but a separate capture write could otherwise race that swap.
If the first RenderAssets creation failed onchain and the wrapper reports a
pending deployment, use `--retry-failed-render-assets <tx-hash>`. That path
checks the failed receipt, signer, predicted address, absent code and consumed
nonce before retrying with a larger gas estimate. Never clear the recovery
record or blindly rerun a failed deployment.
Each Foundry transaction uses a dry run followed by Sepolia's live
`eth_estimateGas` with 25% gas-limit headroom. Sepolia's state-creation gas
rules make Forge's local estimate too low for these deployments.

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

## Sepolia (artist v3 update, 2026-10-21)

The existing collection now uses the artist's v3 script. The update retained
the 25 minted tokens, their seeds, the minter, and the capture template.

| Contract | Address |
| --- | --- |
| collection (Form of Solitude) | `0xE95F98179a6365881aed0cb5331D96976E9Fe09b` |
| minter (stock FixedPriceMinter) | `0x76EA8061A941858001811B003a630EC67029284e` |
| AntonRenderer | `0x502d3a5B7Eb0d81494D6e16d7D35Ed12936F0DFd` |
| AntonScriptStore | `0xd9c8fc6d15e31bdd8f5eb59477a54fd7ebaa1304` |
| RenderAssets (editable metadata and captures) | `0xe248c1ebcd2075b2cbadb6ce2eaae45a02a15e7d` |

Confirmed collection state: supply cap 256, price 0.001 ETH, 25 minted.
`tokenURI` returns named Palette, Mode, and Flow traits plus the artist's token
description; `contractURI` returns the artist's collection description. The
descriptions and external URL can be edited in RenderAssets after deployment.
The preview is https://ripe-anton-untitled-preview.netlify.app/.

Update transactions: RenderAssets
`0x96602f58bb2cd08c04d5f340800ccd48669ae9f9784d95391172f57d6d4ee229`,
capture migration
`0x9105ab28513f82f7e3285d830a942e2eecf7396e5553c01458ce7d3b25602b14`,
script store
`0x1e5ef9625080503691ca9ff308c291ad74de7b7b92b24f350878e5b74a0e8828`,
renderer
`0xd4bace4057341094404303084c620d07cb148d4be3d96d62969b631162c6e35a`,
renderer swap
`0xeb9fbd2179ca44af429a83ce89b4acc48b48f02d61190d7c10dbb615d1547f86`,
and supply cap
`0xe0ee41aa3974b09a5cd291d8339209f8446682ee3999165654e377ea85be52a3`.

The migrated capture template is bound through token 5. Tokens 6–25 currently
have no `image` in `tokenURI`; animation URLs work. The collection cover image
and external URL have not been set. A cover image URI is needed for marketplace
thumbnails while token captures are pending.

## Sepolia (stateless build, 2026-09-04, superseded renderer)

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
