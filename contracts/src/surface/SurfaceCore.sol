// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {ERC721Upgradeable} from "openzeppelin-contracts-upgradeable/contracts/token/ERC721/ERC721Upgradeable.sol";
import {Ownable2StepUpgradeable} from "openzeppelin-contracts-upgradeable/contracts/access/Ownable2StepUpgradeable.sol";
import {
    ReentrancyGuardUpgradeable
} from "openzeppelin-contracts-upgradeable/contracts/utils/ReentrancyGuardUpgradeable.sol";

import {ISurfaceCore} from "./interfaces/ISurfaceCore.sol";
import {IRenderer} from "./interfaces/IRenderer.sol";
import {IMintHook} from "./interfaces/IMintHook.sol";
import {IPriceStrategy} from "./interfaces/IPriceStrategy.sol";
import {ICatalog} from "./interfaces/ICatalog.sol";
import {SurfaceConfig, SurfaceStatus, IdMode, InitParams} from "./SurfaceTypes.sol";

/// @title SurfaceCore
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
///         its own final contract — Surface counts ids, PooledSurface
///         lets its minter choose them — and each ships only its own doors.
///
/// @dev    Finals deploy as immutable EIP-1167 clones: no proxy admin, no
///         upgrade path. What deploys is what runs. The OZ "Upgradeable"
///         bases are here only for their initializer pattern — a clone runs
///         no constructor — and nothing on top of them can be upgraded. The
///         core evolves by deploying new implementations and a new factory,
///         never by touching a live collection.
abstract contract SurfaceCore is
    ERC721Upgradeable,
    Ownable2StepUpgradeable,
    ReentrancyGuardUpgradeable,
    ISurfaceCore
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

    /// @dev How many minters are granted right now. Kept in step with
    ///      _minters so the pooled form can enforce its one-minter limit
    ///      without walking a set.
    uint256 internal _minterCount;

    /// @dev One-way freeze of the minter set. Once true no grant or revoke
    ///      lands. A backed pooled collection sets this so no minter can be
    ///      swapped in later to retire another minter's backed tokens.
    bool internal _minterLocked;

    /// @dev Admins, granted by the owner. An admin can call every management
    ///      function the owner can, except two the owner keeps: managing the
    ///      admin set and transferring ownership. The owner stays the single
    ///      root that hands out keys and that marketplaces read as owner().
    // account => the owner that granted it (0 = not an admin). A grant is valid only while
    // _admins[account] == owner(), so an ownership transfer silently invalidates every
    // inherited grant — the new owner starts with a clean slate and re-grants deliberately.
    mapping(address => address) internal _admins;

    // The single live source of truth for every setting, including the module
    // slots and the two one-way locks. Setters edit fields in place, so
    // config() can never drift from what the contract actually uses.
    SurfaceConfig internal _cfg;

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
        // or the factory default when they made none. It must be a deployed
        // contract — a typo here plus a born-true rendererLocked would brick
        // tokenURI forever, so the mistake is refused at the door.
        if (p.cfg.renderer == address(0)) _cfg.renderer = p.defaultRenderer;
        if (_cfg.renderer == address(0)) revert RendererRequired();
        if (_cfg.renderer.code.length == 0) revert RendererNotContract(_cfg.renderer);
        // The hook and price-strategy slots are optional (0 = none), but a nonzero value
        // must be a real contract — an EOA/typo would revert every mint on the ABI-decode
        // of empty returndata. Same rule the setters enforce.
        if (_cfg.mintHook != address(0) && _cfg.mintHook.code.length == 0) revert NotAContract(_cfg.mintHook);
        if (_cfg.priceStrategy != address(0) && _cfg.priceStrategy.code.length == 0) {
            revert NotAContract(_cfg.priceStrategy);
        }
        _catalog = p.catalog;
        for (uint256 i = 0; i < p.initialMinters.length; i++) {
            address m = p.initialMinters[i];
            if (m == address(0)) revert ZeroMinter();
            if (_minters[m]) continue; // a repeated address is not a second grant
            _minters[m] = true;
            _minterCount += 1;
            emit MinterSet(m, true);
        }
        // The pooled form runs on a single minter — its burn is minter-wide,
        // so a second could retire a token the first one backs. A clone can't
        // be born over that either.
        if (idMode() == IdMode.Pooled && _minterCount > 1) revert TooManyMinters();
        for (uint256 i = 0; i < p.creators.length; i++) {
            isListedCreator[p.creators[i]] = true;
            emit CreatorListed(p.creators[i], true);
        }
        // Locks passed true mean the collection is born locked; say so.
        if (_cfg.rendererLocked) emit RendererLocked();
        if (_cfg.supplyLocked) emit SupplyLocked();
        emit SurfaceConfigured(idMode(), p.cfg.price, p.cfg.supplyCap, p.cfg.mintStart, p.cfg.mintEnd);
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
    ///         approved in the sequential form; authorized minters only in the
    ///         pooled form. The pooled form holds one minter and can freeze it
    ///         (lockMinter), so a locked backed collection has exactly one
    ///         address that can ever retire an id — its backing can't be
    ///         stranded from outside. The burned instance's seed stays readable
    ///         until a pooled re-mint overwrites it.
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
        if (msg.sender != owner() && !_isAdmin(msg.sender)) revert NotAuthorized();
        _;
    }

    /// @dev An explicit admin grant is valid only while the owner that made it is still the
    ///      owner: `_admins[account]` holds that granting owner, so an ownership transfer
    ///      invalidates every inherited grant. The nonzero check also makes a renounced
    ///      collection (owner()==0) grant nobody.
    function _isAdmin(address account) internal view returns (bool) {
        address grantedBy = _admins[account];
        return grantedBy != address(0) && grantedBy == owner();
    }

    /// @notice Grant an admin (owner-only). Reverts on the zero address and on a duplicate
    ///         grant, so every grant is one explicit state change with one matching event.
    ///         The owner is already an admin (isAdmin reads it live), so adding the current
    ///         owner is rejected. The grant is scoped to THIS owner — it stores who granted
    ///         it and stops counting the moment ownership moves on, so a new owner never
    ///         silently inherits the old owner's keys.
    function addAdmin(address account) external override onlyOwner {
        if (account == address(0)) revert ZeroAccount();
        if (account == owner() || _isAdmin(account)) revert AlreadyAdmin();
        _admins[account] = owner();
        emit AdminSet(account, true);
    }

    /// @notice Revoke an admin. The owner may remove anyone; an admin may
    ///         renounce itself (giving up a key never needs permission).
    ///         Reverts NotAnAdmin when there is no grant to remove, so a typo
    ///         fails loudly instead of emitting a misleading event.
    function removeAdmin(address account) external override {
        if (msg.sender != owner() && msg.sender != account) revert NotAuthorized();
        if (_admins[account] == address(0)) revert NotAnAdmin();
        _admins[account] = address(0);
        emit AdminSet(account, false);
    }

    /// @notice Whether `account` may use the admin-gated setters: the owner,
    ///         or anyone holding an explicit grant. The owner has held every
    ///         admin power all along (the modifier's other arm); reporting it
    ///         here keeps external checks — MURI gates registration on this
    ///         view — honest about who can act.
    function isAdmin(address account) external view override returns (bool) {
        return account == owner() || _isAdmin(account);
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
        // The window drives the live lifecycle status (Scheduled/Open/Closed), which the
        // renderer stamps into token metadata — signal marketplaces to refresh.
        emit BatchMetadataUpdate(0, type(uint256).max);
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
        // The cap decides which token is the collection's "final mint" trait — refresh.
        emit BatchMetadataUpdate(0, type(uint256).max);
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
    ///      refresh signal marketplaces subscribe to for tokens, ERC-7572 the
    ///      one for the contract-level page. The new renderer must be a
    ///      deployed contract, same rule as at init.
    function setRenderer(address renderer_) external override onlyOwnerOrAdmin {
        if (_cfg.rendererLocked) revert RendererIsLocked();
        if (renderer_ == address(0)) revert RendererRequired();
        if (renderer_.code.length == 0) revert RendererNotContract(renderer_);
        _cfg.renderer = renderer_;
        emit RendererSet(renderer_);
        emit BatchMetadataUpdate(0, type(uint256).max);
        emit ContractURIUpdated();
    }

    function setMintHook(address hook) external override onlyOwnerOrAdmin {
        // 0 = no hook; a nonzero value must be a real contract, same rule as setRenderer.
        if (hook != address(0) && hook.code.length == 0) revert NotAContract(hook);
        _cfg.mintHook = hook;
        emit MintHookSet(hook);
    }

    function setPriceStrategy(address strategy) external override onlyOwnerOrAdmin {
        // 0 = fixed price; a nonzero strategy must be a real contract.
        if (strategy != address(0) && strategy.code.length == 0) revert NotAContract(strategy);
        _cfg.priceStrategy = strategy;
        emit PriceStrategySet(strategy);
    }

    /// @notice Emit an ERC-4906 refresh for changes the core cannot see: a
    ///         chain-live work whose output moved, a reveal, new captures.
    ///         Callable by the current renderer or owner/admin. Works after
    ///         lockRenderer — the lock pins the pointer, not the weather.
    ///         Pure event emission; no state is touched.
    function notifyMetadataUpdate(uint256 fromTokenId, uint256 toTokenId) external override {
        if (msg.sender != renderer() && msg.sender != owner() && !_isAdmin(msg.sender)) {
            revert NotAuthorized();
        }
        emit BatchMetadataUpdate(fromTokenId, toTokenId);
    }

    /// @notice Grant or revoke an extension minter — the artist's visible,
    ///         onchain choice, and the lever over a minter's schedule. Reverts
    ///         once the minter set is locked. The pooled form holds one minter
    ///         at a time, so a redundant call is a no-op rather than a way to
    ///         drift the count.
    function setMinter(address minter, bool allowed) external override {
        _requireMinterAuthority();
        if (minter == address(0)) revert ZeroMinter();
        if (_minterLocked) revert MinterIsLocked();
        if (_minters[minter] == allowed) return; // already in the asked-for state
        _minters[minter] = allowed;
        if (allowed) {
            _minterCount += 1;
            if (idMode() == IdMode.Pooled && _minterCount > 1) revert TooManyMinters();
        } else {
            _minterCount -= 1;
        }
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

    /// @notice One-way, optional: freeze the minter set forever. For a backed
    ///         pooled collection this is the promise that no minter can be
    ///         swapped in later to retire another minter's backed tokens — set
    ///         it once the intended minter is wired. Redundant on a collection
    ///         with no extension minters, but harmless.
    function lockMinter() external override {
        _requireMinterAuthority();
        if (_minterLocked) revert MinterIsLocked();
        _minterLocked = true;
        emit MinterLocked();
    }

    /// @dev Authorize a minter-set change. A pooled collection backs real value through its
    ///      single minter, so swapping or locking it is OWNER-ONLY — a delegated admin must
    ///      never be able to rotate the minter and burn another minter's backed tokens (the
    ///      pooled stranded-escrow rug). A sequential collection carries no backing, so
    ///      owner-or-admin is fine there, matching every other management setter.
    function _requireMinterAuthority() internal view {
        if (idMode() == IdMode.Pooled) {
            if (msg.sender != owner()) revert NotAuthorized();
        } else if (msg.sender != owner() && !_isAdmin(msg.sender)) {
            revert NotAuthorized();
        }
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
    function _lifecycleStatus() internal view returns (SurfaceStatus) {
        if (_cfg.mintStart != 0 && block.timestamp < _cfg.mintStart) {
            return SurfaceStatus.Scheduled;
        }
        if (_cfg.mintEnd != 0 && block.timestamp >= _cfg.mintEnd) return SurfaceStatus.Closed;
        if (_capFilled()) return SurfaceStatus.Closed;
        return SurfaceStatus.Open;
    }

    function totalSupply() public view returns (uint256) {
        return _mintedEver - _burnedCount;
    }

    function config()
        external
        view
        override
        returns (SurfaceConfig memory cfg, SurfaceStatus status, uint256 minted)
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

    function isMinterLocked() external view override returns (bool) {
        return _minterLocked;
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
