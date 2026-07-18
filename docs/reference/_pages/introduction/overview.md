---
title: Overview
description: The onchain protocols PND ships for artists, and how this reference is organized.
---

# Overview

This is the API reference for the onchain protocols PND ships for artists. Each
protocol is a self-contained set of contracts with its own section below: an
overview, the concepts behind it, a per-contract reference, task-oriented
guides, and cross-cutting indexes of its functions, events, and errors.

Everything here is honest infrastructure. The contracts are deployed once and
run forever: no proxy admin, no upgrade path, no seal. Where a protocol is
deployed per artist (a collection, an auction house), each instance is an
immutable EIP-1167 clone from a shared factory, so what deploys is what runs.
Prices and fees are what the contract charges, nothing hidden.

## The protocols

- [Collections](/docs/collections/overview): artist-owned ERC721 collections
  built on one core with four swappable slots (renderer, price, mint hook,
  extension minter), per-token entropy, and one-way locks over the renderer
  pointer and the supply. Presentation data lives in renderer-land. Editions,
  generative drops, onchain SVG works, and backed or redeemable works are all
  the same core with different modules plugged into the same sockets
- [Auctions](/docs/auctions/overview): a per-owner onchain English-auction
  house for any ERC721, including a collection token. Reserve pricing, an
  anti-snipe time-buffer extension, pull-payment refunds, and a protocol fee

More protocols join this reference as they ship.

## How this reference is organized

- Each protocol section opens with an **Overview**, then **Concepts** (the model
  behind the contracts), **Contracts** (the per-contract API), **Guides**
  (how to do a thing), and **Reference** (generated access-control, error, and
  event indexes for that protocol)
- [Addresses](/docs/introduction/addresses) lists the shared singletons of every
  protocol on Ethereum mainnet
- [Conventions](/docs/introduction/conventions) covers how to read examples,
  addresses, and terms
- [Off-chain](/docs/offchain/abis-and-manifest) covers the machine-readable
  outputs: served ABIs, the protocol manifest, and the agent orientation file

## Status

The protocols are pre-deploy. Shared-singleton addresses land in
[Addresses](/docs/introduction/addresses) and the
[protocol manifest](/protocol-manifest.json) at launch; until then, examples use
placeholder addresses.
