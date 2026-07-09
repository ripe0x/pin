---
title: Overview
description: What the PND Collection System is, its parts, and how this reference is organized.
---

# Overview

The PND Collection System is a modular collection protocol for artists. One
artist collection is one contract, `SovereignCollection`: a single OZ ERC721
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
| `SovereignCollectionFactory` | Clones the `SovereignCollection` implementation and wires init params in one transaction |
| `Attribution` | The works-to-artists half of attribution: a collection declares its roster; each artist confirms by claiming the collection in their own Catalog |
| `DefaultRenderer` | The default `IRenderer` a freshly deployed collection points at until the artist sets something else |
| `GenerativeRenderer` | Assembles a full HTML page from a collection's work config and seed via scripty, for algorithm-driven (Art Blocks-style) works |

**Per-artist clone** (deployed once per collection, owned by the artist):

`SovereignCollection` itself. It holds the ERC721 token logic, the sale
paths, the payment split, and every read an indexer or renderer needs:
`tokenSeed`, `mintMarkOf`, `workConfig`, `config`. Nothing about a specific
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
  to call `mintTo`/`mintToAt`; all value handling for that mint path lives
  in the minter, not the core

Full detail: [The four slots](/docs/collections/concepts/four-slots).

## Provenance and identity

Every mint stamps two pieces of per-token state that never change after the
fact:

- **Mint Mark**: a snapshot of when and how a token was minted:
  `mintIndex`, `mintBlock`, the collection's `statusAtMint`, the `surface`
  that hosted the mint, plus derived `isFirst`/`isFinal` flags. Read via
  `mintMarkOf`
- **Entropy** (`tokenSeed`): a `bytes32` stamped at mint time, stable
  across transfers, the seed a generative renderer draws from

See [Mint Marks and entropy](/docs/collections/concepts/mint-marks-and-entropy).

A collection also carries two graph-shaped structures for relating tokens
and collections to each other: a directed **Release Graph** of typed edges
between collections, and a per-token **Token Path**, a forward pointer a
token can carry toward what comes next for it. See
[The Release Graph and Token Path](/docs/collections/concepts/collection-graph-and-token-path).

## Id modes

A collection is either **sequential** (the core assigns ids, built-in `mint`
is available, ids are never reused) or **pooled** (an extension minter
supplies every id, a burned id can be re-minted as a new instance). Fixed at
init, not changeable after. See [Id modes](/docs/collections/concepts/id-modes).

## Honest pricing and the surface share

A collector on the built-in path pays exactly the resolved price: the
stored fixed price, or whatever the price strategy quotes. Out of that
price, a fixed 10% (`SURFACE_SHARE_BPS`) goes to whoever hosts the mint,
the **surface**. Minting directly against the contract, or through a
self-hosted page passing the artist's own address as the surface, folds
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
  [The Release Graph and Token Path](/docs/collections/concepts/collection-graph-and-token-path),
  [Types](/docs/collections/concepts/types): the concept pages
- [SovereignCollection](/docs/collections/contracts/sovereign-collection),
  [SovereignCollectionFactory](/docs/collections/contracts/factory): the core contract
  reference, generated from the ABI
- [Deploy a collection](/docs/collections/guides/deploy-a-collection),
  [Mint](/docs/collections/guides/mint): task-oriented guides
