// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.20;

import {ISovereignAuctionHouseV2} from "./ISovereignAuctionHouseV2.sol";

/// @title Sovereign Auction House V2.1 interface
/// @notice V2.1 keeps the V2 ABI, storage layout, events and `Auction` tuple
///         (`auctionVersion()` still returns 2), and adds one settlement
///         state. When delivery to the winner fails but the lot can still
///         be transferred out of escrow, the sale is binding: the protocol
///         fee and seller are paid (`AuctionEnded`), and the lot stays in
///         the house for the winner (`heldForWinner`, `LotHeldForWinner`)
///         to claim at any time, to its own address or to any address it
///         chooses via `claimLot`. The winner's bid is refunded only when
///         the lot cannot be transferred at all (V2's
///         `pendingDelivery` / `unwindStuckLot` path, unchanged in meaning).
interface ISovereignAuctionHouseV2_1 is ISovereignAuctionHouseV2 {
    /// @notice Emitted, after `AuctionEnded`, when a sale settled with the
    ///         lot still escrowed because delivery to `winner` failed while
    ///         the lot itself remained transferable. The protocol fee and
    ///         seller have been paid. Only `claimLot` can move the lot from
    ///         here, and only to `winner` or to an address `winner` names.
    event LotHeldForWinner(uint256 indexed auctionId, address indexed winner);

    /// @notice True for a settled sale whose lot is escrowed for the winner.
    ///         Mutually exclusive with `pendingDelivery` and `pendingReturn`.
    ///         The auction record and its token index stay in storage until
    ///         `claimLot` delivers the lot; there is no deadline.
    function heldForWinner(uint256 auctionId) external view returns (bool);

    /// @notice Implementation version string, "2.1.0". V2 houses do not
    ///         implement this function; `auctionVersion()` returns 2 on both
    ///         because the `Auction` tuple layout is unchanged.
    function version() external pure returns (string memory);
}
