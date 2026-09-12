// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {ISurfaceV2} from "../../../../src/surface/v2/interfaces/ISurfaceV2.sol";
import {ISeedSourceV2} from "../../../../src/surface/v2/interfaces/ISeedSourceV2.sol";
import {ICatalog} from "../../../../src/surface/interfaces/ICatalog.sol";

/// @dev Extension minter that calls mintTo/mintToSeeded/burn on a SurfaceV2
///      collection. Stands in for a real minter module (FixedPriceMinterV2 or
///      otherwise) in tests that need the call to arrive from a contract
///      address rather than an EOA.
contract MockMinterV2 {
    function callMintTo(ISurfaceV2 collection, address to, uint256 quantity)
        external
        returns (uint256 firstTokenId)
    {
        return collection.mintTo(to, quantity);
    }

    function callMintToSeeded(ISurfaceV2 collection, address to, bytes32[] calldata seeds)
        external
        returns (uint256 firstTokenId)
    {
        return collection.mintToSeeded(to, seeds);
    }

    function callBurn(ISurfaceV2 collection, uint256 tokenId) external {
        collection.burn(tokenId);
    }
}

/// @dev Settable, revertable ISeedSourceV2 implementation. A token with no
///      explicit seed set reads back bytes32(0), matching an unset mapping
///      slot; setRevertFor / setRevertAll make seedOf revert to exercise the
///      collection's propagate-the-revert behavior (e.g. a reveal-based
///      source queried before its epoch resolves).
contract MockSeedSourceV2 is ISeedSourceV2 {
    error SeedNotReady();

    mapping(address => mapping(uint256 => bytes32)) internal _seeds;
    mapping(address => mapping(uint256 => bool)) internal _revertFor;
    bool public revertAll;

    function setSeed(address collection, uint256 tokenId, bytes32 seed) external {
        _seeds[collection][tokenId] = seed;
    }

    function setRevertFor(address collection, uint256 tokenId, bool shouldRevert) external {
        _revertFor[collection][tokenId] = shouldRevert;
    }

    function setRevertAll(bool shouldRevert) external {
        revertAll = shouldRevert;
    }

    function seedOf(address collection, uint256 tokenId) external view override returns (bytes32) {
        if (revertAll || _revertFor[collection][tokenId]) revert SeedNotReady();
        return _seeds[collection][tokenId];
    }
}

/// @dev Minimal ICatalog stand-in: an artist/contract pair is registered or
///      not, set directly rather than through the real Catalog's pointer
///      bookkeeping. The real two-sided handshake against the actual Catalog
///      contract is covered in test/surface/CreatorAttribution.t.sol (v1);
///      this mock isolates SurfaceV2's read side of that handshake.
contract MockCatalogV2 is ICatalog {
    mapping(address => mapping(address => bool)) internal _registered;

    function setRegistered(address artist, address contractAddress, bool registered) external {
        _registered[artist][contractAddress] = registered;
    }

    function isContractRegistered(address artist, address contractAddress) external view override returns (bool) {
        return _registered[artist][contractAddress];
    }
}
