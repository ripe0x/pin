// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {LibString} from "solady/utils/LibString.sol";

import {ICollectionAuth} from "../interfaces/ICollectionAuth.sol";

/// @title RenderAssets
/// @notice Static display assets, kept out of the collection core: the shared
///         cover image, per-token captures (stills of rendered output for
///         surfaces that cannot run it), and a per-collection capture
///         template. One immutable, ownerless singleton serves every
///         collection; writes need the same key as the collection's own
///         setters — except captures, which an admin may delegate to a
///         narrow capturer key.
///
///         Captures are deliberately always refreshable. They mirror the art;
///         they are not the art. The art's permanence is the collection's
///         renderer lock plus whatever immutability the renderer itself
///         offers. That is also why the capturer role is safe to hand out:
///         the worst a bad capturer can do is point at a wrong thumbnail,
///         and the next write fixes it.
contract RenderAssets {
    using LibString for uint256;

    /// @dev The placeholder a capture template carries where the token id
    ///      belongs, e.g. "ar://<manifest>/{id}.png".
    string internal constant ID_PLACEHOLDER = "{id}";

    /// @notice Shared/cover image URI per collection ("" = none set).
    mapping(address => string) public coverOf;

    /// @notice Capture URI template per collection ("" = none). Every "{id}"
    ///         in it resolves to the token id, so one small write covers a
    ///         whole drop's thumbnails at once.
    mapping(address => string) public templateOf;

    /// @notice Per-token capture URI ("" = none; fall back to the template,
    ///         then the cover).
    mapping(address => mapping(uint256 => string)) private _captures;

    /// @notice Narrow, admin-granted keys that may write captures and the
    ///         template for a collection — and nothing else. Lets an artist
    ///         run thumbnail automation on a low-privilege hot key, or
    ///         delegate capture-writing to a mint surface, without handing
    ///         over an admin key that could reroute money.
    mapping(address => mapping(address => bool)) public isCapturer;

    error NotCollectionAdmin();
    error NotCaptureAuthorized();
    error LengthMismatch();

    event CoverSet(address indexed collection, string uri);
    event CaptureSet(address indexed collection, uint256 indexed tokenId, string uri);
    event CaptureTemplateSet(address indexed collection, string template);
    event CapturerSet(address indexed collection, address indexed account, bool allowed);

    /// @dev Same authority root as the collection's own setters.
    modifier onlyCollectionAdmin(address collection) {
        if (msg.sender != ICollectionAuth(collection).owner() && !ICollectionAuth(collection).isAdmin(msg.sender)) {
            revert NotCollectionAdmin();
        }
        _;
    }

    /// @dev The admin set, widened by the collection's granted capturers.
    ///      Gates only the two capture writes; the cover and the capturer
    ///      roster stay with the admins.
    modifier onlyCaptureAuthorized(address collection) {
        if (
            !isCapturer[collection][msg.sender] && msg.sender != ICollectionAuth(collection).owner()
                && !ICollectionAuth(collection).isAdmin(msg.sender)
        ) {
            revert NotCaptureAuthorized();
        }
        _;
    }

    function setCover(address collection, string calldata uri) external onlyCollectionAdmin(collection) {
        coverOf[collection] = uri;
        emit CoverSet(collection, uri);
    }

    /// @notice Grant or revoke a capturer for `collection` (admin key
    ///         required; the grant itself is never capturer-writable).
    function setCapturer(address collection, address account, bool allowed)
        external
        onlyCollectionAdmin(collection)
    {
        isCapturer[collection][account] = allowed;
        emit CapturerSet(collection, account, allowed);
    }

    /// @notice Set the capture template ("" clears it). One write refreshes
    ///         every token that has no explicit capture — publish a new
    ///         manifest of frames, point the template at it, done. To nudge
    ///         marketplaces to re-fetch, follow up with the collection's
    ///         ERC-4906 `notifyMetadataUpdate`.
    function setCaptureTemplate(address collection, string calldata template)
        external
        onlyCaptureAuthorized(collection)
    {
        templateOf[collection] = template;
        emit CaptureTemplateSet(collection, template);
    }

    /// @notice Set per-token captures; a single token is a batch of one.
    ///         Refreshing a capture can never change the art, so this stays
    ///         open forever. To nudge marketplaces to re-fetch, follow up
    ///         with the collection's ERC-4906 `notifyMetadataUpdate`.
    function setCaptures(address collection, uint256[] calldata tokenIds, string[] calldata uris)
        external
        onlyCaptureAuthorized(collection)
    {
        if (tokenIds.length != uris.length) revert LengthMismatch();
        for (uint256 i = 0; i < tokenIds.length; i++) {
            _captures[collection][tokenIds[i]] = uris[i];
            emit CaptureSet(collection, tokenIds[i], uris[i]);
        }
    }

    /// @notice The token's capture if one exists, else the template resolved
    ///         for this id, else the collection cover, else "".
    function imageFor(address collection, uint256 tokenId) external view returns (string memory) {
        string memory capture = _captures[collection][tokenId];
        if (bytes(capture).length > 0) return capture;
        string memory template = templateOf[collection];
        if (bytes(template).length > 0) {
            return LibString.replace(template, ID_PLACEHOLDER, tokenId.toString());
        }
        return coverOf[collection];
    }
}
