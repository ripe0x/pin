// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {ICollectionAuth} from "../interfaces/ICollectionAuth.sol";

/// @title RenderAssets
/// @notice Static display assets, kept out of the collection core: the shared
///         cover image and per-token captures (stills of rendered output for
///         surfaces that cannot run it). One immutable, ownerless singleton
///         serves every collection; writes need the same key as the
///         collection's own setters.
///
///         Captures are deliberately always refreshable. They mirror the art;
///         they are not the art. The art's permanence is the collection's
///         renderer lock plus whatever immutability the renderer itself
///         offers.
contract RenderAssets {
    /// @notice Shared/cover image URI per collection ("" = none set).
    mapping(address => string) public coverOf;

    /// @notice Per-token capture URI ("" = none; fall back to the cover).
    mapping(address => mapping(uint256 => string)) private _captures;

    error NotCollectionAdmin();
    error LengthMismatch();

    event CoverSet(address indexed collection, string uri);
    event CaptureSet(address indexed collection, uint256 indexed tokenId, string uri);

    /// @dev Same authority root as the collection's own setters.
    modifier onlyCollectionAdmin(address collection) {
        if (msg.sender != ICollectionAuth(collection).owner() && !ICollectionAuth(collection).isAdmin(msg.sender)) {
            revert NotCollectionAdmin();
        }
        _;
    }

    function setCover(address collection, string calldata uri) external onlyCollectionAdmin(collection) {
        coverOf[collection] = uri;
        emit CoverSet(collection, uri);
    }

    /// @notice Set per-token captures; a single token is a batch of one.
    ///         Refreshing a capture can never change the art, so this stays
    ///         open forever. To nudge marketplaces to re-fetch, follow up
    ///         with the collection's ERC-4906 `notifyMetadataUpdate`.
    function setCaptures(address collection, uint256[] calldata tokenIds, string[] calldata uris)
        external
        onlyCollectionAdmin(collection)
    {
        if (tokenIds.length != uris.length) revert LengthMismatch();
        for (uint256 i = 0; i < tokenIds.length; i++) {
            _captures[collection][tokenIds[i]] = uris[i];
            emit CaptureSet(collection, tokenIds[i], uris[i]);
        }
    }

    /// @notice The token's capture if one exists, else the collection cover,
    ///         else "".
    function imageFor(address collection, uint256 tokenId) external view returns (string memory) {
        string memory capture = _captures[collection][tokenId];
        if (bytes(capture).length > 0) return capture;
        return coverOf[collection];
    }

    function captureOf(address collection, uint256 tokenId) external view returns (string memory) {
        return _captures[collection][tokenId];
    }
}
