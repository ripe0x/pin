// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

/// @title IGate
/// @notice A view a sale asks before each mint. A gate that needs to write
///         state per mint does not fit this interface; per-wallet counting
///         lives in the sale.
interface IGate {
    function check(address collection, address to, uint256 quantity, bytes calldata data) external view returns (bool);
}
