// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

/// @title IPNDMintHook
/// @notice An artist-owned contract a PNDEditions project calls on each mint.
///         Lets an artist gate mints (beforeMint reverts or returns the wrong
///         selector) or record custom data to their own storage contract
///         (afterMint), without PND building those features into the core.
///
///         Trust is artist-scoped: a project's hook only affects that project.
///         Hooks are non-payable in v1 so they cannot touch the honest-pricing
///         invariant (the collector always pays exactly price * quantity). The
///         project guards the whole mint with a reentrancy lock.
interface IPNDMintHook {
    /// @notice Called before tokens are minted. MUST return
    ///         `IPNDMintHook.beforeMint.selector` to authorize the mint;
    ///         returning anything else (or reverting) blocks it.
    /// @param minter        The address minting (msg.sender on the project).
    /// @param releaseId     The release being minted.
    /// @param quantity      Number of tokens.
    /// @param firstTokenId  The batch head id that will be minted.
    /// @param surface       The mint surface passed by the caller.
    /// @param hookData       Opaque payload forwarded from mint().
    function beforeMint(
        address minter,
        uint256 releaseId,
        uint256 quantity,
        uint256 firstTokenId,
        address surface,
        bytes calldata hookData
    ) external returns (bytes4);

    /// @notice Called after tokens are minted and proceeds are paid. The
    ///         typical place to record custom provenance to the artist's own
    ///         storage, keyed by firstTokenId / quantity.
    function afterMint(
        address minter,
        uint256 releaseId,
        uint256 quantity,
        uint256 firstTokenId,
        address surface,
        bytes calldata hookData
    ) external;
}
