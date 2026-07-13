// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {CollectionConfig, CollectionStatus, IdMode, InitParams} from "../CollectionTypes.sol";

/// @title ICollectionCore
/// @notice The shared surface of every collection, whichever way it hands out
///         ids. An OZ ERC721 deployed as an immutable EIP-1167 clone: the
///         collector pays the price, the artist keeps all of it minus a fixed
///         share for whoever hosted the mint, and the core stores one seed
///         per token — nothing it could work out later. Everything that can
///         change sits in four slots (renderer, price strategy, mint hook,
///         minters); there is no upgrade path. What deploys is what runs,
///         forever.
///
///         The mint entrypoints are NOT here. Each id mode is its own
///         contract with its own doors: ICollection (sequential) sells and
///         counts; IPooledCollection lets its minter choose ids. A door that
///         should not exist simply does not.
interface ICollectionCore {
    // ── errors ──────────────────────────────────────────────────────────────
    error OwnerRequired();
    error RendererRequired();
    error RendererNotContract(address renderer);
    error RoyaltyTooHigh();
    error BadMintWindow();
    error ZeroMinter();
    error ZeroQuantity();
    error MintNotStarted();
    error MintEnded();
    error WrongPayment(uint256 required, uint256 sent);
    error Underpayment(uint256 required, uint256 sent);
    error NotMinter();
    error ExceedsCap(uint256 cap, uint256 attempted);
    error HookRejected();
    error NotAuthorized();
    error ZeroAccount();
    error NothingToWithdraw();
    error WithdrawFailed();
    error NoStrayETH();
    error RescueFailed();
    error NeverMinted();
    error RenounceDisabled();
    error AlreadyAdmin();
    error NotAnAdmin();
    error BadSupplyCap(uint256 floor, uint256 requested);
    error SupplyIsLocked();
    error RendererIsLocked();

    // ── events ──────────────────────────────────────────────────────────────
    event CollectionConfigured(IdMode idMode, uint256 price, uint256 supplyCap, uint64 mintStart, uint64 mintEnd);

