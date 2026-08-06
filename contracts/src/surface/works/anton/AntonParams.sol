// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {IERC721} from "openzeppelin-contracts/contracts/token/ERC721/IERC721.sol";

/// @dev Minimal read of a Surface collection's minter authorization.
interface ISurfaceMinters {
    function isMinter(address minter) external view returns (bool);
}

/// @title AntonParams
/// @notice Per-token render params (palette, shape, tone, bgOnly) for the anton
///         work, stored outside the collection core. The core stores only the
///         seed; this work's image is a function of these params instead, so
///         they need a home the token owner can write. Ownerless singleton
///         keyed by collection, one entry per token.
///
///         Two write paths. `initParams` is the mint-time write: an authorized
///         minter of the collection records the minter's chosen params, once,
///         while the token is fresh. `setParams` is the owner write: the
///         current token owner re-picks params at any time, overwriting the
///         entry. Values are stored as validated indices into the work's fixed
///         vocabularies (bounded by the constructor counts), so a stored entry
///         is always renderable.
///
///         A param change alters the token's image. To prompt marketplaces to
///         re-fetch, the caller follows a write with the collection's ERC-4906
///         `notifyMetadataUpdate(tokenId, tokenId)`; this registry stays
///         decoupled from that event.
contract AntonParams {
    /// @notice One token's render params. `set` distinguishes a written entry
    ///         from the zero default so a renderer can fall back cleanly.
    struct TokenParams {
        bool set;
        uint8 palette; // index into the work's palette list
        uint8 shape; // index into the work's shape-preset list
        uint8 tone; // 0 = first tone, 1 = second tone
        bool bgOnly;
    }

    /// @notice Count of palette options. A palette index must be < this.
    uint8 public immutable paletteCount;

    /// @notice Count of shape presets. A shape index must be < this.
    uint8 public immutable shapeCount;

    /// @notice Count of tone options (sun/moon = 2). A tone index must be < this.
    uint8 public immutable toneCount;

    /// @notice params[collection][tokenId].
    mapping(address => mapping(uint256 => TokenParams)) private _params;

    error PaletteOutOfRange(uint8 palette, uint8 count);
    error ShapeOutOfRange(uint8 shape, uint8 count);
    error ToneOutOfRange(uint8 tone, uint8 count);
    error NotTokenOwner(address caller, address owner);
    error NotMinter(address caller);
    error AlreadyInitialized(address collection, uint256 tokenId);

    event ParamsSet(
        address indexed collection,
        uint256 indexed tokenId,
        uint8 palette,
        uint8 shape,
        uint8 tone,
        bool bgOnly
    );

    constructor(uint8 paletteCount_, uint8 shapeCount_, uint8 toneCount_) {
        paletteCount = paletteCount_;
        shapeCount = shapeCount_;
        toneCount = toneCount_;
    }

    /// @notice Mint-time write by an authorized minter of `collection`, once per
    ///         token. Reverts if the token already has an entry, so a later
    ///         minter grant cannot overwrite a live token's params; the owner
    ///         path is the only way to change them after this.
    function initParams(
        address collection,
        uint256 tokenId,
        uint8 palette,
        uint8 shape,
        uint8 tone,
        bool bgOnly
    ) external {
        if (!ISurfaceMinters(collection).isMinter(msg.sender)) revert NotMinter(msg.sender);
        if (_params[collection][tokenId].set) revert AlreadyInitialized(collection, tokenId);
        _write(collection, tokenId, palette, shape, tone, bgOnly);
    }

    /// @notice Owner write. The current owner of `tokenId` re-picks params,
    ///         overwriting any existing entry.
    function setParams(
        address collection,
        uint256 tokenId,
        uint8 palette,
        uint8 shape,
        uint8 tone,
        bool bgOnly
    ) external {
        address owner = IERC721(collection).ownerOf(tokenId);
        if (msg.sender != owner) revert NotTokenOwner(msg.sender, owner);
        _write(collection, tokenId, palette, shape, tone, bgOnly);
    }

    function _write(address collection, uint256 tokenId, uint8 palette, uint8 shape, uint8 tone, bool bgOnly)
        private
    {
        if (palette >= paletteCount) revert PaletteOutOfRange(palette, paletteCount);
        if (shape >= shapeCount) revert ShapeOutOfRange(shape, shapeCount);
        if (tone >= toneCount) revert ToneOutOfRange(tone, toneCount);
        _params[collection][tokenId] =
            TokenParams({set: true, palette: palette, shape: shape, tone: tone, bgOnly: bgOnly});
        emit ParamsSet(collection, tokenId, palette, shape, tone, bgOnly);
    }

    /// @notice Read a token's params. `set` is false when none were written.
    function paramsOf(address collection, uint256 tokenId)
        external
        view
        returns (bool set, uint8 palette, uint8 shape, uint8 tone, bool bgOnly)
    {
        TokenParams storage p = _params[collection][tokenId];
        return (p.set, p.palette, p.shape, p.tone, p.bgOnly);
    }
}
