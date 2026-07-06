// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

/// @title IAttribution
/// @notice The works -> artists half of the bilateral attribution handshake
///         (Catalog.sol is the artists -> works half). A collection's owner
///         (or the collection itself, e.g. a factory during init) declares
///         the artist roster; each listed artist claims the collection in
///         their own Catalog; the intersection is confirmed attribution.
interface IAttribution {
    event ArtistsSet(address indexed collection, address indexed actor, address[] artists);
    event RosterLocked(address indexed collection);

    /// @notice Declare (replace) the artist roster for `collection`. Callable
    ///         by the collection's owner() or the collection itself, until
    ///         locked.
    function setArtists(address collection, address[] calldata artists) external;

    /// @notice One-way: freeze the roster for `collection`.
    function lockRoster(address collection) external;

    function artistsOf(address collection) external view returns (address[] memory);

    function isRosterLocked(address collection) external view returns (bool);
}
