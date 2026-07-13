// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Vendored subset of the MURI Protocol interfaces, verbatim in shape:
// github.com/ygtdmn/muri-protocol contract/src/interfaces/IMURIProtocol.sol
// + IMURIProtocolCreator.sol (author: Yigit Duman, @yigitduman; MIT).
// Only what MuriOperator needs: the InitConfig struct tree, the one
// operator-gated call, and the creator (operator) interface MURI probes at
// registration and consults for collector ownership. Pragma relaxed from
// >=0.8.30 to this repo's compiler; struct/enum layouts are ABI-identical.

interface IMURIProtocol {
    enum DisplayMode {
        DIRECT_FILE,
        HTML
    }

    enum ThumbnailKind {
        ON_CHAIN,
        OFF_CHAIN
    }

    struct Artwork {
        string[] artistUris;
        string[] collectorUris;
        string mimeType;
        string fileHash;
        bool isAnimationUri;
        uint256 selectedArtistUriIndex;
    }

    struct Permissions {
        uint16 flags;
    }

    struct OnChainThumbnail {
        string mimeType;
        address[] chunks;
        bool zipped;
    }

    struct OffChainThumbnail {
        string[] uris;
        uint256 selectedUriIndex;
    }

    struct Thumbnail {
        ThumbnailKind kind;
        OnChainThumbnail onChain;
        OffChainThumbnail offChain;
    }

    struct HtmlTemplate {
        address[] chunks;
        bool zipped;
    }

    struct InitConfig {
        string metadata;
        Artwork artwork;
        Thumbnail thumbnail;
        DisplayMode displayMode;
        Permissions permissions;
        HtmlTemplate htmlTemplate;
    }

    /// @notice Operator-gated on MURI's side: msg.sender must be the
    ///         contract's registered operator.
    function initializeTokenData(
        address contractAddress,
        uint256 tokenId,
        InitConfig calldata config,
        bytes[] calldata thumbnailChunks,
        string[] calldata htmlTemplateChunks
    ) external;
}

/// @notice The operator interface MURI probes at registration
///         (supportsInterface must answer true for this interface's id) and
///         consults for collector token-ownership checks.
interface IMURIProtocolCreator {
    function isTokenOwner(address creatorContract, address account, uint256 tokenId) external view returns (bool);
}
