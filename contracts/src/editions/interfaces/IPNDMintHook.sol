// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

/// @title IPNDMintHook
/// @notice An artist-owned contract an edition calls on each mint. Lets an
///         artist gate mints (beforeMint reverts or returns the wrong
///         selector) or record custom data to their own storage (afterMint),
///         without PND building those features into the core. Trust is
///         artist-scoped; hooks are non-payable so they cannot touch the
///         honest-pricing invariant.
interface IPNDMintHook {
    /// @notice Must return `IPNDMintHook.beforeMint.selector` to authorize.
    function beforeMint(
        address minter,
        uint256 quantity,
        uint256 firstTokenId,
        address surface,
        bytes calldata hookData
    ) external returns (bytes4);

    /// @notice Called after tokens are minted and proceeds are paid.
    function afterMint(
        address minter,
        uint256 quantity,
        uint256 firstTokenId,
        address surface,
        bytes calldata hookData
    ) external;
}
