// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

/// @title IMURIProtocol
/// @notice Local, caller-side mirror of the parts of the MURI protocol
///         (ygtdmn/muri-protocol, mainnet singleton
///         0x0000000000C2A0B63ab4aA971B08B905E5875b01) that PND editions use.
///         MURI itself compiles under pragma >=0.8.30; this is only the ABI a
///         0.8.24 caller needs, so the structs/enums mirror MURI's exactly
///         (field order is load-bearing for `initializeTokenData` calldata).
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

    // ── registration ──────────────────────────────────────────────────────────
    /// @dev onlyContractOwner (Manifold isAdmin OR Ownable.owner of the target).
    function registerContract(address contractAddress, address operatorAddress) external;
    function isContractOperator(address contractAddress, address operatorAddress)
        external
        view
        returns (bool);

    // ── token data (operator-gated) ─────────────────────────────────────────────
    /// @dev onlyRegisteredContract + onlyContractOperator (msg.sender == operator).
    function initializeTokenData(
        address contractAddress,
        uint256 tokenId,
        InitConfig calldata config,
        bytes[] calldata thumbnailChunks,
        string[] calldata htmlTemplateChunks
    ) external;

    /// @dev Artist (owner/admin) or collector (isTokenOwner), per permissions.
    function addArtworkUris(address contractAddress, uint256 tokenId, string[] calldata uris)
        external;

    // ── reads / rendering ───────────────────────────────────────────────────────
    function getArtwork(address contractAddress, uint256 tokenId)
        external
        view
        returns (Artwork memory);
    function getArtistArtworkUris(address contractAddress, uint256 tokenId)
        external
        view
        returns (string[] memory);
    function getCollectorArtworkUris(address contractAddress, uint256 tokenId)
        external
        view
        returns (string[] memory);
    /// @notice Resolved image/thumbnail URI for the token.
    function renderImage(address contractAddress, uint256 tokenId)
        external
        view
        returns (string memory);
    /// @notice Base64 data URI of MURI's resilient onchain HTML viewer (tries
    ///         every fallback URI, verifies the SHA-256 hash, shows the first
    ///         surviving copy).
    function renderHTML(address contractAddress, uint256 tokenId)
        external
        view
        returns (string memory);
}
