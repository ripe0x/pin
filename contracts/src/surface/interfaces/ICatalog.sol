// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

/// @title ICatalog
/// @notice The slice of the Catalog singleton a collection reads to confirm
///         creators. Catalog is the artist's own public record ("my works"),
///         keyed by artist; a creator claims a collection there with
///         addContract, and the collection checks that claim here, the
///         artist's side of the two-sided attribution handshake.
interface ICatalog {
    /// @notice Whether `artist` has registered `contractAddress` in their catalog.
    function isContractRegistered(address artist, address contractAddress)
        external
        view
        returns (bool);
}
