---
title: ABIs and the protocol manifest
description: Where integrators get machine-readable data: served ABI files, the @pin/abi package, the protocol manifest, llms.txt, and the docs search index.
---

# ABIs and the protocol manifest

This page documents the machine-readable files themselves. For task-oriented recipes that use them, start at [AI agents](/docs/offchain/ai-agents).

Four entry points, all served as static JSON:

| Path | What it is |
| --- | --- |
| [`/protocol-manifest.json`](/protocol-manifest.json) | addresses, contract kinds, ABI paths, and docs links for every contract, grouped by protocol |
| `/abis/<ContractName>.json` | the raw ABI array for each contract, e.g. `/abis/Surface.json` |
| [`/llms.txt`](/llms.txt) | LLM orientation file: a compact summary of the protocols plus a linked index of every docs page |
| [`/docs-search-index.json`](/docs-search-index.json) | the docs search corpus, an array of `{path, page, heading, anchor, text}` entries |

## The protocol manifest

`/protocol-manifest.json` is the single machine-readable root. It groups every contract under its protocol (`surface`, `auctions`, `catalog`), and for each carries the address, ABI path, docs link, and the contract "kind" (a `singleton` factory or shared module, a per-owner `clone` template, or an ABI-only `interface`). Per-owner clones (an artist collection, an auction house) aren't individually listed, since there is no fixed set of them; discover them through the relevant factory instead (see [AI agents](/docs/offchain/ai-agents)).

```json
{
  "name": "PND onchain protocols",
  "chainId": 1,
  "docs": "/docs",
  "llms": "/llms.txt",
  "protocols": {
    "surface": {
      "title": "Surface",
      "docs": "/docs/surface/overview",
      "contracts": {
        "Surface": {
          "address": null,
          "kind": "clone",
          "abi": "/abis/Surface.json",
          "docs": "/docs/surface/contracts/surface",
          "role": "The thin ERC721 token core of the PND Surface System..."
        },
        "SurfaceFactory": {
          "address": "{{addr:surfaceFactory}}",
          "kind": "singleton",
          "abi": "/abis/SurfaceFactory.json",
          "docs": "/docs/surface/contracts/factory",
          "role": "Deploys a Surface clone and its canonical minter in one transaction"
        },
        "FixedPriceMinter": {
          "address": null,
          "kind": "clone",
          "abi": "/abis/FixedPriceMinter.json",
          "docs": "/docs/surface/contracts/fixed-price-minter",
          "role": "The canonical fixed-price/referral minter, one clone per collection"
        }
      }
    },
    "auctions": {
      "title": "Auctions",
      "docs": "/docs/auctions/overview",
      "contracts": {
        "SovereignAuctionHouse": {
          "address": null,
          "kind": "clone",
          "abi": "/abis/SovereignAuctionHouse.json",
          "docs": "/docs/auctions/contracts/sovereign-auction-house",
          "role": "A per-owner English-auction house for any ERC721"
        }
      }
    },
    "catalog": {
      "title": "Catalog",
      "docs": "/docs/catalog/overview",
      "contracts": {
        "Catalog": {
          "address": "{{addr:catalog}}",
          "kind": "singleton",
          "abi": "/abis/Catalog.json",
          "docs": "/docs/catalog/contracts/catalog",
          "role": "A general onchain artist registry, read for creator attribution"
        }
      }
    }
  }
}
```

## Available contract names

ABIs are served under `/abis/` for every contract and interface across the protocols:

Surface token, factory, and canonical minter: `Surface`, `SurfaceFactory`, `FixedPriceMinter`

Surface shared singletons: `DefaultRenderer`, `RenderAssets`

Surface renderer template: `ScriptyRenderer`

Surface slot and view interfaces: `IPriceStrategy`, `IRenderer`, `ISurfaceView`, `IPreviewRenderer`

Auctions: `SovereignAuctionHouse`, `SovereignAuctionHouseFactory`

Catalog: `Catalog`

Fetch any of these directly, e.g. `/abis/Surface.json`, or import the typed version from the npm workspace package.

## The @pin/abi package

Every ABI is also shipped as a typed TypeScript export in the `@pin/abi` workspace package, `as const` for viem/wagmi type inference:

```ts
import {surfaceAbi, surfaceFactoryAbi, fixedPriceMinterAbi} from '@pin/abi';
import {defaultRendererAbi, renderAssetsAbi, scriptyRendererAbi} from '@pin/abi';
import {iPriceStrategyAbi, iRendererAbi, iSurfaceViewAbi, iPreviewRendererAbi} from '@pin/abi';
import {sovereignAuctionHouseAbi, sovereignAuctionHouseFactoryAbi} from '@pin/abi';
```

If you're inside the monorepo, prefer this import over fetching JSON at runtime. Outside the monorepo, fetch `/abis/<Name>.json`; both sources are generated from the same compiled contracts and stay in sync.

## Loading the manifest with viem

```ts
import {createPublicClient, getContract, http} from 'viem';
import {mainnet} from 'viem/chains';

const ORIGIN = 'https://pnd.ripe.wtf';

const manifest = await fetch(`${ORIGIN}/protocol-manifest.json`).then((r) => r.json());
const entry = manifest.protocols.surface.contracts.SurfaceFactory;
const abi = await fetch(`${ORIGIN}${entry.abi}`).then((r) => r.json());

const client = createPublicClient({
  chain: mainnet,
  transport: http('https://ethereum-rpc.publicnode.com'),
});

const factory = getContract({address: entry.address, abi, client});
const total = await factory.read.totalSurfaces();
```

## Deployment status

Catalog and the auction house factory are deployed on Ethereum mainnet; their addresses are populated in `/protocol-manifest.json` and resolved in every `{{addr:...}}` placeholder. The Surface System is pre-deploy: its singleton addresses are `null` in the manifest and stay placeholders until launch, at which point they populate automatically.

See [AI agents](/docs/offchain/ai-agents) for task-oriented recipes using these surfaces.
