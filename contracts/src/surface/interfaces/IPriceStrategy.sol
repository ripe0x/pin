// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

/// @title IPriceStrategy
/// @notice Optional per-collection pricing module. View-only: the core reads
///         the price and retains custody of funds, so a strategy has no theft
///         or reentrancy path. When a collection's strategy is unset, its
///         stored fixed price applies.
///
///         A strategy may read any chain state (block.basefee, companion
///         contract state, or the collection itself) to compute a dynamic
///         price in place of a fixed one.
interface IPriceStrategy {
    /// @notice Returns the total price in wei for `quantity` tokens minted by
    ///         `minter`.
    /// @param collection The calling collection, passed explicitly so one
    ///        strategy instance can serve many collections.
    /// @param minter The minting wallet.
    /// @param quantity Tokens requested in this call.
    /// @param data Forwarded mint data (e.g. tier selectors); strategy-defined.
    function priceOf(
        address collection,
        address minter,
        uint256 quantity,
        bytes calldata data
    ) external view returns (uint256);
}
