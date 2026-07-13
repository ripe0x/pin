// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {ERC721Upgradeable} from "openzeppelin-contracts-upgradeable/contracts/token/ERC721/ERC721Upgradeable.sol";
import {Ownable2StepUpgradeable} from "openzeppelin-contracts-upgradeable/contracts/access/Ownable2StepUpgradeable.sol";
import {
    ReentrancyGuardUpgradeable
} from "openzeppelin-contracts-upgradeable/contracts/utils/ReentrancyGuardUpgradeable.sol";

import {ICollectionCore} from "./interfaces/ICollectionCore.sol";
import {IRenderer} from "./interfaces/IRenderer.sol";
import {IMintHook} from "./interfaces/IMintHook.sol";
import {IPriceStrategy} from "./interfaces/IPriceStrategy.sol";
import {ICatalog} from "./interfaces/ICatalog.sol";
import {CollectionConfig, CollectionStatus, IdMode, InitParams} from "./CollectionTypes.sol";

/// @title CollectionCore
/// @notice The machine both collection forms share. One artist, one work,
///         one contract.
///
///         The collector pays the price. The artist keeps all of it, minus a
///         fixed share for whoever hosted the mint. There is no other fee.
///
///         The contract writes down one thing per token: a seed, stamped the
///         moment the token is minted. Order, block, lifecycle — all of that
///         is either the token id itself or sits in the event log, and
///         Ethereum is very good at keeping logs.
///
///         Everything that can change lives in four sockets: a renderer, a
///         price strategy, a mint hook, and the minters. The artist decides
///         what sits in each socket, and can make two promises permanent:
///         how the work is rendered (lockRenderer) and how many can exist
///         (lockSupply). A lock set at init means the work is born that way.
///
///         What this base does NOT have is a mint entrypoint. Each id mode is
///         its own final contract — Collection counts ids, PooledCollection
///         lets its minter choose them — and each ships only its own doors.
///
/// @dev    Finals deploy as immutable EIP-1167 clones: no proxy admin, no
///         upgrade path. What deploys is what runs. The OZ "Upgradeable"
///         bases are here only for their initializer pattern — a clone runs
///         no constructor — and nothing on top of them can be upgraded. The
///         core evolves by deploying new implementations and a new factory,
///         never by touching a live collection.
abstract contract CollectionCore is
    ERC721Upgradeable,
    Ownable2StepUpgradeable,
    ReentrancyGuardUpgradeable,
    ICollectionCore
{
    /// @notice Inaugural.
    uint256 public constant version = 1;

    uint16 internal constant BPS = 10_000;
    /// @notice The fixed protocol referral share: 10%, paid to whoever hosts
    ///         the mint. Not artist-set. Not a protocol fee — on a direct
    ///         mint it folds back to the artist.
    uint16 public constant override REFERRAL_SHARE_BPS = 1_000;
    /// @dev EIP-2981 is advisory, but a 50% ceiling keeps a permissionless
    ///      deployer from setting an absurd royalty on someone else's behalf.
    uint16 internal constant MAX_ROYALTY_BPS = 5_000;
    bytes4 internal constant INTERFACE_ID_ERC2981 = 0x2a55205a;
    bytes4 internal constant INTERFACE_ID_ERC4906 = 0x49064906;

    // Pull payments: mints accrue here, recipients claim via withdraw(). No
    // external transfer happens during a mint, so a reverting recipient can
    // never brick minting. Overpayment on a dynamic price accrues back to the
    // payer the same way.
    mapping(address => uint256) internal _pending;
    // Running sum of every _pending balance. rescueStrayETH may only sweep
    // the surplus above it, so owed money is untouchable.
    uint256 internal _totalPending;

    /// @dev Extension minters, granted explicitly by the owner. They call the
    ///      final's extension entrypoint (non-payable); value handling is
    ///      theirs.
    mapping(address => bool) internal _minters;

    /// @dev Admins, granted by the owner. An admin can call every management
    ///      function the owner can, except two the owner keeps: managing the
    ///      admin set and transferring ownership. The owner stays the single
    ///      root that hands out keys and that marketplaces read as owner().
    mapping(address => bool) internal _admins;

    // The single live source of truth for every setting, including the module
    // slots and the two one-way locks. Setters edit fields in place, so
    // config() can never drift from what the contract actually uses.
    CollectionConfig internal _cfg;

    // Mints ever, both forms. Burns never decrement it. In the sequential
    // final the next id is _mintedEver + 1 — the mint order and the id are
    // the same number, so there is no second counter to keep honest.
    uint256 internal _mintedEver;
    uint256 internal _burnedCount;

    // The one thing stored per token: mint-time entropy. It is the render
    // input that can never be reconstructed later, and since keccak output is
    // never zero, a nonzero seed doubles as the was-ever-minted sentinel.
    // Works needing more mint-time data (block, pooled order) record it
    // themselves via a mint hook or minter.
    mapping(uint256 => bytes32) internal _seed;

    // Attribution is a handshake. The owner LISTS creators here; each listed
    // creator CONFIRMS by claiming this collection in the Catalog, from their
    // own address. isConfirmedCreator is the live intersection. Neither side
    // can fake the other, so credit is squat-proof without a shared registry.
    address internal _catalog; // Catalog singleton; 0 disables confirmation
    mapping(address => bool) public isListedCreator;

    constructor() {
        _disableInitializers();
    }

    function initialize(InitParams calldata p) external override initializer {
        if (p.owner == address(0)) revert OwnerRequired();
        if (p.cfg.royaltyBps > MAX_ROYALTY_BPS) revert RoyaltyTooHigh();
        if (p.cfg.mintEnd != 0 && p.cfg.mintEnd <= p.cfg.mintStart) revert BadMintWindow();
        __ERC721_init(p.name, p.symbol);
        __Ownable_init(p.owner);
        __Ownable2Step_init();
        __ReentrancyGuard_init();
        _cfg = p.cfg;
        // The renderer slot always holds a real address: the artist's choice,
        // or the factory default when they made none.
        if (p.cfg.renderer == address(0)) _cfg.renderer = p.defaultRenderer;
        if (_cfg.renderer == address(0)) revert RendererRequired();
        _catalog = p.catalog;
        for (uint256 i = 0; i < p.initialMinters.length; i++) {
            if (p.initialMinters[i] == address(0)) revert ZeroMinter();
            _minters[p.initialMinters[i]] = true;
            emit MinterSet(p.initialMinters[i], true);
        }
        for (uint256 i = 0; i < p.creators.length; i++) {
            isListedCreator[p.creators[i]] = true;
            emit CreatorListed(p.creators[i], true);
        }
        // Locks passed true mean the collection is born locked; say so.
        if (_cfg.rendererLocked) emit RendererLocked();
        if (_cfg.supplyLocked) emit SupplyLocked();
        emit CollectionConfigured(idMode(), p.cfg.price, p.cfg.supplyCap, p.cfg.mintStart, p.cfg.mintEnd);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Form-specific facts, answered by each final
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Which kind of collection this is — a fact of the contract, not
    ///         a setting.
    function idMode() public pure virtual override returns (IdMode);

    /// @dev What the supply cap is measured against: mints-ever (sequential)
    ///      or live supply (pooled).
    function _capUsage() internal view virtual returns (uint256);

    /// @dev Whether a full cap closes the collection for good. True only in
    ///      the sequential final — a pooled cap frees room again on burn.
    function _capFilled() internal view virtual returns (bool);

    /// @dev Who may burn `tokenId`, given its current owner.
    function _burnAuthorized(address tokenOwner, uint256 tokenId) internal view virtual returns (bool);

    // ─────────────────────────────────────────────────────────────────────────
    // Shared mint plumbing (the finals own the entrypoints)
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Ownership + entropy, the shared per-token effects. OZ _mint
    ///      reverts on an existing id — that single check is the pooled-form
    ///      correctness argument: a live id can never be minted over.
    function _mintOne(address to, uint256 tokenId) internal {
        uint256 mintIndex = _mintedEver;
        _mintedEver = mintIndex + 1;
        _mint(to, tokenId);
        // The canonical seed: a pure function of public chain state and token
        // identity. No recipient — mixing the minter's address into entropy
        // is an opinion the artist never chose, and a wallet-grinding surface
        // besides. mintIndex is what re-rolls a pooled re-mint of the same
        // id. Spec: docs/injection-convention.md.
        _seed[tokenId] = keccak256(abi.encode(block.prevrandao, address(this), tokenId, mintIndex));
    }

    /// @notice Burn a token. Authority is the final's answer: owner-or-
    ///         approved in the sequential form; authorized minters only in
    ///         the pooled form (the minter owns the id pool and any backing,
    ///         so nobody can strand it from outside). The burned instance's
    ///         seed stays readable until a pooled re-mint overwrites it.
    function burn(uint256 tokenId) external override nonReentrant {
        address tokenOwner = _requireOwned(tokenId);
        if (!_burnAuthorized(tokenOwner, tokenId)) revert NotAuthorized();
        _burn(tokenId);
        _burnedCount += 1;
        emit Burned(tokenId);
    }

    /// @dev The cap measures whatever the final says it measures (see
    ///      _capUsage). Same check, different meaning, on purpose: an edition
    ///      of 100 is 100 forever; a pool of 100 is 100 alive at once.
    function _checkCap(uint256 quantity) internal view {
        uint256 cap = _cfg.supplyCap;
        if (cap == 0) return;
        uint256 attempted = _capUsage() + quantity;
        if (attempted > cap) revert ExceedsCap(cap, attempted);
    }

    function _runBeforeHook(
        address minter,
        uint256 quantity,
        uint256 firstTokenId,
        address referrer,
        bytes memory hookData
    ) internal {
        address hook = _cfg.mintHook;
        if (hook == address(0)) return;
        bytes4 answer = IMintHook(hook).beforeMint(minter, quantity, firstTokenId, referrer, hookData);
        if (answer != IMintHook.beforeMint.selector) revert HookRejected();
    }

    function _runAfterHook(
        address minter,
        uint256 quantity,
        uint256 firstTokenId,
        address referrer,
        bytes memory hookData
    ) internal {
        address hook = _cfg.mintHook;
        if (hook != address(0)) {
            IMintHook(hook).afterMint(minter, quantity, firstTokenId, referrer, hookData);
        }
    }

    /// @dev Accrue `total` split between the referral share and the artist.
    ///      referrer 0 folds the whole amount to the artist. No external call
    ///      here; recipients claim via withdraw().
    function _settle(uint256 total, address referrer) internal {
        if (total == 0) return;
        _totalPending += total;
        uint256 referralCut = referrer == address(0) ? 0 : (total * REFERRAL_SHARE_BPS) / BPS;
        if (referralCut > 0) {
            _pending[referrer] += referralCut;
            emit ReferralPaid(referrer, referralCut);
        }
        uint256 artistCut = total - referralCut;
        if (artistCut > 0) {
            _pending[_cfg.payoutAddress == address(0) ? owner() : _cfg.payoutAddress] += artistCut;
        }
    }

    /// @notice Send `account` what it is owed. Anyone may pull the trigger;
    ///         the money only ever goes to the owed address.
    function withdraw(address account) external override nonReentrant {
        if (account == address(0)) revert ZeroAccount();
        uint256 amount = _pending[account];
        if (amount == 0) revert NothingToWithdraw();
        _pending[account] = 0;
        _totalPending -= amount;
        (bool ok,) = payable(account).call{value: amount}("");
        if (!ok) revert WithdrawFailed();
        emit Withdrawn(account, amount);
    }

    function pendingWithdrawal(address account) external view override returns (uint256) {
        return _pending[account];
    }

    /// @notice Sweep ONLY ETH nobody is owed (force-fed via selfdestruct).
    ///         Everything up to _totalPending stays put.
    function rescueStrayETH(address to) external override onlyOwnerOrAdmin nonReentrant {
        if (to == address(0)) revert ZeroAccount();
        uint256 stray = address(this).balance - _totalPending;
        if (stray == 0) revert NoStrayETH();
        (bool ok,) = payable(to).call{value: stray}("");
        if (!ok) revert RescueFailed();
        emit StrayETHRescued(to, stray);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Admins (owner-managed operational delegates)
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev The owner, or anyone the owner granted a key. Gates every
    ///      management function except admin management and ownership
    ///      transfer, which stay with the owner.
    modifier onlyOwnerOrAdmin() {
        if (msg.sender != owner() && !_admins[msg.sender]) revert NotAuthorized();
        _;
    }

    /// @notice Grant an admin (owner-only). Reverts on the zero address and
    ///         on a duplicate grant, so every grant is one explicit state
    ///         change with one matching event.
    function addAdmin(address account) external override onlyOwner {
        if (account == address(0)) revert ZeroAccount();
        if (_admins[account]) revert AlreadyAdmin();
        _admins[account] = true;
        emit AdminSet(account, true);
    }

    /// @notice Revoke an admin. The owner may remove anyone; an admin may
    ///         renounce itself (giving up a key never needs permission).
    ///         Reverts NotAnAdmin when there is no grant to remove, so a typo
    ///         fails loudly instead of emitting a misleading event.
    function removeAdmin(address account) external override {
        if (msg.sender != owner() && msg.sender != account) revert NotAuthorized();
        if (!_admins[account]) revert NotAnAdmin();
        _admins[account] = false;
        emit AdminSet(account, false);
    }

    /// @notice Whether `account` holds an explicit admin grant. The owner is
    ///         an implicit admin and does not appear here.
    function isAdmin(address account) external view override returns (bool) {
        return _admins[account];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Config (owner root; every setter below also accepts admins)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Reschedule the built-in paid mint window: delay, extend,
    ///         shorten, or reopen. Either bound may be 0 (open immediately /
    ///         open-ended). Governs the paid path only — extension minters
    ///         keep their own schedules. Lifecycle status is derived live, so
    ///         reopening a closed window un-finalizes cleanly; each token's
    ///         recorded statusAtMint stays truthful for its own mint.
    function setMintWindow(uint64 start, uint64 end) external override onlyOwnerOrAdmin {
        if (end != 0 && end <= start) revert BadMintWindow();
        _cfg.mintStart = start;
        _cfg.mintEnd = end;
        emit MintWindowSet(start, end);
    }

    /// @notice Update the stored fixed price. Ignored while a price strategy
    ///         is set. Payment is exact-match, so a mint in flight at the old
    ///         price reverts rather than overpaying.
    function setPrice(uint256 price) external override onlyOwnerOrAdmin {
        _cfg.price = price;
        emit PriceSet(price);
    }

    /// @notice Update the EIP-2981 royalty. Same cap as init; receiver 0 =
    ///         owner().
    function setRoyalty(uint16 royaltyBps, address royaltyReceiver) external override onlyOwnerOrAdmin {
        if (royaltyBps > MAX_ROYALTY_BPS) revert RoyaltyTooHigh();
        _cfg.royaltyBps = royaltyBps;
        _cfg.royaltyReceiver = royaltyReceiver;
        emit RoyaltySet(royaltyBps, royaltyReceiver);
    }

    /// @notice Update the supply cap (0 = open supply). A cap below what
    ///         already exists is incoherent and reverts.
    function setSupplyCap(uint256 supplyCap) external override onlyOwnerOrAdmin {
        if (_cfg.supplyLocked) revert SupplyIsLocked();
        if (supplyCap != 0) {
            uint256 floor_ = _capUsage();
            if (supplyCap < floor_) revert BadSupplyCap(floor_, supplyCap);
        }
        _cfg.supplyCap = supplyCap;
        emit SupplyCapSet(supplyCap);
    }

    /// @notice One-way: lock the supply cap forever — the scarcity promise.
    ///         The cap binds every mint path, so no later minter grant can
    ///         climb over it.
    function lockSupply() external override onlyOwnerOrAdmin {
        if (_cfg.supplyLocked) revert SupplyIsLocked();
        _cfg.supplyLocked = true;
        emit SupplyLocked();
    }

    /// @dev A renderer change alters every token's metadata; ERC-4906 is the
    ///      refresh signal marketplaces actually subscribe to.
    function setRenderer(address renderer_) external override onlyOwnerOrAdmin {
        if (_cfg.rendererLocked) revert RendererIsLocked();
        if (renderer_ == address(0)) revert RendererRequired();
        _cfg.renderer = renderer_;
        emit RendererSet(renderer_);
        emit BatchMetadataUpdate(0, type(uint256).max);
    }

    function setMintHook(address hook) external override onlyOwnerOrAdmin {
        _cfg.mintHook = hook;
        emit MintHookSet(hook);
    }

    function setPriceStrategy(address strategy) external override onlyOwnerOrAdmin {
        _cfg.priceStrategy = strategy;
        emit PriceStrategySet(strategy);
    }

    /// @notice Emit an ERC-4906 refresh for changes the core cannot see: a
    ///         chain-live work whose output moved, a reveal, new captures.
    ///         Callable by the current renderer or owner/admin. Works after
    ///         lockRenderer — the lock pins the pointer, not the weather.
    ///         Pure event emission; no state is touched.
    function notifyMetadataUpdate(uint256 fromTokenId, uint256 toTokenId) external override {
        if (msg.sender != renderer() && msg.sender != owner() && !_admins[msg.sender]) {
            revert NotAuthorized();
        }
        emit BatchMetadataUpdate(fromTokenId, toTokenId);
    }

    /// @notice Grant or revoke an extension minter — the artist's visible,
    ///         onchain choice, and the lever over a minter's schedule.
    function setMinter(address minter, bool allowed) external override onlyOwnerOrAdmin {
        if (minter == address(0)) revert ZeroMinter();
        _minters[minter] = allowed;
        emit MinterSet(minter, allowed);
    }

    /// @notice Update where the artist's share accrues for FUTURE mints. Past
    ///         accruals remain claimable at the old address.
    function setPayoutAddress(address payoutAddress) external override onlyOwnerOrAdmin {
        _cfg.payoutAddress = payoutAddress;
        emit PayoutAddressSet(payoutAddress);
    }

    /// @notice The owner's side of attribution: list or unlist creators, any
    ///         time. A listing is only an assertion; a creator becomes
    ///         CONFIRMED once they also claim this collection in the Catalog.
    ///         A listed non-participant simply stays unconfirmed. owner() is
    ///         understood as a creator without being listed; listing is for
    ///         co-creators and explicit records.
    function setCreators(address[] calldata list, bool listed) external override onlyOwnerOrAdmin {
        for (uint256 i = 0; i < list.length; i++) {
            isListedCreator[list[i]] = listed;
            emit CreatorListed(list[i], listed);
        }
    }

    /// @notice Live, mutual attribution: the owner listed `who` AND `who`
    ///         claimed this collection in the Catalog. Read live, so either
    ///         side can retract and the credit goes with it — no stored
    ///         confirmation to drift. False when no Catalog is set.
    function isConfirmedCreator(address who) external view override returns (bool) {
        if (!isListedCreator[who]) return false;
        address cat = _catalog;
        return cat != address(0) && ICatalog(cat).isContractRegistered(who, address(this));
    }

    /// @notice The Catalog singleton this collection confirms creators
    ///         against (0 = confirmation disabled).
    function catalog() external view override returns (address) {
        return _catalog;
    }

    /// @notice One-way, optional: pin the renderer pointer forever, so this
    ///         exact contract answers tokenURI for good. The core cannot
    ///         attest what a renderer does inside — an immutable renderer
    ///         behind a locked pointer is full presentation permanence; a
    ///         mutable one behind a locked pointer is the artist's explicit,
    ///         inspectable choice. Not locked by default.
    function lockRenderer() external override onlyOwnerOrAdmin {
        if (_cfg.rendererLocked) revert RendererIsLocked();
        _cfg.rendererLocked = true;
        emit RendererLocked();
    }

    /// @notice Disabled. Renouncing would orphan the collection: proceeds
    ///         would accrue to owner() == address(0) and every lever would
    ///         brick. Immutability comes from the clone having no upgrade
    ///         path, not from burning the owner.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Provenance + reads
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Mint-time entropy, stamped in the mint transaction. Derived
    ///         from prevrandao: unpredictable enough for art, not for
    ///         lotteries. Readable for a burned id until a pooled re-mint
    ///         overwrites it.
    function tokenSeed(uint256 tokenId) external view override returns (bytes32) {
        bytes32 seed = _seed[tokenId];
        if (seed == bytes32(0)) revert NeverMinted();
        return seed;
    }

    /// @dev Status is a pure function of the window, the cap, and the clock.
    ///      Nothing stored, nothing to drift: change the window and the
    ///      status follows. Scheduled — before mintStart (the paid path
    ///      reverts, but an extension minter may mint, and its event
    ///      truthfully says Scheduled). Closed — the window passed, or the
    ///      final says its cap closed it. Open — otherwise.
    function _lifecycleStatus() internal view returns (CollectionStatus) {
        if (_cfg.mintStart != 0 && block.timestamp < _cfg.mintStart) {
            return CollectionStatus.Scheduled;
        }
        if (_cfg.mintEnd != 0 && block.timestamp >= _cfg.mintEnd) return CollectionStatus.Closed;
        if (_capFilled()) return CollectionStatus.Closed;
        return CollectionStatus.Open;
    }

    function totalSupply() public view returns (uint256) {
        return _mintedEver - _burnedCount;
    }

    function config()
        external
        view
        override
        returns (CollectionConfig memory cfg, CollectionStatus status, uint256 minted)
    {
        cfg = _cfg;
        status = _lifecycleStatus();
        minted = _mintedEver;
    }

    function currentPrice(address minter, uint256 quantity, bytes calldata data)
        external
        view
        override
        returns (uint256)
    {
        address strategy = _cfg.priceStrategy;
        if (strategy == address(0)) return _cfg.price * quantity;
        return IPriceStrategy(strategy).priceOf(address(this), minter, quantity, data);
    }

    function renderer() public view override returns (address) {
        return _cfg.renderer;
    }

    function mintHook() external view override returns (address) {
        return _cfg.mintHook;
    }

    function priceStrategy() external view override returns (address) {
        return _cfg.priceStrategy;
    }

    function isMinter(address minter) external view override returns (bool) {
        return _minters[minter];
    }

    function isRendererLocked() external view override returns (bool) {
        return _cfg.rendererLocked;
    }

    function isSupplyLocked() external view override returns (bool) {
        return _cfg.supplyLocked;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Metadata + royalties
    // ─────────────────────────────────────────────────────────────────────────

    function tokenURI(uint256 tokenId) public view override(ERC721Upgradeable) returns (string memory) {
        _requireOwned(tokenId);
        return IRenderer(renderer()).tokenURI(address(this), tokenId);
    }

    function contractURI() external view returns (string memory) {
        return IRenderer(renderer()).contractURI(address(this));
    }

    function royaltyInfo(uint256, uint256 salePrice) external view returns (address receiver, uint256 royaltyAmount) {
        receiver = _cfg.royaltyReceiver == address(0) ? owner() : _cfg.royaltyReceiver;
        royaltyAmount = (salePrice * _cfg.royaltyBps) / BPS;
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721Upgradeable) returns (bool) {
        return interfaceId == INTERFACE_ID_ERC2981 || interfaceId == INTERFACE_ID_ERC4906
            || super.supportsInterface(interfaceId);
    }
}
