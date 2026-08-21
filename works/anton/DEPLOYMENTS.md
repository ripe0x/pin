# anton — deployments

Placeholder config: name `untitled` / symbol `UNTITLED`, price 0.001 ETH,
supply cap 999, open-ended window, 5% royalty, owner `ripe0x.eth`
(`0xCB43078C32423F5348Cab5885911C3B5faE217F9`). Not audited; not final.

## Sepolia (dry-run, 2026-08)

Deployed + minted + rendered end to end from chain state. Explorer:
https://sepolia.etherscan.io/address/<addr>

| Contract | Address |
| --- | --- |
| AntonParams | `0x9cbbc6c7a4ec5aa6e195bc12c6f323e1473f9a58` |
| AntonScriptStore | `0x732015148c8b93c30969a6f0286ac9f8b0e79599` |
| AntonRenderer | `0x1cd4a08ef39751906d54283a83443f65a49a8702` |
| collection (untitled) | `0xa857d27bf423bd932022cc5f98264bf32e491a11` |
| AntonMinter | `0x1f425666e0f440448162b2298af2a506fefc147d` |
| SurfaceFactory (fresh) | `0xc8a969b2be8dae4b84bf7d74c1c907f978c24b3b` |

Shared onchain deps (deterministic, same address every chain):
ScriptyBuilderV2 `0xD7587F110E08F4D120A231bA97d3B577A81Df022`,
EthFS `0x8FAA1AAb9DA8c75917C43Fb24fDdb513edDC3245`.

Token 1: palette G, tone sun, seed stamped at mint. AntonParams / AntonMinter /
AntonRenderer / AntonScriptStore + the Surface impl are verified on Etherscan
(the collection clone reads as a proxy to the verified Surface impl).
