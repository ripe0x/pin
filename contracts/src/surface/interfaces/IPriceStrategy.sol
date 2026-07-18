// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

/// @title IPriceStrategy
/// @notice Optional per-collection pricing module. A view only: the core
///         reads the price and keeps custody of funds, so a strategy can
///         never introduce a theft or reentrancy path. When a collection's
///         strategy slot is unset, its stored fixed price applies.
///
///         Strategies may read anything: block.basefee, companion contract
///         state, or the collection itself, to compute a dynamic price in
///         place of a fixed one.
interface IPriceStrategy {
    /// @notice Total price in wei for `quantity` tokens minted by `minter`.
    /// @param collection The collection asking (explicit, so one strategy
    ///        instance can serve many collections).
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
