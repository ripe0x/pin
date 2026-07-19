// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

/// @title IPreviewRenderer
/// @notice Optional renderer extension. Renders what a token would look like
///         for a caller-supplied seed, with no token minted. Previews are a
///         pure function of chain state, like the live view, so any
///         integrator, marketplace, or self-hosted mint page can eth_call to
///         sample outputs using only an RPC.
///
///         Renderers that can render from (tokenId, seed) alone implement
///         this. Renderers whose output depends on state a preview cannot
///         supply (sibling tokens, companion contracts, hook-recorded
///         mint-time data) do not. Detection is a try/catch eth_call; the repo
///         convention is magic values and feature probing, not ERC-165.
///
///         A preview document MUST set `tokenData.context = "preview"` (see
///         docs/injection-convention.md) so the work's code can distinguish an
///         exploratory render from a canonical token render. Preview metadata
///         carries no provenance attributes.
interface IPreviewRenderer {
    /// @notice Renders preview metadata for a hypothetical token.
    /// @param collection The collection to preview; its name and render
    ///        settings are read live.
    /// @param tokenId The hypothetical token id. Art keyed to mint order reads
    ///        this, so pass minted + 1 to preview the next token.
    /// @param seed Caller-supplied entropy standing in for tokenSeed. Any
    ///        value is accepted.
    /// @return A data:application/json;base64 URI shaped like tokenURI output
    ///         (name marked as a preview, animation_url built from `seed`,
    ///         seed attribute only).
    function previewURI(address collection, uint256 tokenId, bytes32 seed)
        external
        view
        returns (string memory);
}
