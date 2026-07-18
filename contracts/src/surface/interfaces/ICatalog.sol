// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

/// @title ICatalog
/// @notice Subset of the Catalog singleton a collection reads to confirm
///         creators. Catalog is a per-artist registry of contracts; a creator
///         registers a collection there via addContract, and the collection
///         reads that registration here. This is the creator side of two-sided
///         attribution.
interface ICatalog {
    /// @notice Whether `artist` has registered `contractAddress` in their catalog.
    function isContractRegistered(address artist, address contractAddress)
        external
        view
        returns (bool);
}
