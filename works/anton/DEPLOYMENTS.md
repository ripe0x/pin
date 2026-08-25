# anton — deployments

Placeholder config: name `untitled` / symbol `UNTITLED`, price 0.001 ETH, supply
cap 999, open-ended window, 5% royalty, owner `ripe0x.eth`
(`0xCB43078C32423F5348Cab5885911C3B5faE217F9`). Not audited; not final.

## Sepolia (fully-generative build, 2026-08)

Fully generative: no custom minter, no per-token storage. `createSurface` bundles
the stock `FixedPriceMinter` (batch mint built in). Palette/tone derive from each
token's seed. Explorer: https://sepolia.etherscan.io/address/<addr>

| Contract | Address |
| --- | --- |
| collection (untitled) | `0xFD383E3dDa1C658E5372f9be0852E834afC8E343` |
| minter (stock FixedPriceMinter) | `0x3c9b0690963AA4427c4E490eE9a9767E48b863Ef` |
| AntonRenderer | `0x4D9C9Bee8eDe61dF0b80c53C5863dA749F1545C4` |
| AntonScriptStore | `0x7740afcef0b1acf9c0dc7431dd050642291bea5c` |

Shared deps (deterministic): ScriptyBuilderV2 `0xD7587F110E08F4D120A231bA97d3B577A81Df022`,
EthFS `0x8FAA1AAb9DA8c75917C43Fb24fDdb513edDC3245`.

Verified batch mint of 3 (distinct seeds → distinct palette/tone). Anton
contracts verified on Etherscan.
