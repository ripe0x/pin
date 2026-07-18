// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {ISurfaceCore} from "./ISurfaceCore.sol";

/// @title ISurface
/// @notice The sequential collection, the common form. The contract counts
///         1, 2, 3: the token id IS the mint order, ids never recycle, and
///         the built-in paid paths sell directly to collectors. There is no
///         id-choosing entrypoint here at all, which is the whole guarantee.
interface ISurface is ISurfaceCore {
    // ── mint: built-in paid paths (value custody stays in the core) ─────────
    /// @notice Simple mint. No referrer, so the artist keeps the full price.
    function mint(uint256 quantity) external payable;

    /// @notice Mint crediting `referrer` its share: whoever hosts the mint
    ///         names themselves to earn it, and a zero referrer folds the
    ///         share back to the artist. `hookData` reaches the mint hook and
    ///         the price strategy.
    function mintWithReferral(uint256 quantity, address referrer, bytes calldata hookData) external payable;

    /// @notice Paid mint to someone else: a gift, a hot wallet buying for a
    ///         vault, a sponsor covering a collector. `to` is who hooks and
    ///         the price strategy judge; overpayment refunds accrue to the
    ///         payer. The event records `to` as the true first owner.
    function mintFor(address to, uint256 quantity, address referrer, bytes calldata hookData) external payable;

    // ── mint: extension path (economics live in the authorized minter) ──────
    /// @notice Authorized minters only. Non-payable; the calling minter
    ///         carries all value handling. Hooks and the cap apply as on the
    ///         paid path; the window does not, since a minter owns its own
    ///         schedule. Returns the assigned id.
    function mintTo(address to, address referrer, bytes calldata hookData) external returns (uint256 tokenId);
}
