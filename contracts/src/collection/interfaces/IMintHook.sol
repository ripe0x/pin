// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

/// @title IMintHook
/// @notice An artist-owned contract a collection calls on each mint. Lets an
///         artist gate mints (beforeMint reverts or returns the wrong
///         selector) or record custom data to their own storage (afterMint),
///         without those features living in the core. Trust is artist-scoped;
///         hooks are non-payable so they cannot touch the honest-pricing
///         invariant. Hooks run on every mint path: the built-in paid paths
///         and extension-minter mintTo/mintToAt, so gating composes with
///         custom minters instead of being reimplemented inside them.
interface IMintHook {
    /// @notice Must return `IMintHook.beforeMint.selector` to authorize.
    function beforeMint(
        address minter,
        uint256 quantity,
        uint256 firstTokenId,
        address referrer,
        bytes calldata hookData
    ) external returns (bytes4);

    /// @notice Called after tokens are minted and proceeds are paid.
    function afterMint(
        address minter,
        uint256 quantity,
        uint256 firstTokenId,
        address referrer,
        bytes calldata hookData
    ) external;
}
