// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

/// @dev The slice of a collection's surface the registry needs for
///      authorization: the same owner-or-admin root every collection setter
///      uses, borrowed here so render-asset writes carry exactly the same
///      authority as the collection's own management functions.
interface ICollectionAuth {
    function owner() external view returns (address);
    function isAdmin(address account) external view returns (bool);
}

/// @title RenderAssets
/// @notice Static display assets for collections — the shared cover image and
///         per-token captures (thumbnails of rendered output) — stored in
///         renderer-land, keyed by collection. One immutable, ownerless
///         singleton serves every collection; writes are gated by each
///         collection's own owner/admin authority.
///
///         This registry exists so the collection core stores NO presentation
///         data: the core's tokenURI defers wholly to its renderer, and the
///         bundled renderers read their static assets here. Captures are
///         deliberately always refreshable — they are convenience mirrors of
///         the rendered output for surfaces that cannot run it, not part of
///         the art. The art's permanence is the renderer pointer lock on the
///         collection plus whatever immutability the renderer itself offers
///         (e.g. GenerativeRenderer's per-collection work lock).
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
        if (
            msg.sender != ICollectionAuth(collection).owner()
                && !ICollectionAuth(collection).isAdmin(msg.sender)
        ) revert NotCollectionAdmin();
        _;
    }

    function setCover(address collection, string calldata uri)
        external
        onlyCollectionAdmin(collection)
    {
        coverOf[collection] = uri;
        emit CoverSet(collection, uri);
    }

    /// @notice Set per-token captures; a single token is a batch of one.
    ///         Always available — captures mirror already-rendered output, so
    ///         refreshing one can never change the art. To nudge marketplaces
    ///         to re-fetch, the caller follows up with the collection's
    ///         ERC-4906 `notifyMetadataUpdate` (owner/admin may call it).
    function setCaptures(address collection, uint256[] calldata tokenIds, string[] calldata uris)
        external
        onlyCollectionAdmin(collection)
    {
        if (!(tokenIds.length == uris.length)) revert LengthMismatch();
        for (uint256 i = 0; i < tokenIds.length; i++) {
            _captures[collection][tokenIds[i]] = uris[i];
            emit CaptureSet(collection, tokenIds[i], uris[i]);
        }
    }

    /// @notice The token's capture if one exists, else the collection cover,
    ///         else "".
    function imageFor(address collection, uint256 tokenId)
        external
        view
        returns (string memory)
    {
        string memory capture = _captures[collection][tokenId];
        if (bytes(capture).length > 0) return capture;
        return coverOf[collection];
    }

    function captureOf(address collection, uint256 tokenId)
        external
        view
        returns (string memory)
    {
        return _captures[collection][tokenId];
    }
}
