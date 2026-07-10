// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {
    CollectionConfig,
    CollectionStatus,
    IdMode,
    InitParams,
    WorkConfig
} from "../CollectionTypes.sol";

/// @title ICollection
/// @notice One artist collection: an OZ ERC721 deployed as an immutable
///         EIP-1167 clone. The core holds ownership, money paths, and
///         provenance (per-token Mint Marks + mint-time entropy); all
///         variability lives in four slots (renderer, price strategy, mint
///         hook, extension minters) and optional companion contracts.
///         Relationship/graph semantics live in companions, never here.
///         Per-token provenance is the seed plus the Minted event; the core
///         stores nothing derivable (sequential mint order IS the token id).
///         Honest fixed pricing with a fixed built-in Referral Share; no
///         other protocol fee. There is no upgrade path and no seal: what
///         deploys is what runs, forever.
interface ICollection {
    // ── errors ──────────────────────────────────────────────────────────────
    error OwnerRequired();
    error RendererRequired();
    error RoyaltyTooHigh();
    error BadMintWindow();
    error ZeroMinter();
    error ZeroQuantity();
    error MintNotStarted();
    error MintEnded();
    /// @notice Built-in paid mints are sequential-mode sales; pooled
    ///         collections sell exclusively through their authorized minter.
    error PooledSellsViaMinter();
    error WrongPayment();
    error Underpayment();
    error NotMinter();
    error PooledNeedsMintToId();
    error SequentialAssignsIds();
    error ExceedsCap();
    error HookRejected();
    error NotAuthorized();
    error ZeroAccount();
    error NothingToWithdraw();
    error WithdrawFailed();
    error NoStrayETH();
    error RescueFailed();
    error MetadataIsFrozen();
    error NotMinted();
    error LengthMismatch();
    error AlreadyFrozen();
    error WorkAlreadyLocked();
    error NeverMinted();
    error RenounceDisabled();
    error AlreadyAdmin();
    error NotAnAdmin();
    error BadSupplyCap();
    error SupplyIsLocked();

    // ── events ──────────────────────────────────────────────────────────────
    event CollectionConfigured(
        IdMode idMode,
        uint256 price,
        uint256 supplyCap,
        uint64 mintStart,
        uint64 mintEnd,
        string artworkURI
    );

