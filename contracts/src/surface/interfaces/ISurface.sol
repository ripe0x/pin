// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {ISurfaceCore} from "./ISurfaceCore.sol";

/// @title ISurface
/// @notice Sequential ERC721 collection: ids auto-increment from 1 and are not
///         reused after a burn. Built-in paid mint entrypoints; an authorized
///         minter can also mint via mintTo.
interface ISurface is ISurfaceCore {
    // ── mint: built-in paid paths (value custody stays in the core) ─────────
    /// @notice Mints with no referrer, so the artist receives the full price.
    function mint(uint256 quantity) external payable;

    /// @notice Mints, crediting `referrer` its share. A caller naming a
    ///         referrer earns that address the share; a zero referrer folds
    ///         the share back to the artist. `hookData` is forwarded to the
    ///         mint hook and the price strategy.
    function mintWithReferral(uint256 quantity, address referrer, bytes calldata hookData) external payable;

    /// @notice Paid mint to a different recipient. `to` is the address the
    ///         mint hook and price strategy evaluate; overpayment refunds
    ///         accrue to the payer. The Minted event records `to` as the first
    ///         owner.
    function mintFor(address to, uint256 quantity, address referrer, bytes calldata hookData) external payable;

    // ── mint: extension path (economics live in the authorized minter) ──────
    /// @notice Authorized minters only. Non-payable; the calling minter
    ///         handles all value. Hooks and the supply cap apply as on the
    ///         paid path; the mint window does not, since a minter runs its
    ///         own schedule. Returns the assigned id.
    function mintTo(address to, address referrer, bytes calldata hookData) external returns (uint256 tokenId);
}