    // ── ERC-4906 (the refresh signals marketplaces subscribe to) ────────────
    event MetadataUpdate(uint256 _tokenId);
    event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId);

    // ── ERC-7572 (the contract-level metadata refresh signal) ───────────────
    event ContractURIUpdated();

    /// @notice One event per mint call — the permanent per-mint record.
    ///         Built-in paths cover [firstTokenId, firstTokenId + quantity - 1];
    ///         extension mints emit quantity 1. firstMintIndex is the global
    ///         mint order of the call's first token (token k's index =
    ///         firstMintIndex + k), stamped because pooled ids don't reveal
    ///         it. The mint block is the log's own block. Nothing here is
    ///         stored per token; indexers read it from the log.
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
    event RendererLocked();
    event CreatorListed(address indexed creator, bool listed);
    event RendererSet(address indexed renderer);
    event MintHookSet(address indexed hook);
    event PriceStrategySet(address indexed strategy);
    event MinterSet(address indexed minter, bool allowed);
    event AdminSet(address indexed account, bool allowed);
    event Withdrawn(address indexed account, uint256 amount);
    event PayoutAddressSet(address indexed payoutAddress);
    event StrayETHRescued(address indexed to, uint256 amount);

    // ── init + config ────────────────────────────────────────────────────────
    /// @notice One-shot init. `p.initialMinters` grants extension minters, and
    ///         `p.creators` seeds the owner's side of attribution, so pooled,
    ///         backed, and collaborative forms deploy fully wired in one
    ///         transaction. Locks passed true in `p.cfg` take effect here: the
    ///         collection is born locked.
    function initialize(InitParams calldata p) external;

    /// @notice Reschedule the built-in paid mint window (owner or admin).
    ///         `end` 0 means open-ended; otherwise end > start. Governs the
    ///         paid path only — extension minters keep their own schedules.
    function setMintWindow(uint64 start, uint64 end) external;
    /// @notice Update the stored fixed price (ignored while a price strategy
    ///         is set). Payment is exact-match, so a mint in flight at the old
    ///         price reverts rather than overpaying.
    function setPrice(uint256 price) external;
    /// @notice Update the EIP-2981 royalty. Capped at 50%; receiver 0 = owner().
    function setRoyalty(uint16 royaltyBps, address royaltyReceiver) external;
    /// @notice Update the supply cap (0 = open supply). Reverts once locked,
    ///         and below what already exists (mints-ever in sequential mode,
    ///         live supply in pooled).
    function setSupplyCap(uint256 supplyCap) external;
    /// @notice One-way: lock the supply cap forever — the scarcity promise.
    ///         The cap binds every mint path, so no later minter grant can
    ///         climb over it.
    function lockSupply() external;
    /// @notice Point tokenURI at a new renderer. Reverts once locked; the
    ///         renderer can never be the zero address.
    function setRenderer(address renderer) external;
    function setMintHook(address hook) external;
    function setPriceStrategy(address strategy) external;
    /// @notice Grant or revoke an extension minter — the artist's visible,
    ///         onchain choice, and the lever for revoking a minter's schedule.
    function setMinter(address minter, bool allowed) external;
    /// @notice Grant an admin. An admin can call every management function the
    ///         owner can, except managing admins and transferring ownership.
    ///         Owner-only; reverts AlreadyAdmin / ZeroAccount.
    function addAdmin(address account) external;
    /// @notice Revoke an admin. The owner may remove anyone; an admin may
    ///         renounce itself. Reverts NotAnAdmin if there is no grant to
    ///         remove, so a typo fails loudly.
    function removeAdmin(address account) external;
    function setPayoutAddress(address payoutAddress) external;
    /// @notice The owner's side of attribution: list or unlist creators. A
    ///         listing is an assertion; confirmation needs the creator to
    ///         claim this collection in the Catalog too (isConfirmedCreator).
    function setCreators(address[] calldata list, bool listed) external;
    /// @notice Emit an ERC-4906 refresh for changes the core cannot see (a
    ///         chain-live work moving, a reveal, new captures). Callable by
    ///         the current renderer or owner/admin. Works after lockRenderer —
    ///         the lock pins the pointer, not the weather.
    function notifyMetadataUpdate(uint256 fromTokenId, uint256 toTokenId) external;
    /// @notice One-way, optional: pin the renderer pointer forever. An
    ///         immutable renderer behind a locked pointer is full presentation
    ///         permanence; a mutable one behind a locked pointer is the
    ///         artist's explicit, inspectable choice.
    function lockRenderer() external;

    // ── burn ─────────────────────────────────────────────────────────────────
    /// @notice Burn a token. Who may burn depends on the form: sequential
    ///         collections use the standard owner-or-approved rule; pooled
    ///         collections restrict burning to authorized minters, which own
    ///         the id pool and any per-token backing.
    function burn(uint256 tokenId) external;

    // ── withdrawals (pull payments) ──────────────────────────────────────────
    /// @notice Send `account` what it is owed. Anyone may pull the trigger;
    ///         the money only ever goes to the owed address.
    function withdraw(address account) external;

    function pendingWithdrawal(address account) external view returns (uint256);

    /// @notice Owner-or-admin sweep of ETH nobody is owed (force-fed strays).
    ///         Pull-payment balances are untouchable.
    function rescueStrayETH(address to) external;

    // ── reads ───────────────────────────────────────────────────────────────
    function config() external view returns (CollectionConfig memory cfg, CollectionStatus status, uint256 minted);

    /// @notice The fixed protocol referral share, in bps.
    function REFERRAL_SHARE_BPS() external view returns (uint16);

    /// @notice Resolved price for a prospective mint: the strategy if set,
    ///         else the stored fixed price times quantity.
    function currentPrice(address minter, uint256 quantity, bytes calldata data) external view returns (uint256);

    /// @notice Mint-time entropy, stamped per token in the mint transaction.
    function tokenSeed(uint256 tokenId) external view returns (bytes32);

    /// @notice Which kind of collection this is. Not a setting — a fact of
    ///         the contract you are holding.
    function idMode() external view returns (IdMode);
    function renderer() external view returns (address);
    function mintHook() external view returns (address);
    function priceStrategy() external view returns (address);
    function isMinter(address minter) external view returns (bool);
    /// @notice Whether `account` may use the admin-gated setters: the owner,
    ///         or anyone holding an explicit grant.
    function isAdmin(address account) external view returns (bool);
    function isRendererLocked() external view returns (bool);
    function isSupplyLocked() external view returns (bool);
    /// @notice Whether the owner has listed `who` as a creator (one side).
    function isListedCreator(address who) external view returns (bool);
    /// @notice Live, mutual attribution: the owner listed `who` AND `who`
    ///         claimed this collection in the Catalog. Either side can retract
    ///         and the credit goes with it. False when no Catalog is set.
    function isConfirmedCreator(address who) external view returns (bool);
    /// @notice The Catalog singleton creators are confirmed against (0 = off).
    function catalog() external view returns (address);
}
