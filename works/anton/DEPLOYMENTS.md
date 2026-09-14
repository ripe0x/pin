# anton — deployments

Config: name `Form of Solitude` / symbol `SOLITUDE` (symbol is a placeholder),
price 0.001 ETH, supply cap 999, open-ended window, 5% royalty, owner
`ripe0x.eth` (`0xCB43078C32423F5348Cab5885911C3B5faE217F9`). Not audited; not
final.

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
