// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

/// @title IMintHook
/// @notice Artist-owned contract a collection calls on each mint. Gates mints
///         (beforeMint reverts or returns a non-matching selector) or records
///         custom data to its own storage (afterMint), keeping those features
///         out of the core. Hooks are set per collection by its owner. Hooks
///         are non-payable, so they cannot affect pricing or value custody.
///         Hooks run on every mint path: the built-in paid paths and
///         extension-minter mintTo/mintToId.
interface IMintHook {
    /// @notice Must return `IMintHook.beforeMint.selector` to authorize the
    ///         mint; any other return value or a revert blocks it.
    function beforeMint(
        address minter,
        uint256 quantity,
        uint256 firstTokenId,
        address referrer,
        bytes calldata hookData
    ) external returns (bytes4);

    /// @notice Called after tokens are minted and proceeds are settled.
    function afterMint(
        address minter,
        uint256 quantity,
        uint256 firstTokenId,
        address referrer,
        bytes calldata hookData
    ) external;
}
