// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {ERC721Upgradeable} from
    "openzeppelin-contracts-upgradeable/contracts/token/ERC721/ERC721Upgradeable.sol";
import {Ownable2StepUpgradeable} from
    "openzeppelin-contracts-upgradeable/contracts/access/Ownable2StepUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from
    "openzeppelin-contracts-upgradeable/contracts/utils/ReentrancyGuardUpgradeable.sol";

import {ICollection} from "./interfaces/ICollection.sol";
import {IRenderer} from "./interfaces/IRenderer.sol";
import {IMintHook} from "./interfaces/IMintHook.sol";
import {IPriceStrategy} from "./interfaces/IPriceStrategy.sol";
import {ICatalog} from "./interfaces/ICatalog.sol";
import {CollectionConfig, CollectionStatus, IdMode, InitParams} from "./CollectionTypes.sol";

/// @title Collection
/// @notice One artist collection. An OZ ERC721 where every minted token keeps
///         its own identity: mint-time entropy (tokenSeed), with the rest of
///         its provenance derivable (sequential order IS the id) or stamped
///         into the Minted event. Honest
///         pricing: the collector pays exactly the resolved price. A fixed
///         protocol Referral Share is paid out of that price to whoever hosts
///         the mint (PND on PND; the artist on their own site; folded back to
///         the artist on a direct mint).
///
///         The core holds ownership, money paths, and the per-token seed
///         only — NO presentation data. tokenURI/contractURI defer wholly to
///         the renderer slot; the work config, cover art, and captures live
///         in renderer-land (GenerativeRenderer's work registry,
///         RenderAssets). The artist may pin the renderer pointer forever
///         with lockRenderer(). All other variability lives in the four
///         slots (renderer, price strategy, mint hook, extension minters)
///         and optional companion contracts.
///
/// @dev    Deployed as an immutable EIP-1167 clone. No proxy admin, no
///         upgrade path, no seal: what deploys is what runs, forever. The
///         upgradeable-variant base contracts are used only for their
///         initializer pattern, which clones require.
// Collection deliberately does NOT inherit ICollectionView. That
// interface is the renderer-side typing of this contract's public surface;
// inheriting it would force passthrough re-overrides of name/symbol/owner
// against the OZ bases for zero behavior. The read surface is exercised
// directly against this contract by every renderer that reads it.
//
// On the "Upgradeable" bases below: these are OpenZeppelin's initializer-based
// variants (an `initialize()` in place of a constructor). They are used ONLY
// because an EIP-1167 clone runs no constructor and must set up its per-clone
// storage after deploy via `initialize()`. They do NOT make this contract
// upgradeable: there is no proxy admin, no UUPS / `upgradeTo`, no
// `_authorizeUpgrade`. A deployed collection is immutable — the core evolves
// only by deploying a new implementation + factory version, never by changing
// a live collection.
contract Collection is
    ERC721Upgradeable, // initializer-based ERC721 for the clone — NOT an upgrade proxy
    Ownable2StepUpgradeable,
    ReentrancyGuardUpgradeable,
    ICollection
{
    uint16 private constant BPS = 10_000;
    /// @notice Fixed protocol referral share: 10%. Paid to the mint referrer
    ///         (PND on PND, the artist on their own site). Not artist-set.
    uint16 public constant REFERRAL_SHARE_BPS = 1_000;
    /// @notice Hard ceiling on the artist-set EIP-2981 royalty (50%). 2981 is
    ///         advisory, but a sane cap avoids a footgun, and a permissionless
    ///         deployer setting an absurd royalty on a collection owned by
    ///         someone else.
    uint16 private constant MAX_ROYALTY_BPS = 5_000;
    bytes4 private constant INTERFACE_ID_ERC2981 = 0x2a55205a;
    bytes4 private constant INTERFACE_ID_ERC4906 = 0x49064906;

    // One-way locks over state the core actually owns. Renderer-side
    // permanence (the work config) is the renderer's own offer — e.g.
    // GenerativeRenderer's per-collection work lock.
    bool private _rendererLocked;
    bool private _supplyLocked;

    // Pull-payment balances: mint accrues here; recipients claim via
    // withdraw(). No external transfer happens during mint, so a reverting
    // recipient can never brick minting. Overpayment on a dynamic-priced mint
    // accrues back to the payer the same way.
    mapping(address => uint256) private _pending;
    // Running sum of every _pending balance; rescueStrayETH may only sweep the
    // surplus above it, so owed balances are untouchable.
    uint256 private _totalPending;

    address public defaultRenderer; // canonical fallback, set at init

    /// @dev Extension minters, granted explicitly by the owner. They may call
    ///      mintTo/mintToId (non-payable); all value handling is theirs.
    mapping(address => bool) private _minters;

    /// @dev Admins, granted by the owner via addAdmin/removeAdmin. An admin may
    ///      call every management function the owner can, with two exceptions
    ///      reserved to the owner: managing the admin set (addAdmin/removeAdmin)
    ///      and transferring ownership. That keeps the owner the single root
    ///      that hands out and revokes keys and that marketplaces read as
    ///      owner(). Owner is an implicit admin. A grant is a bare mapping flag,
    ///      revocable any time.
    mapping(address => bool) private _admins;
    CollectionConfig private _cfg;

    // Mints ever (both modes; assigns mintIndex). Burns never decrement it.
    // In Sequential mode the next id to assign is `_mintedEver + 1` (ids run
    // 1,2,3..., never recycle), so there is no separate id counter to keep in
    // sync — the mint order and the id are one number.
    uint256 private _mintedEver;
    uint256 private _burnedCount;

    // Current instance's entropy. The ONLY per-token provenance the core
    // stores: it is the render input that can never be retrofitted, and a
    // nonzero seed doubles as the was-ever-minted sentinel (keccak output is
    // never zero). Everything else derives (sequential order == tokenId) or
    // lives in the Minted event. Works needing more mint-time data (block,
    // pooled order) record it themselves via a mint hook or minter.
    mapping(uint256 => bytes32) private _seed;

    // Attribution — the work's side of a two-sided handshake. The owner LISTS
    // creators here (their assertion); each listed creator CONFIRMS by claiming
    // this collection in the Catalog (their assertion, from their own address).
    // isConfirmedCreator is the live intersection: listed AND claimed. Neither
    // side can fake the other — a rando can't be listed, and a listed
    // non-participant never claims — so credit is squat- and false-credit-proof
    // without any shared registry. Catalog is read, never written.
    address private _catalog; // Catalog singleton; 0 disables confirmation
    mapping(address => bool) public isListedCreator;

    constructor() {
        _disableInitializers();
    }

    function initialize(InitParams calldata p) external override initializer {
        if (!(p.owner != address(0))) revert OwnerRequired();
        if (!(p.defaultRenderer != address(0))) revert RendererRequired();
        if (!(p.cfg.royaltyBps <= MAX_ROYALTY_BPS)) revert RoyaltyTooHigh();
        if (!(p.cfg.mintEnd == 0 || p.cfg.mintEnd > p.cfg.mintStart)) revert BadMintWindow();
        __ERC721_init(p.name, p.symbol);
        __Ownable_init(p.owner);
        __Ownable2Step_init();
        __ReentrancyGuard_init();
        // _cfg is the single live source of truth for every setting, including
        // the module slots; setters write these fields in place, so config()
        // can never drift from what the contract actually uses.
        _cfg = p.cfg;
        defaultRenderer = p.defaultRenderer;
        _catalog = p.catalog;
        for (uint256 i = 0; i < p.initialMinters.length; i++) {
            if (!(p.initialMinters[i] != address(0))) revert ZeroMinter();
            _minters[p.initialMinters[i]] = true;
            emit MinterSet(p.initialMinters[i], true);
        }
        // Owner's side of attribution: seed the listed creators. Each still
        // confirms by claiming this collection in the Catalog.
        for (uint256 i = 0; i < p.creators.length; i++) {
            isListedCreator[p.creators[i]] = true;
            emit CreatorListed(p.creators[i], true);
        }
        emit CollectionConfigured(
            p.cfg.idMode, p.cfg.price, p.cfg.supplyCap, p.cfg.mintStart, p.cfg.mintEnd
        );
    }


    // ─────────────────────────────────────────────────────────────────────────
    // Mint: built-in paid paths (value custody stays here)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Simple mint. The referrer defaults to address(0), so the full
    ///         price goes to the artist (no referral share is taken). This is
    ///         the honest default path: a direct minter gives the artist 100%.
    function mint(uint256 quantity) external payable override nonReentrant {
        _mintPaid(quantity, address(0), "");
    }

    /// @notice Mint crediting a `referrer` its share (PND on PND, the artist on
    ///         their own self-hosted page). referrer == 0 folds the share back
    ///         to the artist. `hookData` is forwarded to the mint hook and the
    ///         price strategy (one blob, both readers).
    function mintWithReferral(uint256 quantity, address referrer, bytes calldata hookData)
        external
        payable
        override
        nonReentrant
    {
        _mintPaid(quantity, referrer, hookData);
    }

    function _mintPaid(uint256 quantity, address referrer, bytes memory hookData) private {
        if (!(quantity > 0)) revert ZeroQuantity();
        if (!(block.timestamp >= _cfg.mintStart)) revert MintNotStarted();
        if (!(_cfg.mintEnd == 0 || block.timestamp < _cfg.mintEnd)) revert MintEnded();
        // Built-in paid mints are sequential-mode sales. Pooled collections
        // sell exclusively through their authorized minter, which owns the id
        // pool.
        if (!(_cfg.idMode == IdMode.Sequential)) revert PooledSellsViaMinter();
        _checkCap(quantity);

        // Payment: exact match on the stored fixed price (honest pricing);
        // with a strategy set the price can move between quote and inclusion
        // (e.g. basefee terms), so accept >= and accrue the excess back to the
        // payer as a pull-refund. `required` is read from the strategy exactly
        // once and reused for the settle, so a misbehaving strategy can never
        // make the accounting split a figure the contract did not receive.
        uint256 required;
        address strategy = _cfg.priceStrategy;
        if (strategy == address(0)) {
            required = _cfg.price * quantity;
            if (!(msg.value == required)) revert WrongPayment();
        } else {
            required =
                IPriceStrategy(strategy).priceOf(address(this), msg.sender, quantity, hookData);
            if (!(msg.value >= required)) revert Underpayment();
            uint256 excess = msg.value - required;
            if (excess > 0) {
                _pending[msg.sender] += excess;
                _totalPending += excess;
            }
        }

        // Sequential id == mint order + 1; the next id is mints-ever + 1.
        uint256 firstMintIndex = _mintedEver;
        uint256 firstTokenId = firstMintIndex + 1;
        _runBeforeHook(msg.sender, quantity, firstTokenId, referrer, hookData);

        CollectionStatus statusAtMint = _statusForMark(); // always Open here
        for (uint256 i = 0; i < quantity; i++) {
            _mintOne(msg.sender, firstTokenId + i);
        }

        _settle(required, referrer);
        _runAfterHook(msg.sender, quantity, firstTokenId, referrer, hookData);

        emit Minted(msg.sender, referrer, firstTokenId, quantity, firstMintIndex, statusAtMint);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Mint: extension path (economics live in the authorized minter)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Sequential mode only. Non-payable: the calling minter carries
    ///         all value handling (and, if it takes payment, honors the
    ///         referral share by convention). Hooks run here too, so gating
    ///         composes with custom minters. Cap and id assignment are
    ///         enforced exactly as on the paid path; the sale window is not:
    ///         an extension minter owns its own schedule, and the artist's
    ///         lever is revoking the grant.
    function mintTo(address to, address referrer, bytes calldata hookData)
        external
        override
        nonReentrant
        returns (uint256 tokenId)
    {
        if (!(_minters[msg.sender])) revert NotMinter();
        if (!(_cfg.idMode == IdMode.Sequential)) revert PooledNeedsMintToId();
        _checkCap(1);
        uint256 mintIndex = _mintedEver;
        tokenId = mintIndex + 1; // sequential id == mint order + 1
        _runBeforeHook(to, 1, tokenId, referrer, hookData);
        CollectionStatus statusAtMint = _statusForMark();
        _mintOne(to, tokenId);
        _runAfterHook(to, 1, tokenId, referrer, hookData);
        emit Minted(to, referrer, tokenId, 1, mintIndex, statusAtMint);
    }

    /// @notice Pooled mode only: the minter supplies the id (tokenId ==
    ///         sourceId forms; id 0 is legal). A previously burned id mints
    ///         again as a NEW instance: fresh Mint Mark, fresh entropy. The
    ///         prior instance's history persists in events and offchain
    ///         indexing.
    function mintToId(address to, uint256 tokenId, address referrer, bytes calldata hookData)
        external
        override
        nonReentrant
    {
        if (!(_minters[msg.sender])) revert NotMinter();
        if (!(_cfg.idMode == IdMode.Pooled)) revert SequentialAssignsIds();
        _checkCap(1);
        _runBeforeHook(to, 1, tokenId, referrer, hookData);
        CollectionStatus statusAtMint = _statusForMark();
        uint256 mintIndex = _mintedEver;
        _mintOne(to, tokenId);
        _runAfterHook(to, 1, tokenId, referrer, hookData);
        emit Minted(to, referrer, tokenId, 1, mintIndex, statusAtMint);
    }

    /// @dev Shared per-token mint effects: ownership + entropy. OZ _mint
    ///      reverts on an existing id, which is the whole pooled-mode
    ///      correctness argument: a live id can never be minted over. The
    ///      seed is the only per-token store; order and block live in the
    ///      Minted event (and sequential order == tokenId).
    function _mintOne(address to, uint256 tokenId) private {
        uint256 mintIndex = _mintedEver;
        _mintedEver = mintIndex + 1;
        _mint(to, tokenId);
        // Canonical seed: a pure function of public chain state + token
        // identity (no recipient — mixing the minter's address into entropy
        // is an opinion the artist never chose, and adds a wallet-grinding
        // surface with zero unpredictability benefit). mintIndex is what
        // re-rolls a pooled re-mint of the same id. Documented as the
        // protocol standard in docs/injection-convention.md.
        _seed[tokenId] = keccak256(abi.encode(block.prevrandao, address(this), tokenId, mintIndex));
    }

    /// @notice Burn a token. Burn authority depends on the id mode:
    ///         - Sequential: the standard owner-or-approved burn.
    ///         - Pooled: only an authorized minter may burn. A pooled collection issues and
    ///           retires its tokens exclusively through its minter (which owns the id pool and
    ///           any per-token backing), so a holder or approved operator cannot destroy a
    ///           token out-of-band and strand its backing or desync the pool.
    ///         The Mint Mark and seed of the burned instance remain readable until (and
    ///         unless) the id is minted again in pooled mode.
    function burn(uint256 tokenId) external override nonReentrant {
        address tokenOwner = _requireOwned(tokenId);
        if (_cfg.idMode == IdMode.Pooled) {
            if (!_minters[msg.sender]) revert NotAuthorized();
        } else if (!_isAuthorized(tokenOwner, msg.sender, tokenId)) {
            revert NotAuthorized();
        }
        _burn(tokenId);
        _burnedCount += 1;
        emit Burned(tokenId);
    }

    /// @dev Supply cap semantics differ by id mode, deliberately:
    ///      Sequential: the cap bounds mints EVER (an edition of 100 is 100,
    ///      burns do not free new slots). Pooled: the cap bounds LIVE supply
    ///      (redeem returns an id to the pool; the structural bound is the
    ///      pool itself, enforced by the minter).
    function _checkCap(uint256 quantity) private view {
        uint256 cap = _cfg.supplyCap;
        if (cap == 0) return;
        if (_cfg.idMode == IdMode.Sequential) {
            if (!(_mintedEver + quantity <= cap)) revert ExceedsCap();
        } else {
            if (!(totalSupply() + quantity <= cap)) revert ExceedsCap();
        }
    }

    /// @dev The truthful lifecycle status stamped into a Mint Mark. On the paid
    ///      path this is always Open: the window/cap checks above already reverted
    ///      Scheduled (MintNotStarted) and Closed (MintEnded / cap). On the
    ///      extension path all three are possible and correct: Scheduled for an
    ///      early mint before the public window opens, and Closed for a pooled
    ///      re-mint after the window (a redeem cycle) — each a legitimate mint
    ///      whose mark should say so.
    function _statusForMark() private view returns (CollectionStatus) {
        return _lifecycleStatus();
    }

    function _runBeforeHook(
        address minter,
        uint256 quantity,
        uint256 firstTokenId,
        address referrer,
        bytes memory hookData
    ) private {
        address hook = _cfg.mintHook;
        if (hook != address(0)) {
            if (!(IMintHook(hook).beforeMint(minter, quantity, firstTokenId, referrer, hookData)
                    == IMintHook.beforeMint.selector)) revert HookRejected();
        }
    }

    function _runAfterHook(
        address minter,
        uint256 quantity,
        uint256 firstTokenId,
        address referrer,
        bytes memory hookData
    ) private {
        address hook = _cfg.mintHook;
        if (hook != address(0)) {
            IMintHook(hook).afterMint(minter, quantity, firstTokenId, referrer, hookData);
        }
    }

    /// @dev Accrue `total` (pull-payment) split between the referral share and
    ///      the artist payout. referrer == 0 folds the whole amount to the
    ///      artist. No external call here; recipients claim via withdraw(), so
    ///      a reverting recipient can never brick a mint.
    function _settle(uint256 total, address referrer) private {
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

    /// @notice Withdraw the balance owed to `account`, to `account`.
    ///         Permissionless trigger; funds only ever go to the owed address.
    function withdraw(address account) external override nonReentrant {
        if (!(account != address(0))) revert ZeroAccount();
        uint256 amount = _pending[account];
        if (!(amount > 0)) revert NothingToWithdraw();
        _pending[account] = 0;
        _totalPending -= amount;
        (bool ok,) = payable(account).call{value: amount}("");
        if (!(ok)) revert WithdrawFailed();
        emit Withdrawn(account, amount);
    }

    function pendingWithdrawal(address account) external view override returns (uint256) {
        return _pending[account];
    }

    /// @notice Sweep ONLY ETH that is not owed to any payee (e.g. force-fed via
    ///         selfdestruct). Pull-payment balances are untouchable: only the
    ///         surplus above _totalPending is ever sent.
    function rescueStrayETH(address to) external override onlyOwnerOrAdmin nonReentrant {
        if (!(to != address(0))) revert ZeroAccount();
        uint256 stray = address(this).balance - _totalPending;
        if (!(stray > 0)) revert NoStrayETH();
        (bool ok,) = payable(to).call{value: stray}("");
        if (!(ok)) revert RescueFailed();
        emit StrayETHRescued(to, stray);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Admins (owner-managed operational delegates)
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Owner is always authorized; additionally any address the owner has
    ///      granted via addAdmin. Gates every management function except admin
    ///      management (addAdmin/removeAdmin) and ownership transfer, which stay
    ///      owner-only.
    modifier onlyOwnerOrAdmin() {
        if (msg.sender != owner() && !_admins[msg.sender]) revert NotAuthorized();
        _;
    }

    /// @notice Grant an admin. An admin can call every management function the
    ///         owner can, except managing admins (addAdmin/removeAdmin) and
    ///         transferring ownership. Owner-only. Reverts if `account` is the
    ///         zero address or is already an admin (so every grant is an
    ///         explicit, single state change with a matching event).
    function addAdmin(address account) external override onlyOwner {
        if (!(account != address(0))) revert ZeroAccount();
        if (_admins[account]) revert AlreadyAdmin();
        _admins[account] = true;
        emit AdminSet(account, true);
    }

    /// @notice Revoke an admin. The owner may remove any admin; an admin may
    ///         renounce itself by passing its own address (self-removal only
    ///         reduces privilege, so no escalation is possible). Any other
    ///         caller reverts NotAuthorized. Reverts NotAnAdmin if `account` is
    ///         not currently an admin, so a typo or double-remove fails loudly
    ///         rather than emitting a misleading event. Removing every admin is
    ///         safe: the owner keeps full access, so there is no last-admin
    ///         lockout to guard against.
    function removeAdmin(address account) external override {
        if (msg.sender != owner() && msg.sender != account) revert NotAuthorized();
        if (!(_admins[account])) revert NotAnAdmin();
        _admins[account] = false;
        emit AdminSet(account, false);
    }

    /// @notice Whether `account` holds an explicit admin grant. Owner is an
    ///         implicit admin and is not required to appear here.
    function isAdmin(address account) external view override returns (bool) {
        return _admins[account];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Config (owner root; every setter below also accepts admins)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Reschedule the built-in paid mint window. Same validation as init
    ///         (BadMintWindow unless end == 0 or end > start); either bound may be
    ///         0 to mean "open immediately" / "open-ended". This is the artist's
    ///         lever to delay, extend, shorten, or reopen the public sale after
    ///         deploy. It governs ONLY the built-in paid path — extension minters
    ///         own their own schedules. `isFinal` on Mint Marks is derived live,
    ///         so reopening a closed window correctly un-finalizes prior tokens;
    ///         each token's recorded statusAtMint stays truthful for its own mint.
    function setMintWindow(uint64 start, uint64 end) external override onlyOwnerOrAdmin {
        if (!(end == 0 || end > start)) revert BadMintWindow();
        _cfg.mintStart = start;
        _cfg.mintEnd = end;
        emit MintWindowSet(start, end);
    }

    /// @notice Update the stored fixed price. Ignored while a price strategy is
    ///         set. Exact-match payment on the paid path means an in-flight
    ///         mint priced against the old value reverts rather than overpays.
    function setPrice(uint256 price) external override onlyOwnerOrAdmin {
        _cfg.price = price;
        emit PriceSet(price);
    }

    /// @notice Update the EIP-2981 royalty (advisory to marketplaces). Same cap
    ///         as init; receiver 0 = owner().
    function setRoyalty(uint16 royaltyBps, address royaltyReceiver)
        external
        override
        onlyOwnerOrAdmin
    {
        if (!(royaltyBps <= MAX_ROYALTY_BPS)) revert RoyaltyTooHigh();
        _cfg.royaltyBps = royaltyBps;
        _cfg.royaltyReceiver = royaltyReceiver;
        emit RoyaltySet(royaltyBps, royaltyReceiver);
    }

    /// @notice Update the supply cap (0 = open supply). A cap below what
    ///         already exists is incoherent and reverts: mints-ever in
    ///         sequential mode (ids are never reused), live supply in pooled.
    function setSupplyCap(uint256 supplyCap) external override onlyOwnerOrAdmin {
        if (_supplyLocked) revert SupplyIsLocked();
        if (supplyCap != 0) {
            uint256 floor_ = _cfg.idMode == IdMode.Sequential ? _mintedEver : totalSupply();
            if (!(supplyCap >= floor_)) revert BadSupplyCap();
        }
        _cfg.supplyCap = supplyCap;
        emit SupplyCapSet(supplyCap);
    }

    /// @notice One-way: permanently lock the supply cap — the scarcity promise,
    ///         alongside the renderer-side work lock and lockRenderer (the
    ///         presentation). The cap binds extension minters too (_checkCap
    ///         runs on every mint path), so a locked cap is a hard ceiling no
    ///         matter what minters are granted later.
    function lockSupply() external override onlyOwnerOrAdmin {
        if (_supplyLocked) revert SupplyIsLocked();
        _supplyLocked = true;
        emit SupplyLocked();
    }

    /// @dev Renderer/work changes alter every token's metadata; ERC-4906 is the
    ///      refresh signal marketplaces actually subscribe to.
    function setRenderer(address renderer_) external override onlyOwnerOrAdmin {
        if (_rendererLocked) revert RendererIsLocked();
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

    /// @notice Emit an ERC-4906 refresh for metadata changes the core cannot
    ///         observe: a chain-live work whose output moved with chain state,
    ///         a reveal, refreshed captures in RenderAssets. Callable by the
    ///         current renderer or owner/admin. Deliberately works after
    ///         lockRenderer — the lock pins the pointer, but a locked
    ///         chain-live work still legitimately changes output.
    ///         Pure event emission; no state is touched.
    function notifyMetadataUpdate(uint256 fromTokenId, uint256 toTokenId) external override {
        if (msg.sender != renderer() && msg.sender != owner() && !_admins[msg.sender]) {
            revert NotAuthorized();
        }
        emit BatchMetadataUpdate(fromTokenId, toTokenId);
    }

    /// @notice Grant or revoke an extension minter. Explicit, per-minter,
    ///         evented: authorizing a minter is the artist's visible, onchain
    ///         choice, and revoking it is the artist's lever over a minter's
    ///         schedule and behavior.
    function setMinter(address minter, bool allowed) external override onlyOwnerOrAdmin {
        if (!(minter != address(0))) revert ZeroMinter();
        _minters[minter] = allowed;
        emit MinterSet(minter, allowed);
    }

    /// @notice Update where the artist's share accrues for FUTURE mints. Past
    ///         accruals remain claimable at the old address.
    function setPayoutAddress(address payoutAddress) external override onlyOwnerOrAdmin {
        _cfg.payoutAddress = payoutAddress;
        emit PayoutAddressSet(payoutAddress);
    }

    /// @notice The owner's side of attribution: list (or unlist) creators.
    ///         Mutable — collaborators can be added or corrected any time. A
    ///         listing is only an assertion; a creator becomes CONFIRMED only
    ///         once they also claim this collection in the Catalog, so a listed
    ///         non-participant simply shows as listed-but-unconfirmed. `owner()`
    ///         is the deployer and need not be listed to be understood as a
    ///         creator; listing is for co-creators and explicit records.
    function setCreators(address[] calldata list, bool listed)
        external
        override
        onlyOwnerOrAdmin
    {
        for (uint256 i = 0; i < list.length; i++) {
            isListedCreator[list[i]] = listed;
            emit CreatorListed(list[i], listed);
        }
    }

    /// @notice Live, mutual attribution: true iff the owner has listed `who`
    ///         AND `who` has claimed this collection in the Catalog. Reading
    ///         the Catalog live means retracting either side (unlist, or
    ///         un-claim in the Catalog) cleanly revokes credit — no stored
    ///         confirmation to drift. Returns false when no Catalog is set.
    function isConfirmedCreator(address who) external view override returns (bool) {
        if (!isListedCreator[who]) return false;
        address cat = _catalog;
        return cat != address(0) && ICatalog(cat).isContractRegistered(who, address(this));
    }

    /// @notice The Catalog singleton this collection confirms creators against
    ///         (0 = confirmation disabled).
    function catalog() external view override returns (address) {
        return _catalog;
    }

    /// @notice One-way, optional: permanently pin the renderer pointer, so
    ///         tokenURI is answered by this exact renderer contract forever.
    ///         The core cannot attest what the renderer does internally — an
    ///         immutable renderer plus a locked pointer is full presentation
    ///         permanence; a mutable renderer with a locked pointer is the
    ///         artist's explicit, inspectable choice. Not locked by default.
    function lockRenderer() external override onlyOwnerOrAdmin {
        if (_rendererLocked) revert RendererIsLocked();
        _rendererLocked = true;
        emit RendererLocked();
    }



    /// @notice Disabled. Renouncing would orphan the collection: default
    ///         proceeds would accrue to owner() == address(0) and every admin
    ///         lever would be permanently bricked. Immutability comes from the
    ///         clone having no upgrade path, not from burning the owner.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Provenance + reads
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Mint-time entropy of the current instance, stamped in the mint
    ///         transaction. Derived from prevrandao: acceptable unpredictability
    ///         for art, not for lotteries. Readable for a burned id until a
    ///         pooled re-mint overwrites it.
    function tokenSeed(uint256 tokenId) external view override returns (bytes32) {
        bytes32 seed = _seed[tokenId];
        if (!(seed != bytes32(0))) revert NeverMinted();
        return seed;
    }

    /// @dev "Was ever minted" (any instance): the seed is stamped on every
    ///      mint and keccak256 output is never zero, so a nonzero seed is the
    ///      existence sentinel — no separate record needed.
    function _wasMinted(uint256 tokenId) internal view returns (bool) {
        return _seed[tokenId] != bytes32(0);
    }

    /// @dev Status is a pure function of the window, the cap, and the current
    ///      block. Nothing here reads stored mutable state: change the clock, the
    ///      window, or the cap and the status follows. It is reported live by
    ///      config() and stamped into each Minted event; it is never stored.
    ///        Scheduled — before mintStart. The paid path reverts MintNotStarted;
    ///          an extension minter may still mint, and its Minted event
    ///          truthfully records Scheduled (minted before the public window).
    ///        Closed    — mintEnd has passed, or a sequential cap is full.
    ///        Open      — otherwise.
    function _lifecycleStatus() internal view returns (CollectionStatus) {
        if (_cfg.mintStart != 0 && block.timestamp < _cfg.mintStart) {
            return CollectionStatus.Scheduled;
        }
        if (_cfg.mintEnd != 0 && block.timestamp >= _cfg.mintEnd) return CollectionStatus.Closed;
        if (_cfg.supplyCap != 0 && _cfg.idMode == IdMode.Sequential && _mintedEver >= _cfg.supplyCap)
        {
            return CollectionStatus.Closed;
        }
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

    function referralShareBps() external pure override returns (uint16) {
        return REFERRAL_SHARE_BPS;
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



    function idMode() external view override returns (IdMode) {
        return _cfg.idMode;
    }



    function renderer() public view override returns (address) {
        return _cfg.renderer != address(0) ? _cfg.renderer : defaultRenderer;
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
        return _rendererLocked;
    }

    function isSupplyLocked() external view override returns (bool) {
        return _supplyLocked;
    }


    // ─────────────────────────────────────────────────────────────────────────
    // Metadata + royalties
    // ─────────────────────────────────────────────────────────────────────────

    function tokenURI(uint256 tokenId)
        public
        view
        override(ERC721Upgradeable)
        returns (string memory)
    {
        _requireOwned(tokenId);
        return IRenderer(renderer()).tokenURI(address(this), tokenId);
    }

    function contractURI() external view returns (string memory) {
        return IRenderer(renderer()).contractURI(address(this));
    }

    function royaltyInfo(uint256, uint256 salePrice)
        external
        view
        returns (address receiver, uint256 royaltyAmount)
    {
        receiver = _cfg.royaltyReceiver == address(0) ? owner() : _cfg.royaltyReceiver;
        royaltyAmount = (salePrice * _cfg.royaltyBps) / BPS;
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721Upgradeable)
        returns (bool)
    {
        return interfaceId == INTERFACE_ID_ERC2981 || interfaceId == INTERFACE_ID_ERC4906
            || super.supportsInterface(interfaceId);
    }
}
