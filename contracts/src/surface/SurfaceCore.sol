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
/// @notice Abstract ERC721 base for both collection forms (Surface and
///         PooledSurface). Provides ownership, payment/value custody,
///         configuration, and per-token seed storage. It has no mint
///         entrypoint; each form defines its own.
///
///         Paid mints split the price between the artist (the payout address,
///         or the owner if unset) and, when an approved referrer is named, a
///         fixed referral share. No protocol fee.
///
///         Storage per token is a single mint-time seed. Mint order, block,
///         and status are not stored; they are derived from the token id or
///         the emitted events.
///
///         Owner-settable config: renderer, price strategy, mint hook, and
///         minter set. Two are one-way locks once set: lockRenderer and
///         lockSupply. Locks passed at initialization apply from the start.
///
/// @dev    Deployed as immutable EIP-1167 clones: no proxy admin, no upgrade
///         path. The OZ upgradeable bases are used only for their initializer
///         pattern (a clone runs no constructor). New behavior ships as new
///         implementations behind a new factory, never by changing a
///         deployed collection.
abstract contract SurfaceCore is
    // The OZ "Upgradeable" bases mean initializer-based (constructor-free), which
    // is required because the finals deploy as EIP-1167 clones and a clone never
    // runs a constructor; state is set in initialize(). It does NOT mean these
    // are upgradeable: the clones are immutable, with no proxy admin and no
    // upgrade path (the implementation calls _disableInitializers). To change
    // behavior, deploy a new implementation and a new factory.
    ERC721Upgradeable,
    Ownable2StepUpgradeable,
    ReentrancyGuardUpgradeable,
    ISurfaceCore
{
    /// @notice Implementation version. 1 is the first release.
    uint256 public constant version = 1;

    uint16 internal constant BPS = 10_000;
    /// @notice Fixed referral share: 10%, paid to the referrer that hosts the
    ///         mint. Not artist-set, not a protocol fee. On a mint with no
    ///         referrer this share accrues to the artist.
    uint16 public constant override REFERRAL_SHARE_BPS = 1_000;
    /// @dev EIP-2981 is advisory. The 50% ceiling caps the royalty a
    ///      permissionless deployer can set on someone else's behalf.
    uint16 internal constant MAX_ROYALTY_BPS = 5_000;
    bytes4 internal constant INTERFACE_ID_ERC2981 = 0x2a55205a;
    bytes4 internal constant INTERFACE_ID_ERC4906 = 0x49064906;

    // Pull-payment balances: mints accrue here, recipients claim via
    // withdraw(). No external transfer during a mint, so a reverting recipient
    // cannot block minting. Overpayment on a dynamic price accrues back to the
    // payer the same way.
    mapping(address => uint256) internal _pending;
    // Sum of all _pending balances. rescueStrayETH may only sweep the balance
    // above this amount; owed funds are never swept.
    uint256 internal _totalPending;

    /// @dev Extension minters, granted explicitly by the owner. They call the
    ///      final's extension entrypoint (non-payable); they handle value
    ///      themselves.
    mapping(address => bool) internal _minters;

    /// @dev Count of currently granted minters. Kept in sync with _minters so
    ///      the pooled form can enforce its one-minter limit without iterating
    ///      the set.
    uint256 internal _minterCount;

    /// @dev One-way freeze of the minter set. Once true, no grant or revoke
    ///      succeeds. A backed pooled collection sets this so no minter can be
    ///      swapped in later to retire another minter's backed tokens.
    bool internal _minterLocked;

    /// @dev Admins, granted by the owner. An admin can call every management
    ///      function the owner can, except managing the admin set and
    ///      transferring ownership, which remain owner-only. The owner is the
    ///      single admin-granting root and the account owner() returns.
    // account => the owner that granted it (0 = not an admin). A grant is valid only while
    // _admins[account] == owner(), so an ownership transfer invalidates every inherited
    // grant; the new owner starts with no admins and re-grants explicitly.
    mapping(address => address) internal _admins;

    // Single source of truth for every setting, including the module slots and
    // the two one-way locks. Setters edit fields in place, so config() always
    // reflects what the contract uses.
    SurfaceConfig internal _cfg;

    // Total mints across the contract's lifetime, both forms. Burns do not
    // decrement it. In the sequential final the next id is _mintedEver + 1:
    // mint order and id are the same number, so there is no separate counter.
    uint256 internal _mintedEver;
    uint256 internal _burnedCount;

    // The only per-token storage: mint-time entropy, used as render input that
    // cannot be reconstructed later. keccak output is never zero, so a nonzero
    // seed also serves as the was-ever-minted sentinel. Forms needing more
    // mint-time data (block, pooled order) record it themselves via a mint
    // hook or minter.
    mapping(uint256 => bytes32) internal _seed;

    // Attribution is two-sided. The owner lists creators here; each listed
    // creator confirms by claiming this collection in the Catalog from their
    // own address. isConfirmedCreator is the intersection of the two. Neither
    // side can forge the other, so credit needs no shared registry.
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
        // The renderer slot always holds a nonzero address: the artist's
        // choice, or the factory default when unset. It must be a deployed
        // contract; a bad address combined with rendererLocked set at init
        // would brick tokenURI permanently, so it is rejected here.
        if (p.cfg.renderer == address(0)) _cfg.renderer = p.defaultRenderer;
        if (_cfg.renderer == address(0)) revert RendererRequired();
        if (_cfg.renderer.code.length == 0) revert RendererNotContract(_cfg.renderer);
        // The hook and price-strategy slots are optional (0 = none). A nonzero
        // value must be a deployed contract; an EOA or bad address would revert
        // every mint on the ABI-decode of empty returndata. Same rule the
        // setters enforce.
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
        // The pooled form allows a single minter: its burn is minter-wide, so
        // a second minter could retire a token the first one backs. Enforced at
        // init as well.
        if (idMode() == IdMode.Pooled && _minterCount > 1) revert TooManyMinters();
        for (uint256 i = 0; i < p.creators.length; i++) {
            isListedCreator[p.creators[i]] = true;
            emit CreatorListed(p.creators[i], true);
        }
        // Locks passed true apply from initialization; emit their events.
        if (_cfg.rendererLocked) emit RendererLocked();
        if (_cfg.supplyLocked) emit SupplyLocked();
        emit SurfaceConfigured(idMode(), p.cfg.price, p.cfg.supplyCap, p.cfg.mintStart, p.cfg.mintEnd);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Form-specific facts, answered by each final
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice The collection form. Fixed by the contract, not configurable.
    function idMode() public pure virtual override returns (IdMode);

    /// @dev What the supply cap is measured against: mints-ever (sequential)
    ///      or live supply (pooled).
    function _capUsage() internal view virtual returns (uint256);

    /// @dev Whether a full cap closes the collection permanently. True only in
    ///      the sequential final; a pooled cap frees room again on burn.
    function _capFilled() internal view virtual returns (bool);

    /// @dev Who may burn `tokenId`, given its current owner.
    function _burnAuthorized(address tokenOwner, uint256 tokenId) internal view virtual returns (bool);

    // ─────────────────────────────────────────────────────────────────────────
    // Shared mint plumbing (the finals own the entrypoints)
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Shared per-token effects: ownership and entropy. OZ _mint reverts
    ///      on an existing id; that check is the pooled-form correctness
    ///      guarantee, since a live id cannot be minted over.
    function _mintOne(address to, uint256 tokenId) internal {
        uint256 mintIndex = _mintedEver;
        _mintedEver = mintIndex + 1;
        _mint(to, tokenId);
        // Seed: a pure function of public chain state and token identity. The
        // recipient address is deliberately excluded, to avoid making entropy
        // depend on the minter and to avoid a wallet-grinding surface.
        // mintIndex re-rolls the seed on a pooled re-mint of the same id.
        // Spec: docs/injection-convention.md.
        _seed[tokenId] = keccak256(abi.encode(block.prevrandao, address(this), tokenId, mintIndex));
    }

    /// @notice Burn a token. Authority is defined by the final: owner-or-
    ///         approved in the sequential form; authorized minters only in the
    ///         pooled form. The pooled form holds one minter and can freeze it
    ///         (lockMinter), so a locked backed collection has exactly one
    ///         address that can retire an id; its backing cannot be stranded
    ///         from outside. The burned token's seed stays readable until a
    ///         pooled re-mint overwrites it.
    function burn(uint256 tokenId) external override nonReentrant {
        address tokenOwner = _requireOwned(tokenId);
        if (!_burnAuthorized(tokenOwner, tokenId)) revert NotAuthorized();
        _burn(tokenId);
        _burnedCount += 1;
        emit Burned(tokenId);
    }

    /// @dev The cap measures what the final defines in _capUsage. Same check,
    ///      different meaning per form: a sequential edition of 100 is 100
    ///      total; a pool of 100 is 100 live at once.
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

    /// @dev Accrue `total`, split between the referral share and the artist.
    ///      referrer 0 accrues the full amount to the artist. No external call
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

    /// @notice Send `account` its owed balance. Callable by anyone; funds go
    ///         only to the owed address.
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

    /// @notice Sweep only ETH that nobody is owed (for example, forced in via
    ///         selfdestruct). The balance up to _totalPending is not swept.
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

    /// @dev Owner or a granted admin. Gates every management function except
    ///      admin management and ownership transfer, which are owner-only.
    modifier onlyOwnerOrAdmin() {
        if (msg.sender != owner() && !_isAdmin(msg.sender)) revert NotAuthorized();
        _;
    }

    /// @dev An admin grant is valid only while the owner that made it is still
    ///      the owner: `_admins[account]` holds that granting owner, so an
    ///      ownership transfer invalidates every inherited grant. The nonzero
    ///      check also means a renounced collection (owner()==0) has no admins.
    function _isAdmin(address account) internal view returns (bool) {
        address grantedBy = _admins[account];
        return grantedBy != address(0) && grantedBy == owner();
    }

    /// @notice Grant an admin (owner-only). Reverts on the zero address and on
    ///         a duplicate grant, so each grant is one state change with one
    ///         event. The owner already counts as an admin (isAdmin reports it),
    ///         so granting the current owner is rejected. The grant is scoped to
    ///         this owner: it stores the granting owner and stops being valid
    ///         once ownership changes, so a new owner does not inherit the old
    ///         owner's admins.
    function addAdmin(address account) external override onlyOwner {
        if (account == address(0)) revert ZeroAccount();
        if (account == owner() || _isAdmin(account)) revert AlreadyAdmin();
        _admins[account] = owner();
        emit AdminSet(account, true);
    }

    /// @notice Revoke an admin. The owner may remove any admin; an admin may
    ///         remove itself. Reverts NotAnAdmin when there is no grant to
    ///         remove, so a bad address reverts instead of emitting a
    ///         misleading event.
    function removeAdmin(address account) external override {
        if (msg.sender != owner() && msg.sender != account) revert NotAuthorized();
        if (_admins[account] == address(0)) revert NotAnAdmin();
        _admins[account] = address(0);
        emit AdminSet(account, false);
    }

    /// @notice Whether `account` may use the admin-gated setters: the owner, or
    ///         any address holding a grant. The owner is included because the
    ///         onlyOwnerOrAdmin modifier also admits the owner; reporting it
    ///         here keeps external checks that gate on this view accurate.
    function isAdmin(address account) external view override returns (bool) {
        return account == owner() || _isAdmin(account);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Config (owner root; every setter below also accepts admins)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Reschedule the built-in paid mint window: delay, extend,
    ///         shorten, or reopen. Either bound may be 0 (open immediately /
    ///         open-ended). Applies to the paid path only; extension minters
    ///         keep their own schedules. Lifecycle status is derived, so
    ///         reopening a closed window returns it to Open; each token's
    ///         recorded statusAtMint is unaffected.
    function setMintWindow(uint64 start, uint64 end) external override onlyOwnerOrAdmin {
        if (end != 0 && end <= start) revert BadMintWindow();
        _cfg.mintStart = start;
        _cfg.mintEnd = end;
        emit MintWindowSet(start, end);
        // The window drives the lifecycle status (Scheduled/Open/Closed), which
        // the renderer includes in token metadata; signal marketplaces to
        // refresh.
        emit BatchMetadataUpdate(0, type(uint256).max);
    }

    /// @notice Update the stored fixed price. Ignored while a price strategy is
    ///         set. Payment is exact-match, so a mint in flight at the old price
    ///         reverts rather than overpaying.
    function setPrice(uint256 price) external override onlyOwnerOrAdmin {
        _cfg.price = price;
        emit PriceSet(price);
    }

    /// @notice Update the EIP-2981 royalty. Same cap as init; receiver 0
    ///         resolves to owner().
    function setRoyalty(uint16 royaltyBps, address royaltyReceiver) external override onlyOwnerOrAdmin {
        if (royaltyBps > MAX_ROYALTY_BPS) revert RoyaltyTooHigh();
        _cfg.royaltyBps = royaltyBps;
        _cfg.royaltyReceiver = royaltyReceiver;
        emit RoyaltySet(royaltyBps, royaltyReceiver);
    }

    /// @notice Update the supply cap (0 = no cap). A cap below current usage
    ///         reverts.
    function setSupplyCap(uint256 supplyCap) external override onlyOwnerOrAdmin {
        if (_cfg.supplyLocked) revert SupplyIsLocked();
        if (supplyCap != 0) {
            uint256 floor_ = _capUsage();
            if (supplyCap < floor_) revert BadSupplyCap(floor_, supplyCap);
        }
        _cfg.supplyCap = supplyCap;
        emit SupplyCapSet(supplyCap);
        // The cap determines which token carries the "final mint" trait;
        // refresh.
        emit BatchMetadataUpdate(0, type(uint256).max);
    }

    /// @notice One-way: lock the supply cap permanently. The cap binds every
    ///         mint path, so no later minter grant can exceed it.
    function lockSupply() external override onlyOwnerOrAdmin {
        if (_cfg.supplyLocked) revert SupplyIsLocked();
        _cfg.supplyLocked = true;
        emit SupplyLocked();
    }

    /// @dev A renderer change alters every token's metadata. ERC-4906 is the
    ///      per-token refresh signal; ERC-7572 (ContractURIUpdated) is the
    ///      contract-level one. The new renderer must be a deployed contract,
    ///      same rule as at init.
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
        // 0 = no hook; a nonzero value must be a deployed contract, same rule as setRenderer.
        if (hook != address(0) && hook.code.length == 0) revert NotAContract(hook);
        _cfg.mintHook = hook;
        emit MintHookSet(hook);
    }

    function setPriceStrategy(address strategy) external override onlyOwnerOrAdmin {
        // 0 = fixed price; a nonzero strategy must be a deployed contract.
        if (strategy != address(0) && strategy.code.length == 0) revert NotAContract(strategy);
        _cfg.priceStrategy = strategy;
        emit PriceStrategySet(strategy);
    }

    /// @notice Emit an ERC-4906 refresh for changes the core cannot observe:
    ///         an on-chain-live work whose output changed, a reveal, new
    ///         captures. Callable by the current renderer or owner/admin. Works
    ///         after lockRenderer, since the lock pins the renderer address, not
    ///         its output. Emits an event only; no state change.
    function notifyMetadataUpdate(uint256 fromTokenId, uint256 toTokenId) external override {
        if (msg.sender != renderer() && msg.sender != owner() && !_isAdmin(msg.sender)) {
            revert NotAuthorized();
        }
        emit BatchMetadataUpdate(fromTokenId, toTokenId);
    }

    /// @notice Grant or revoke an extension minter. Reverts once the minter set
    ///         is locked. The pooled form holds one minter at a time; a call
    ///         that does not change the state is a no-op, so it cannot drift the
    ///         count.
    function setMinter(address minter, bool allowed) external override {
        _requireMinterAuthority();
        if (minter == address(0)) revert ZeroMinter();
        if (_minterLocked) revert MinterIsLocked();
        if (_minters[minter] == allowed) return; // already in the requested state
        _minters[minter] = allowed;
        if (allowed) {
            _minterCount += 1;
            if (idMode() == IdMode.Pooled && _minterCount > 1) revert TooManyMinters();
        } else {
            _minterCount -= 1;
        }
        emit MinterSet(minter, allowed);
    }

    /// @notice Update where the artist's share accrues for future mints. Past
    ///         accruals remain claimable at the previous address.
    function setPayoutAddress(address payoutAddress) external override onlyOwnerOrAdmin {
        _cfg.payoutAddress = payoutAddress;
        emit PayoutAddressSet(payoutAddress);
    }

    /// @notice The owner's side of attribution: list or unlist creators at any
    ///         time. A listing is an assertion only; a creator is confirmed
    ///         once they also claim this collection in the Catalog. A listed
    ///         address that never claims stays unconfirmed. owner() counts as a
    ///         creator without being listed; listing is for co-creators and
    ///         explicit records.
    function setCreators(address[] calldata list, bool listed) external override onlyOwnerOrAdmin {
        for (uint256 i = 0; i < list.length; i++) {
            isListedCreator[list[i]] = listed;
            emit CreatorListed(list[i], listed);
        }
    }

    /// @notice Mutual attribution: the owner listed `who` and `who` claimed
    ///         this collection in the Catalog. Computed on read, so either side
    ///         can retract and the confirmation follows; nothing is stored.
    ///         False when no Catalog is set.
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

    /// @notice One-way, optional: pin the renderer address permanently, so this
    ///         renderer is the fixed tokenURI source. The core cannot attest to
    ///         a renderer's internal behavior: an immutable renderer behind a
    ///         locked address gives full presentation permanence; a mutable one
    ///         behind a locked address remains changeable within that renderer.
    ///         Not locked by default.
    function lockRenderer() external override onlyOwnerOrAdmin {
        if (_cfg.rendererLocked) revert RendererIsLocked();
        _cfg.rendererLocked = true;
        emit RendererLocked();
    }

    /// @notice One-way, optional: freeze the minter set permanently. For a
    ///         backed pooled collection this guarantees no minter can be swapped
    ///         in later to retire another minter's backed tokens; call it once
    ///         the intended minter is set. No effect on a collection with no
    ///         extension minters.
    function lockMinter() external override {
        _requireMinterAuthority();
        if (_minterLocked) revert MinterIsLocked();
        _minterLocked = true;
        emit MinterLocked();
    }

    /// @dev Authorize a minter-set change. A pooled collection backs value
    ///      through its single minter, so swapping or locking it is owner-only:
    ///      a delegated admin must not be able to rotate the minter and burn
    ///      another minter's backed tokens (the pooled stranded-escrow risk). A
    ///      sequential collection carries no backing, so owner-or-admin applies
    ///      there, matching every other management setter.
    function _requireMinterAuthority() internal view {
        if (idMode() == IdMode.Pooled) {
            if (msg.sender != owner()) revert NotAuthorized();
        } else if (msg.sender != owner() && !_isAdmin(msg.sender)) {
            revert NotAuthorized();
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Provenance + reads
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Mint-time entropy, set in the mint transaction. Derived from
    ///         prevrandao: unpredictable enough for art, not suitable for
    ///         high-value randomness such as lotteries. Readable for a burned
    ///         id until a pooled re-mint overwrites it.
    function tokenSeed(uint256 tokenId) external view override returns (bytes32) {
        bytes32 seed = _seed[tokenId];
        if (seed == bytes32(0)) revert NeverMinted();
        return seed;
    }

    /// @dev Status is a pure function of the window, the cap, and block time.
    ///      Nothing is stored: change the window and the status follows.
    ///      Scheduled: before mintStart (the paid path reverts, but an
    ///      extension minter may mint, and its event records Scheduled).
    ///      Closed: the window has passed, or the final reports its cap closed
    ///      it. Open: otherwise.
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
