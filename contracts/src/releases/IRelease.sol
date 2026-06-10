// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

/// @notice How a release gates minting on another ERC721 (the continuation
///         mechanic). NONE: open mint via mint(). HOLD: each gate token id
///         can claim exactly one mint via mintGated(); the gate token is
///         untouched. BURN: each gate token is burned to mint via
///         mintGated(); requires the gate to expose burn(uint256) and the
///         claimer to have approved the release on the gate contract.
enum GateMode {
    NONE,
    HOLD,
    BURN
}

/// @notice Lifecycle of a release, computed — never stored.
///         Closed (artist ended it, one-way) beats SoldOut (cap reached)
///         beats Scheduled (window not open) beats Ended (window passed)
///         beats Live.
enum ReleaseStatus {
    Scheduled,
    Live,
    SoldOut,
    Closed,
    Ended
}

/// @notice Everything an artist decides at creation. Immutable terms
///         (price, window, supply, gate) can never change afterwards;
///         payout, royalty, and metadata (until frozen) can.
struct ReleaseParams {
    string name;
    string symbol;
    /// @dev Price per token in wei. 0 means free, and free means gas only:
    ///      a zero-price release can never charge a surface fee.
    uint256 price;
    /// @dev Mint opens at startTime (inclusive). May be in the past
    ///      (live immediately).
    uint64 startTime;
    /// @dev Mint closes at endTime (exclusive). 0 means open-ended: runs
    ///      until close() or forever.
    uint64 endTime;
    /// @dev Hard supply cap. 0 means uncapped (the timed open edition).
    uint64 maxSupply;
    /// @dev ERC721 contract minting is gated on. address(0) iff NONE.
    address gateToken;
    GateMode gateMode;
    /// @dev Where withdraw() sends artist proceeds. address(0) defaults to
    ///      the artist.
    address payout;
    /// @dev ERC-2981 receiver. address(0) defaults to payout when
    ///      royaltyBps > 0; with royaltyBps == 0 there is no royalty.
    address royaltyReceiver;
    /// @dev ERC-2981 royalty in basis points, <= 5000 (fat-finger guard,
    ///      not an opinion — 2981 is advisory either way).
    uint96 royaltyBps;
    /// @dev Token metadata URI. With uriPerToken the token id is appended
    ///      (ipfs://CID/1); without it every token returns uri verbatim —
    ///      the default open-edition shape (one JSON for all tokens).
    string uri;
    bool uriPerToken;
    /// @dev Optional IReleaseRenderer; overrides uri when set.
    address renderer;
    /// @dev ERC-7572 collection-level metadata URI. May be empty.
    string contractURI;
}

/// @notice One eth_call renders a complete, correct mint UI — a static
///         self-hosted page needs nothing else.
struct ReleaseSummary {
    string name;
    string symbol;
    address artist;
    address payout;
    uint256 price;
    uint256 surfaceFee;
    uint64 startTime;
    uint64 endTime;
    uint64 maxSupply;
    address gateToken;
    GateMode gateMode;
    ReleaseStatus status;
    uint256 totalMinted;
    uint256 totalSupply;
    bool closed;
    bool metadataFrozen;
    string uri;
    bool uriPerToken;
    address renderer;
    address royaltyReceiver;
    uint96 royaltyBps;
}

/// @notice The de-facto ERC721 burn signature (OZ ERC721Burnable, ERC721A,
///         and every Release). What a BURN gate must expose.
interface IERC721Burn {
    function burn(uint256 tokenId) external;
}

/// @title IRelease
/// @notice The external surface of one release. This is what other
///         protocols import to gate on a release — everything else a
///         release exposes is plain ERC721.
interface IRelease {
    // ── Events ──────────────────────────────────────────────────────────

    /// @notice One per mint call. pricePaid/feePaid are batch totals;
    ///         per-surface earnings are a SQL aggregate over this event.
    event Minted(
        address indexed to,
        address indexed surface,
        uint256 firstTokenId,
        uint256 quantity,
        uint256 pricePaid,
        uint256 feePaid
    );