    // ── ERC-4906 (metadata refresh signals marketplaces subscribe to) ───────
    event MetadataUpdate(uint256 _tokenId);
    event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId);

    /// @notice One event per mint call — THE permanent per-mint provenance
    ///         record. Built-in paths cover [firstTokenId, firstTokenId +
    ///         quantity - 1]; extension mints emit quantity 1 with
    ///         firstTokenId = the minted id. firstMintIndex is the global
    ///         mint order of the call's first token (token k's index =
    ///         firstMintIndex + k) — explicit because pooled order is not
    ///         derivable from ids. The mint block is the log's own block;
    ///         statusAtMint is the lifecycle status derived at mint time.
    ///         None of this is stored per token; indexers read it here.
    event Minted(
        address indexed to,
        address indexed referrer,
        uint256 firstTokenId,
        uint256 quantity,
        uint256 firstMintIndex,
        CollectionStatus statusAtMint
    );

    event Burned(uint256 indexed tokenId);
    event ReferralPaid(address indexed referrer, uint256 amount);
    event MintWindowSet(uint64 mintStart, uint64 mintEnd);
    event PriceSet(uint256 price);
    event RoyaltySet(uint16 royaltyBps, address indexed royaltyReceiver);
    event SupplyCapSet(uint256 supplyCap);
    event SupplyLocked();
    event RendererSet(address indexed renderer);
    event MintHookSet(address indexed hook);
    event PriceStrategySet(address indexed strategy);
    event MinterSet(address indexed minter, bool allowed);
    event AdminSet(address indexed account, bool allowed);
    event TokenArtworkSet(uint256 indexed tokenId, string cid);
    event WorkSet(bytes32 codeHash);
    event WorkLocked();
    event Withdrawn(address indexed account, uint256 amount);
    event PayoutAddressSet(address indexed payoutAddress);
    event MetadataFrozen();
    event StrayETHRescued(address indexed to, uint256 amount);

    // ── init + config (owner) ────────────────────────────────────────────────
    /// @notice One-shot init. `p.initialMinters` grants extension minters so
    ///         pooled and backed forms deploy fully wired in one transaction.
    ///         `p.artists` is written BY the collection to the Attribution
    ///         singleton during init (the singleton authorizes the collection
    ///         itself; a factory could not pass that check after ownership is
    ///         set); each artist completes the handshake by claiming the
    ///         collection in their own Catalog.
    function initialize(InitParams calldata p) external;

    /// @notice Reschedule the built-in paid mint window (owner or admin). Reverts
    ///         BadMintWindow unless `end` is 0 (open-ended) or `end > start`.
    ///         Governs the built-in paid path only; extension minters keep their
    ///         own schedules.
    function setMintWindow(uint64 start, uint64 end) external;
    /// @notice Update the stored fixed price (ignored while a price strategy is
    ///         set). Exact-match payment means an in-flight mint at the old
    ///         price reverts rather than overpaying.
    function setPrice(uint256 price) external;
    /// @notice Update the EIP-2981 royalty. Capped at MAX_ROYALTY_BPS;
    ///         receiver 0 = owner().
    function setRoyalty(uint16 royaltyBps, address royaltyReceiver) external;
    /// @notice Update the supply cap (0 = open supply). Reverts SupplyIsLocked
    ///         after lockSupply(); reverts BadSupplyCap below what already
    ///         exists (mints-ever in sequential mode, live supply in pooled).
    function setSupplyCap(uint256 supplyCap) external;
    /// @notice One-way: permanently lock the supply cap — the scarcity promise.
    ///         The cap binds extension minters too, so a locked cap is a hard
    ///         ceiling regardless of what minters are granted later.
    function lockSupply() external;
    function setRenderer(address renderer) external;
    function setMintHook(address hook) external;
    function setPriceStrategy(address strategy) external;
    /// @notice Grant or revoke an extension minter. Explicit, per-minter,
    ///         evented: authorizing a minter is the artist's visible, onchain
    ///         choice.
    function setMinter(address minter, bool allowed) external;
    /// @notice Grant an admin. An admin can call every management function the
    ///         owner can, except managing admins (addAdmin/removeAdmin) and
    ///         transferring ownership. Owner-only; reverts AlreadyAdmin if the
    ///         account is already an admin, ZeroAccount for the zero address.
    function addAdmin(address account) external;
    /// @notice Revoke an admin. The owner may remove any admin; an admin may
    ///         renounce itself by passing its own address. Any other caller
    ///         reverts NotAuthorized; reverts NotAnAdmin if the account is not
    ///         currently an admin.
    function removeAdmin(address account) external;
    /// @notice Set per-token artwork overrides (captures/thumbnails). A single
    ///         token is a batch of one. Emits MetadataUpdate per token.
    function setTokenArtworkBatch(uint256[] calldata tokenIds, string[] calldata cids) external;
    function setPayoutAddress(address payoutAddress) external;
    /// @notice Emit an ERC-4906 refresh signal for changes the core cannot see
    ///         (ChainLive works, reveals). Callable by the current renderer or
    ///         owner/admin; works after freezeMetadata (a frozen ChainLive work
    ///         still legitimately changes output — that is its declared physics).
    function notifyMetadataUpdate(uint256 fromTokenId, uint256 toTokenId) external;
    function freezeMetadata() external;
    /// @notice Replace the work definition (the algorithm the renderer runs). Allowed until
    ///         `lockWork`; reverts once locked.
    function setWork(WorkConfig calldata work) external;
    /// @notice Permanently lock the work config, so it can never change again. Irreversible.
    function lockWork() external;

    // ── mint: built-in paid paths (value custody stays in the core) ─────────
    /// @notice Simple mint: referrer defaults to address(0) so the artist gets
    ///         the full price (no referral share). The honest default path.
    function mint(uint256 quantity) external payable;

    /// @notice Mint crediting a referrer its share. PND's frontend passes PND's
    ///         address; a self-hosted page passes the artist's address;
    ///         address(0) folds the share back to the artist. `hookData` is
    ///         forwarded to the mint hook (if any).
    function mintWithReferral(uint256 quantity, address referrer, bytes calldata hookData)
        external
        payable;

    // ── mint: extension path (economics live in the authorized minter) ──────
    /// @notice Sequential mode only. Non-payable; the calling minter carries
    ///         all value handling. Hooks run. Returns the assigned id.
    function mintTo(address to, address referrer, bytes calldata hookData)
        external
        returns (uint256 tokenId);

    /// @notice Pooled mode only: the minter supplies the id (tokenId ==
    ///         sourceId forms). A previously burned id mints again as a new
    ///         instance with fresh mark and entropy. Hooks run.
    function mintToId(address to, uint256 tokenId, address referrer, bytes calldata hookData)
        external;

    /// @notice Burn by owner or approved (vaults redeem through approval).
    function burn(uint256 tokenId) external;

    // ── withdrawals (pull payments) ──────────────────────────────────────────
    /// @notice Withdraw the pull-payment balance owed to `account`, to `account`.
    function withdraw(address account) external;

    function pendingWithdrawal(address account) external view returns (uint256);

    /// @notice Owner-only sweep of ETH not owed to any payee (force-fed stray ETH).
    function rescueStrayETH(address to) external;

    // ── reads ───────────────────────────────────────────────────────────────
    function config()
        external
        view
        returns (CollectionConfig memory cfg, CollectionStatus status, uint256 minted);

    /// @notice The fixed protocol referral share, in bps (constant).
    function referralShareBps() external view returns (uint16);

    /// @notice Resolved price for a prospective mint: the strategy if set,
    ///         else the stored fixed price times quantity.
    function currentPrice(address minter, uint256 quantity, bytes calldata data)
        external
        view
        returns (uint256);

    /// @notice Mint-time entropy, stamped per token in the mint transaction.
    function tokenSeed(uint256 tokenId) external view returns (bytes32);

    function workConfig() external view returns (WorkConfig memory);
    function isWorkLocked() external view returns (bool);
    function idMode() external view returns (IdMode);
    function artwork() external view returns (string memory);
    function tokenArtwork(uint256 tokenId) external view returns (string memory);
    function renderer() external view returns (address);
    function mintHook() external view returns (address);
    function priceStrategy() external view returns (address);
    function isMinter(address minter) external view returns (bool);
    /// @notice Whether `account` holds an explicit admin grant (owner is an
    ///         implicit admin and need not appear here).
    function isAdmin(address account) external view returns (bool);
    function isMetadataFrozen() external view returns (bool);
    /// @notice Whether the supply cap is permanently locked.
    function isSupplyLocked() external view returns (bool);
    /// @notice metadataFrozen && workLocked: the art-permanence guarantee.
    ///         (The contract itself is immutable from deploy.)
    function isPermanent() external view returns (bool);
}
