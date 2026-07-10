---
title: Overview
description: What the PND Collection System is, its parts, and how this reference is organized.
---

# Overview

The PND Collection System is a modular collection protocol for artists. One
artist collection is one contract, `Collection`: a single OZ ERC721
core that holds ownership, money paths, and provenance, and nothing else.
Every collection is deployed by a shared factory as an immutable EIP-1167
clone, so what deploys is what runs, forever. There is no proxy admin, no
upgrade path, and no seal.

All variability lives outside the core, in four swappable slots and optional
per-work companion contracts. An edition, a long-form generative drop, an
onchain SVG work, and a live-reading backed work are the same contract with
different modules plugged into the same four sockets. See
[The four slots](/docs/collections/concepts/four-slots) for the detail.

## The parts

**Shared singletons** (deployed once, used by every collection):

| Contract | Role |
| --- | --- |
| `CollectionFactory` | Clones the `Collection` implementation and wires init params in one transaction |
| `Attribution` | The works-to-artists half of attribution: a collection declares its roster; each artist confirms by claiming the collection in their own Catalog |
| `DefaultRenderer` | The default `IRenderer` a freshly deployed collection points at until the artist sets something else |
| `GenerativeRenderer` | Assembles a full HTML page from a collection's work config and seed via scripty, for algorithm-driven (Art Blocks-style) works |

**Per-artist clone** (deployed once per collection, owned by the artist):

`Collection` itself. It holds the ERC721 token logic, the sale
paths, the payment split, and every read an indexer or renderer needs:
`tokenSeed`, `config`. Nothing about a specific
work's rendering, pricing, or gating logic lives here; those are the slots.

## The four slots

Every collection has four independently swappable modules, set at init and
changeable later by the artist except where noted:

- **Renderer** (`IRenderer`): builds `tokenURI`; falls back to the
  collection's `defaultRenderer` when unset
- **Price strategy** (`IPriceStrategy`): a view-only pricing module; falls
  back to the collection's stored fixed price when unset
- **Mint hook** (`IMintHook`): runs `beforeMint`/`afterMint` on every mint
  path, built-in and extension; non-payable, so it can gate or record but
  never touch funds
- **Extension minter**: an address the artist authorizes via `setMinter`
  to call `mintTo`/`mintToId`; all value handling for that mint path lives
  in the minter, not the core

Full detail: [The four slots](/docs/collections/concepts/four-slots).

## Provenance and identity

Every mint stamps exactly one piece of per-token state: the token's
**entropy** (`tokenSeed`), a `bytes32` stable across transfers — the seed a
generative renderer draws from, and the one fact that can never be
reconstructed later. The rest of a token's **Mint Mark** is derived or
event-recorded: in Sequential mode the token id IS the mint order (with
first/final derived against the live status and minted count), and every
`Minted` event permanently records the order, the `referrer` that hosted the
mint, and the lifecycle status at that moment. The core stores nothing
derivable; works needing more mint-time data record it themselves via a
mint hook. See
[Mint Marks and entropy](/docs/collections/concepts/mint-marks-and-entropy).

## Live settings and the three locks

Every sale term is a live setting the artist (or an admin they grant) can
change: the mint window (`setMintWindow`), the fixed price (`setPrice`), the
EIP-2981 royalty (`setRoyalty`), and the supply cap (`setSupplyCap`).
Lifecycle status — `Scheduled`, `Open`, or `Closed` — is derived from the
window, the cap, and the clock; nothing stores it, so it can never drift
from the settings that produce it.

Against that flexibility stand one-way locks, each converting a setting
into a permanent promise. On the collection: `lockRenderer` (optional; the
renderer pointer can never change) and `lockSupply` (the supply can never
grow — and the cap binds extension minters too, so it holds no matter what
is granted later). In renderer-land: the GenerativeRenderer's
`lockWork(collection)` pins the algorithm, so pointer lock + work lock is
full presentation permanence for a generative work. The core stores no
presentation data — work configs and static images live in the renderer's
registry and [RenderAssets](/docs/collections/contracts/render-assets).

## Id modes

A collection is either **sequential** (the core assigns ids, built-in `mint`
is available, ids are never reused) or **pooled** (an extension minter
supplies every id, a burned id can be re-minted as a new instance). Fixed at
init, not changeable after. See [Id modes](/docs/collections/concepts/id-modes).

## Honest pricing and the referral share

A collector on the built-in path pays exactly the resolved price: the
stored fixed price, or whatever the price strategy quotes. Out of that
price, a fixed 10% (`REFERRAL_SHARE_BPS`) goes to whoever hosts the mint,
the **referrer**. Minting directly against the contract, or through a
self-hosted page passing the artist's own address as the referrer, folds
that share back to the artist. There is no other protocol fee anywhere in
the core.

## Status

The Collection System is pre-deploy. Contract and interface behavior in
this reference reflects the code as written; the shared-singleton addresses
below are placeholders until launch.

## Where to go next

- [Conventions](/docs/introduction/conventions): how to read the rest of
  this reference: address links, cast/viem examples, glossary
- [The four slots](/docs/collections/concepts/four-slots), [Id modes](/docs/collections/concepts/id-modes),
  [Mint Marks and entropy](/docs/collections/concepts/mint-marks-and-entropy),
  [Types](/docs/collections/concepts/types): the concept pages
- [Collection](/docs/collections/contracts/collection),
  [CollectionFactory](/docs/collections/contracts/factory): the core contract
  reference, generated from the ABI
- [Deploy a collection](/docs/collections/guides/deploy-a-collection),
  [Mint](/docs/collections/guides/mint): task-oriented guides
