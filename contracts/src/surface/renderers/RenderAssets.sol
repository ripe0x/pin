// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {LibString} from "solady/utils/LibString.sol";

import {ISurfaceAuth} from "../interfaces/ISurfaceAuth.sol";

/// @title RenderAssets
/// @notice Static display assets, stored outside the collection core: the
///         shared cover image, per-token captures (stills of rendered output
///         for surfaces that cannot execute the renderer), and a per-collection
///         capture template. Immutable, ownerless singleton shared by every
///         collection. Writes require the collection's own owner-or-admin
///         authority, except capture and template writes, which an admin may
///         delegate to a separate capturer role.
///
///         Captures are always refreshable. They are stills of the rendered
///         output, not the token's canonical image; the canonical image is
///         fixed by the collection's renderer lock plus whatever immutability
///         the renderer provides. Because a capture never affects the
///         canonical image, the capturer role is low-risk: an incorrect
///         capture is corrected by the next write.
contract RenderAssets {
    using LibString for uint256;

    /// @dev Placeholder substring in a capture template, replaced by the token
    ///      id, e.g. "ar://<manifest>/{id}.png".
    string internal constant ID_PLACEHOLDER = "{id}";

    /// @notice Shared/cover image URI per collection ("" = none set).
    mapping(address => string) public coverOf;

    /// @notice Capture URI template per collection ("" = none). Each "{id}" in
    ///         it resolves to the token id, so a single write covers every
    ///         token up to `templateMaxTokenIdOf`.
    mapping(address => string) public templateOf;

    /// @notice Highest token id the collection's template covers. Ids above
    ///         this fall back to the cover.
    mapping(address => uint256) public templateMaxTokenIdOf;

    /// @notice Per-token capture URI ("" = none; fall back to the template,
    ///         then the cover).
    mapping(address => mapping(uint256 => string)) private _captures;

    /// @notice Admin-granted accounts that may write captures and the template
    ///         for a collection, and nothing else. Allows delegating capture
    ///         writes to a low-privilege hot wallet or a mint surface without
    ///         an admin grant that could reroute funds.
    mapping(address => mapping(address => bool)) public isCapturer;

    error NotSurfaceAdmin();
    error NotCaptureAuthorized();
    error LengthMismatch();

    event CoverSet(address indexed collection, string uri);
    event CaptureSet(address indexed collection, uint256 indexed tokenId, string uri);
    event CaptureTemplateSet(address indexed collection, string template, uint256 maxTokenId);
    event CapturerSet(address indexed collection, address indexed account, bool allowed);

    /// @dev Same authority root as the collection's own setters: owner or admin.
    modifier onlySurfaceAdmin(address collection) {
        if (msg.sender != ISurfaceAuth(collection).owner() && !ISurfaceAuth(collection).isAdmin(msg.sender)) {
            revert NotSurfaceAdmin();
        }
        _;
    }

    /// @dev The admin set plus the collection's granted capturers. Gates only
    ///      the two capture writes; the cover and the capturer roster remain
    ///      admin-only.
    modifier onlyCaptureAuthorized(address collection) {
        if (
            !isCapturer[collection][msg.sender] && msg.sender != ISurfaceAuth(collection).owner()
                && !ISurfaceAuth(collection).isAdmin(msg.sender)
        ) {
            revert NotCaptureAuthorized();
        }
        _;
    }

    function setCover(address collection, string calldata uri) external onlySurfaceAdmin(collection) {
        coverOf[collection] = uri;
        emit CoverSet(collection, uri);
    }

    /// @notice Grant or revoke a capturer for `collection`. Owner-or-admin
    ///         only; a capturer cannot change the capturer roster.
    function setCapturer(address collection, address account, bool allowed)
        external
        onlySurfaceAdmin(collection)
    {
        isCapturer[collection][account] = allowed;
        emit CapturerSet(collection, account, allowed);
    }

    /// @notice Set the capture template and its coverage bound ("" clears
    ///         both). The template applies to token ids up to and including
    ///         `maxTokenId`; higher ids resolve to the cover. To prompt
    ///         marketplaces to re-fetch, follow with the collection's
    ///         ERC-4906 `notifyMetadataUpdate`.
    function setCaptureTemplate(address collection, string calldata template, uint256 maxTokenId)
        external
        onlyCaptureAuthorized(collection)
    {
        uint256 bound = bytes(template).length > 0 ? maxTokenId : 0;
        templateOf[collection] = template;
        templateMaxTokenIdOf[collection] = bound;
        emit CaptureTemplateSet(collection, template, bound);
    }

    /// @notice Set per-token captures; a single token is a batch of one.
    ///         A capture write never changes the canonical image, so this stays
    ///         open indefinitely. To prompt marketplaces to re-fetch, follow
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

    /// @notice Resolution order: the token's explicit capture if set, else the
    ///         template resolved for this id when the id is within
    ///         `templateMaxTokenIdOf`, else the collection cover, else "".
    function imageFor(address collection, uint256 tokenId) external view returns (string memory) {
        string memory capture = _captures[collection][tokenId];
        if (bytes(capture).length > 0) return capture;
        string memory template = templateOf[collection];
        if (bytes(template).length > 0 && tokenId <= templateMaxTokenIdOf[collection]) {
            return LibString.replace(template, ID_PLACEHOLDER, tokenId.toString());
        }
        return coverOf[collection];
    }
}
