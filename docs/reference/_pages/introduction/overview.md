---
title: Overview
description: The onchain protocols PND ships for artists, and how this reference is organized.
---

# Overview

This is the API reference for the onchain protocols PND ships for artists. Each
protocol is a self-contained set of contracts with its own section below: an
overview, the concepts behind it, a per-contract reference, task-oriented
guides, and cross-cutting indexes of its functions, events, and errors.

The contracts are deployed once with no proxy admin and no upgrade path. Where a
protocol is deployed per artist (a collection, an auction house), each instance
is an immutable EIP-1167 clone from a shared factory, so what deploys is what
runs. Prices and fees are the values the contract holds; there is no separate
protocol charge beyond what each contract's reference documents.

## The protocols

- [Surface](/docs/surface/overview): artist-owned ERC721 collections
  built on a thin token core where every mint goes through an authorized minter,
  with a renderer slot, per-token entropy, and one-way locks over the renderer
  pointer, the supply, and the minter set. Sale economics live in the minter;
  presentation data lives in the renderer. Editions, generative drops, onchain
  SVG works, and backed or redeemable works are all the same core with different
  minters and renderers attached
- [Auctions](/docs/auctions/overview): a per-owner onchain English-auction
  house for any ERC721, including a collection token. Reserve pricing, an
  anti-snipe time-buffer extension, pull-payment refunds, and a protocol fee
- [Catalog](/docs/catalog/overview): a general onchain artist registry, live on
  Ethereum mainnet. An address publishes pointers to its work (a contract, a
  token, or a token-id range); the Surface System reads it for the creator half
  of collection attribution

## Status

Auctions and Catalog are live on Ethereum mainnet; their addresses are in
[Addresses](/docs/introduction/addresses) and the
[protocol manifest](/protocol-manifest.json). The Surface System is pre-deploy,
so its singleton addresses are placeholders until launch.
