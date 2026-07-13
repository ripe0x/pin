---
title: MuriOperator
---

# summary

The small adapter that lets a Collection (or any ERC721 with an owner) plug
into the [MURI](https://muri.yigitduman.com) media-permanence protocol. MURI
asks each registered contract to name an **operator** contract that answers
collector-ownership checks and that is the only caller allowed to initialize
a token's MURI data. This is that operator: one immutable, ownerless
singleton any number of collections can register via MURI's
`registerContract(collection, operator)`.

Authority mirrors MURI's own registration rule: the contract's admins
(`isAdmin`, which counts the owner) or, for contracts without an admin
concept, the owner. Whoever could register the contract with MURI can
initialize its tokens here. Everything else — adding fallback URIs, updating
metadata, collector actions — is called on MURI directly and needs no
forwarding; this adapter holds only the two roles MURI insists an operator
holds. Proven end-to-end against live mainnet MURI by
`contracts/test/collection/MuriIntegrationFork.t.sol`.

## function muri

The MURI protocol singleton this adapter forwards to. Fixed in the
constructor.

## function initializeTokenData

access: the target contract's owner or admin (else `NotContractAdmin`)

Initializes a token's MURI data (metadata, fallback artwork URIs, thumbnail,
display mode, permission flags). MURI only accepts this call from the
contract's registered operator, so the adapter forwards it after checking the
caller against the target contract's own keys (`isAdmin(address)` when the
contract answers it, `owner()` otherwise — the same fallback ladder MURI uses
for registration).

## function isTokenOwner

MURI's collector check: true when `account` currently holds `tokenId` on
`creatorContract` (ERC721 `ownerOf`). A nonexistent token answers false
rather than reverting, so MURI's admin-or-owner fallthrough stays intact.

## function supportsInterface

True for exactly two ids: ERC-165 itself, and MURI's creator/operator
interface (`IMURIProtocolCreator`) — the id MURI probes at registration.

## error MuriRequired

The constructor was given the zero address, or an address with no code, as
the MURI protocol.

## error NotContractAdmin

`initializeTokenData` was called by an address that is neither an admin nor
the owner of the target contract.
