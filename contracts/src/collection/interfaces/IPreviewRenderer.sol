// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

/// @title IPreviewRenderer
/// @notice OPTIONAL renderer extension: render what a token WOULD look like
///         for a caller-supplied seed, without any token existing. Previews
///         are a pure function of chain state, exactly like the live view —
///         any integrator, marketplace, or self-hosted mint page can
///         eth_call sample outputs with nothing but an RPC.
///
///         Renderers that can render faithfully from (tokenId, seed) alone
///         implement this; renderers whose output depends on state a preview
///         cannot fake (sibling tokens, companion contracts, hook-recorded
///         mint-time data) simply don't. Detection is a try/catch eth_call —
///         the repo convention is magic values and feature probing, not
///         ERC-165.
///
///         A preview document MUST inject `tokenData.context = "preview"`
///         (render-context convention) so the work's code can distinguish an
///         exploratory render from a canonical token render. Preview
///         metadata carries no provenance attributes: a preview is not a
///         token.
interface IPreviewRenderer {
    /// @notice Render preview metadata for a hypothetical token.
    /// @param collection The collection the preview is for (its work config,
    ///        name, and render settings are read live).
    /// @param tokenId The hypothetical token id — art keyed to mint order
    ///        reads this, so callers preview "the next token" by passing
    ///        minted + 1.
    /// @param seed Caller-supplied entropy standing in for tokenSeed. Any
    ///        value; throwaway seeds are the point.
    /// @return A data:application/json;base64 URI shaped like tokenURI
    ///         output (name marked as a preview, animation_url/image built
    ///         from `seed`, seed attribute only).
    function previewURI(address collection, uint256 tokenId, bytes32 seed)
        external
        view
        returns (string memory);
}
