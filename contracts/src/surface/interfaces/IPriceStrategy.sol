// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

/// @title IPriceStrategy
/// @notice Optional pricing module a minter consults. View-only: the minter
///         reads the price and retains custody of funds, so a strategy has no
///         theft or reentrancy path. When a minter's strategy is unset, the
///         minter's stored fixed price applies.
///
///         A strategy may read any chain state (block.basefee, companion
///         contract state, or the collection itself) to compute a dynamic
///         price in place of a fixed one.
interface IPriceStrategy {
    /// @notice Returns the total price in wei to mint `quantity` tokens to
    ///         `minter`.
    /// @param collection The collection being minted, passed explicitly by the
    ///        calling minter so one strategy instance can serve many collections.
    /// @param minter The mint recipient the quote is for; FixedPriceMinter
    ///        passes the mint's `to` address, the same address its gates evaluate.
    /// @param quantity Tokens requested in this call.
    /// @dev A strategy takes no caller-supplied data: the price is a function of
    ///      `(collection, minter, quantity)` and chain state only. Caller input
    ///      belongs to the gate path (the allowlist proof), which the minter
    ///      keeps separate. Pricing that needs a caller-chosen selector belongs
    ///      in a dedicated minter, not a bytes passthrough on this shared quote.
    function priceOf(
        address collection,
        address minter,
        uint256 quantity
    ) external view returns (uint256);
}