    /// @notice One per gate token consumed by mintGated. The gate contract
    ///         is an immutable of the emitting release, so it is not
    ///         repeated here.
    event Claimed(uint256 indexed sourceTokenId, uint256 indexed tokenId);

    /// @notice Minting ended forever by the artist.
    event Closed();

    event PayoutSet(address payout);
    event MetadataSet(string uri, bool uriPerToken, address renderer);
    event MetadataFrozen();
    event RoyaltySet(address receiver, uint96 bps);

    /// @notice ERC-7572.
    event ContractURIUpdated();

    /// @notice ERC-4906.
    event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId);

    event ArtistWithdrawn(address to, uint256 amount);
    event SurfaceFeesClaimed(address indexed surface, uint256 amount);

    // ── Immutable terms ─────────────────────────────────────────────────

    /// @notice Permanent attribution: whoever called createRelease. The
    ///         transferable owner handles operations; this never changes.
    function artist() external view returns (address);

    function price() external view returns (uint256);

    /// @notice The per-token surface fee snapshotted from the factory at
    ///         creation. Immutably 0 when price is 0 (free means free).
    function surfaceFee() external view returns (uint256);

    function startTime() external view returns (uint64);
    function endTime() external view returns (uint64);
    function maxSupply() external view returns (uint64);
    function gateToken() external view returns (address);
    function gateMode() external view returns (GateMode);

    // ── State ───────────────────────────────────────────────────────────

    function closed() external view returns (bool);
    function payout() external view returns (address);
    function artistBalance() external view returns (uint256);
    function owed(address surface) external view returns (uint256);
    function gateUsed(uint256 sourceTokenId) external view returns (bool);
    function metadataFrozen() external view returns (bool);
    function status() external view returns (ReleaseStatus);
    function summary() external view returns (ReleaseSummary memory);

    // ── Minting ─────────────────────────────────────────────────────────

    /// @notice Mint on an ungated release. msg.value must equal exactly
    ///         price * quantity, plus surfaceFee * quantity iff a surface
    ///         is named and the release is not free.
    /// @param to       Recipient (gifting and routing allowed).
    /// @param quantity Tokens to mint.
    /// @param surface  Who served this mint and earns the fee. address(0)
    ///                 means unserved — no fee exists.
    function mint(address to, uint256 quantity, address surface)
        external
        payable
        returns (uint256 firstTokenId);

    /// @notice Mint on a gated release by presenting gate tokens the
    ///         caller owns. quantity = sourceTokenIds.length. Same pricing
    ///         rules as mint(). HOLD marks each source id used (once per
    ///         id, ever); BURN burns each source (caller must have
    ///         approved this release on the gate contract).
    function mintGated(
        address to,
        uint256[] calldata sourceTokenIds,
        address surface
    ) external payable returns (uint256 firstTokenId);

    /// @notice Burn a token (owner or approved). This is what makes every
    ///         release BURN-gateable by future releases.
    function burn(uint256 tokenId) external;

    // ── Funds (pull payments; no ETH moves during mint) ─────────────────

    /// @notice Send the accrued artist balance to the payout address.
    ///         Callable by anyone — funds only ever go to payout.
    function withdraw() external;

    /// @notice Send a surface's accrued fees to that surface. Callable by
    ///         anyone — funds only ever go to the surface itself.
    function claimSurfaceFees(address surface) external;

    // ── Owner ───────────────────────────────────────────────────────────

    /// @notice End minting forever. One-way. Works before or during the
    ///         window (a scheduled release's "cancel"). Windows can never
    ///         be extended.
    function close() external;

    function setPayout(address payout) external;
    function setMetadata(string calldata uri, bool uriPerToken, address renderer) external;
    function setContractURI(string calldata contractURI) external;
    function freezeMetadata() external;
    function setRoyalty(address receiver, uint96 bps) external;
}
