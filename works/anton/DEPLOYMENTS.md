# anton — deployments

Placeholder config: name `untitled` / symbol `UNTITLED`, price 0.001 ETH,
supply cap 999, open-ended window, 5% royalty, owner `ripe0x.eth`
(`0xCB43078C32423F5348Cab5885911C3B5faE217F9`). Not audited; not final.

## Sepolia (dry-run, 2026-08)

Deployed + minted + rendered end to end from chain state. Explorer:
https://sepolia.etherscan.io/address/<addr>

| Contract | Address |
| --- | --- |
| AntonParams | `0x9b11c5eda909c92336e1936d62fe05741f6e21f5` |
| AntonScriptStore | `0x3c76b7bf6167027d7d6e3e3dbf1c715bbbfd3295` |
| AntonRenderer | `0x4219d5d09d95ffa3f7d58fc322be42ed15577444` |
| collection (untitled) | `0xab2ed7da970f4b2fc34033da4fd77e5b2150484e` |
| AntonMinter | `0x09706e33777105079363cb1aefb1e1164bf1a230` |
| SurfaceFactory (fresh) | `0xc8a969b2be8dae4b84bf7d74c1c907f978c24b3b` |

Shared onchain deps (deterministic, same address every chain):
ScriptyBuilderV2 `0xD7587F110E08F4D120A231bA97d3B577A81Df022`,
EthFS `0x8FAA1AAb9DA8c75917C43Fb24fDdb513edDC3245`.

Redeployed 2026-08 (timing-only wallet sync + random mint). Token 1 drew palette B / tone moon from its seed. Contracts verified on Etherscan.
