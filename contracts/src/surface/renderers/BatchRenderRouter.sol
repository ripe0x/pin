// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Ownable} from "solady/auth/Ownable.sol";

import {IRenderer} from "../interfaces/IRenderer.sol";
import {IBatchRenderRouter} from "../interfaces/IBatchRenderRouter.sol";
import {ISurfaceCore} from "../interfaces/ISurfaceCore.sol";

/// @title BatchRenderRouter
/// @notice Reference IRenderer that dispatches tokenURI by token id range: an
///         ordered list of batches, each a [startId, endId] range assigned to
///         one renderer renderer. Set as a collection's `cfg.renderer`, so every
///         token's tokenURI resolves through the batch that contains its id.
///
///         PND authors and reviews this contract; each artist deploys their
///         own instance and owns it. Renderer renderers stay the artist's own
///         code.
///
/// @dev    Authority for addBatch/bindCollection is Ownable (the deploying
///         EOA), not borrowed from the collection's owner/isAdmin the way
///         RenderAssets and FixedPriceMinter borrow it. Those companions bind
///         to a collection that already exists at their own deploy time. This
///         router does not: the artist deploys the router and adds its first
///         batch before calling createSurface, so there is no collection yet
///         to borrow authority from (see docs/pnd-surface-second-launch.md,
///         "Launch sequence"). Ownable also matches how the artist already
///         signs every other step, with no separate authority to keep in
///         sync.
///
///         `collection` is unknown at construction for the same reason: it is
///         bound once, after createSurface returns an address, via
///         bindCollection(). Until it is bound, requestRefresh reverts
///         CollectionNotSet; tokenURI/contractURI do not depend on it (they
///         take the collection as a parameter, per IRenderer).
contract BatchRenderRouter is IBatchRenderRouter, Ownable {
    bytes4 internal constant INTERFACE_ID_ERC165 = 0x01ffc9a7;

    /// @notice The collection this router serves refresh relays for. Bound
    ///         once via bindCollection(); 0 until then.
    address public collection;

    Batch[] internal _batches;

    constructor() {
        _initializeOwner(msg.sender);
    }

    /// @dev Prevents _initializeOwner from being callable a second time.
    function _guardInitializeOwner() internal pure override returns (bool) {
        return true;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Collection binding
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Bind the collection this router relays refreshes for. One-way:
    ///         reverts CollectionAlreadySet on a second call. Called after
    ///         createSurface, once the collection address exists.
    function bindCollection(address collection_) external onlyOwner {
        if (collection != address(0)) revert CollectionAlreadySet();
        if (collection_ == address(0)) revert ZeroCollection();
        collection = collection_;
        emit CollectionSet(collection_);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Batches
    // ─────────────────────────────────────────────────────────────────────

    /// @inheritdoc IBatchRenderRouter
    function addBatch(uint256 startId, uint256 endId, address renderer, string calldata label) external onlyOwner {
        if (renderer == address(0)) revert ZeroRenderer();
        if (startId > endId) revert InvalidRange(startId, endId);
        uint256 len = _batches.length;
        for (uint256 i = 0; i < len; i++) {
            Batch storage existing = _batches[i];
            if (startId <= existing.endId && existing.startId <= endId) {
                revert OverlappingRange(startId, endId, i);
            }
        }
        _batches.push(Batch({startId: startId, endId: endId, renderer: renderer, label: label}));
        emit BatchAdded(len, startId, endId, renderer, label);
    }

    /// @inheritdoc IBatchRenderRouter
    function batchCount() external view returns (uint256) {
        return _batches.length;
    }

    /// @inheritdoc IBatchRenderRouter
    function batchAt(uint256 index) public view returns (Batch memory) {
        if (index >= _batches.length) revert IndexOutOfBounds(index);
        return _batches[index];
    }

    /// @inheritdoc IBatchRenderRouter
    function batchOf(uint256 tokenId) public view returns (Batch memory) {
        uint256 len = _batches.length;
        for (uint256 i = 0; i < len; i++) {
            Batch storage b = _batches[i];
            if (tokenId >= b.startId && tokenId <= b.endId) return b;
        }
        revert NoBatchForToken(tokenId);
    }

    // ─────────────────────────────────────────────────────────────────────
    // IRenderer
    // ─────────────────────────────────────────────────────────────────────

    /// @inheritdoc IRenderer
    function tokenURI(address collection_, uint256 tokenId) external view override returns (string memory) {
        address renderer = batchOf(tokenId).renderer;
        return IRenderer(renderer).tokenURI(collection_, tokenId);
    }

    /// @dev No per-collection contract-level data is stored here; delegates
    ///      to the first batch's renderer when one exists, so a marketplace
    ///      collection page still resolves to real metadata. Reverts
    ///      NoBatchForToken(0) when no batch has been added yet.
    function contractURI(address collection_) external view override returns (string memory) {
        if (_batches.length == 0) revert NoBatchForToken(0);
        return IRenderer(_batches[0].renderer).contractURI(collection_);
    }

    // ─────────────────────────────────────────────────────────────────────
    // ERC-4906 relay
    // ─────────────────────────────────────────────────────────────────────

    /// @inheritdoc IBatchRenderRouter
    /// @dev SurfaceCore.notifyMetadataUpdate only accepts calls from its own
    ///      renderer(), owner(), or an admin. Once this router is the
    ///      collection's renderer, a batch renderer is none of those, so a
    ///      renderer's own holder-triggered refresh cannot reach the core
    ///      directly. This relay forwards it on the renderer's behalf, gated on
    ///      the caller being a currently assigned renderer on some batch.
    function requestRefresh(uint256 tokenId) external {
        if (collection == address(0)) revert CollectionNotSet();
        if (!_isRegisteredRenderer(msg.sender)) revert NotAuthorized();
        ISurfaceCore(collection).notifyMetadataUpdate(tokenId, tokenId);
        emit RefreshRequested(msg.sender, tokenId);
    }

    function _isRegisteredRenderer(address account) internal view returns (bool) {
        uint256 len = _batches.length;
        for (uint256 i = 0; i < len; i++) {
            if (_batches[i].renderer == account) return true;
        }
        return false;
    }

    // ─────────────────────────────────────────────────────────────────────
    // ERC-165
    // ─────────────────────────────────────────────────────────────────────

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IBatchRenderRouter).interfaceId || interfaceId == type(IRenderer).interfaceId
            || interfaceId == INTERFACE_ID_ERC165;
    }
}
