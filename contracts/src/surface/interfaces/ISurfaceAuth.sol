// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

/// @title ISurfaceAuth
/// @notice Subset of a collection that companion contracts check before
///         allowing a write: the owner, plus any admin the owner granted. The
///         same authority that gates the collection's own setters gates its
///         companions.
interface ISurfaceAuth {
    function owner() external view returns (address);
    function isAdmin(address account) external view returns (bool);
}
