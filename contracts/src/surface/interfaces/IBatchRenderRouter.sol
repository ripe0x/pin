// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {IRenderer} from "./IRenderer.sol";

/// @title IBatchRenderRouter
/// @notice A renderer that dispatches tokenURI by token id range. A batch is
///         a contiguous [startId, endId] range assigned to one vendor
///         renderer; every token in the range shares that vendor's artwork.
///         Advertised via ERC-165 so a generic client can detect a
///         batch-backed collection from its renderer address alone.
interface IBatchRenderRouter is IRenderer {
    /// @notice One id range and the vendor renderer that serves it.
    /// @dev label is display-only, not consulted for dispatch or validation.
    struct Batch {
        uint256 startId;
        uint256 endId;
        address vendor;
        string label;
    }

    error ZeroVendor();
    error InvalidRange(uint256 startId, uint256 endId);
    error OverlappingRange(uint256 startId, uint256 endId, uint256 conflictingIndex);
    error NoBatchForToken(uint256 tokenId);
    error IndexOutOfBounds(uint256 index);
    error NotAuthorized();
    error CollectionAlreadySet();
    error CollectionNotSet();
    error ZeroCollection();

    event BatchAdded(uint256 indexed index, uint256 startId, uint256 endId, address indexed vendor, string label);
    event RefreshRequested(address indexed vendor, uint256 indexed tokenId);
    event CollectionSet(address indexed collection);

    /// @notice Append a new batch. Reverts on a zero vendor, startId > endId,
    ///         or a range overlapping any existing batch.
    function addBatch(uint256 startId, uint256 endId, address vendor, string calldata label) external;

    /// @notice Number of batches added so far.
    function batchCount() external view returns (uint256);

    /// @notice The batch at `index`, in add order. Reverts IndexOutOfBounds
    ///         past batchCount().
    function batchAt(uint256 index) external view returns (Batch memory);

    /// @notice The batch whose [startId, endId] range contains `tokenId`.
    ///         Reverts NoBatchForToken when no batch covers it.
    function batchOf(uint256 tokenId) external view returns (Batch memory);

    /// @notice Relay an ERC-4906 single-token refresh to the bound
    ///         collection, on behalf of a batch's vendor. Callable only by
    ///         an address currently assigned as a vendor on some batch.
    function requestRefresh(uint256 tokenId) external;
}
