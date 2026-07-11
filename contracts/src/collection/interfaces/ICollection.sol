// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {ICollectionCore} from "./ICollectionCore.sol";

/// @title ICollection
/// @notice The sequential collection — the common form. The contract counts
///         1, 2, 3: the token id IS the mint order, ids never recycle, and
///         the built-in paid paths sell directly to collectors. There is no
///         id-choosing entrypoint here at all, which is the whole guarantee.
interface ICollection is ICollectionCore {
    // ── mint: built-in paid paths (value custody stays in the core) ─────────
    /// @notice Simple mint. No referrer, so the artist keeps the full price.
    function mint(uint256 quantity) external payable;

    /// @notice Mint crediting a referrer its share — PND on PND, the artist on
    ///         their own site. referrer 0 folds the share back to the artist.
    ///         `hookData` reaches the mint hook and the price strategy.
    function mintWithReferral(uint256 quantity, address referrer, bytes calldata hookData) external payable;

    // ── mint: extension path (economics live in the authorized minter) ──────
    /// @notice Authorized minters only. Non-payable; the calling minter
    ///         carries all value handling. Hooks and the cap apply as on the
    ///         paid path; the window does not — a minter owns its own
    ///         schedule. Returns the assigned id.
    function mintTo(address to, address referrer, bytes calldata hookData) external returns (uint256 tokenId);
}
