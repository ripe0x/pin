// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

/// @title ICollectionAuth
/// @notice The slice of a collection that companion contracts check before
///         letting someone write: the owner, plus anyone the owner made an
///         admin. The same key that opens the collection's own setters opens
///         its companions.
interface ICollectionAuth {
    function owner() external view returns (address);
    function isAdmin(address account) external view returns (bool);
}
