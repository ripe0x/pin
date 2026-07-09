// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {ERC721Upgradeable} from
    "openzeppelin-contracts-upgradeable/contracts/token/ERC721/ERC721Upgradeable.sol";
import {Ownable2StepUpgradeable} from
    "openzeppelin-contracts-upgradeable/contracts/access/Ownable2StepUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from
    "openzeppelin-contracts-upgradeable/contracts/utils/ReentrancyGuardUpgradeable.sol";

import {ISovereignCollection} from "./interfaces/ISovereignCollection.sol";
import {IRenderer} from "./interfaces/IRenderer.sol";
import {IMintHook} from "./interfaces/IMintHook.sol";
import {IPriceStrategy} from "./interfaces/IPriceStrategy.sol";
import {IAttribution} from "./interfaces/IAttribution.sol";
import {
    CollectionConfig,
    CollectionStatus,
    IdMode,
    InitParams,
    MintRecord,
    MintMark,
    WorkConfig,
    Edge,
    EdgeType,
    Path,
    PathType,
    Ref
} from "./CollectionTypes.sol";

/// @title SovereignCollection
/// @notice One artist collection. An OZ ERC721 where every minted token keeps
///         its own identity: a per-token Mint Mark (provenance), mint-time
///         entropy (tokenSeed), and a Token Path (forward pointer). Honest
///         pricing: the collector pays exactly the resolved price. A fixed
///         protocol Surface Share is paid out of that price to whoever hosts
///         the mint (PND on PND; the artist on their own site; folded back to
///         the artist on a direct mint).
///
///         The core holds ownership, money paths, and provenance only. All
///         variability lives in four slots (renderer, price strategy, mint
///         hook, extension minters) and optional companion contracts.
///
/// @dev    Deployed as an immutable EIP-1167 clone. No proxy admin, no
///         upgrade path, no seal: what deploys is what runs, forever. The
///         upgradeable-variant base contracts are used only for their
///         initializer pattern, which clones require.
// SovereignCollection deliberately does NOT inherit ICollectionView. That
// interface is the renderer-side typing of this contract's public surface;
// inheriting it would force passthrough re-overrides of name/symbol/owner
// against the OZ bases for zero behavior. The read surface is exercised
// directly against this contract by every renderer that reads it.
contract SovereignCollection is
    ERC721Upgradeable,
    Ownable2StepUpgradeable,
    ReentrancyGuardUpgradeable,
    ISovereignCollection
{
    uint16 private constant BPS = 10_000;
    /// @notice Fixed protocol surface share: 10%. Paid to the mint surface
    ///         (PND on PND, the artist on their own site). Not artist-set.
    uint16 public constant SURFACE_SHARE_BPS = 1_000;
    /// @notice Hard ceiling on the artist-set EIP-2981 royalty (50%). 2981 is
    ///         advisory, but a sane cap avoids a footgun, and a permissionless
    ///         deployer setting an absurd royalty on a collection owned by
    ///         someone else.
    uint16 private constant MAX_ROYALTY_BPS = 5_000;
    bytes4 private constant INTERFACE_ID_ERC2981 = 0x2a55205a;

    bool private _metadataFrozen;
    bool private _workLocked;

    // Pull-payment balances: mint accrues here; recipients claim via
    // withdraw(). No external transfer happens during mint, so a reverting
    // recipient can never brick minting. Overpayment on a dynamic-priced mint
    // accrues back to the payer the same way.
    mapping(address => uint256) private _pending;
    // Running sum of every _pending balance; rescueStrayETH may only sweep the
    // surplus above it, so owed balances are untouchable.
    uint256 private _totalPending;

    address public defaultRenderer; // canonical fallback, set at init
    address private _renderer; // collection renderer override; 0 = default
    address private _mintHook; // 0 = none
    address private _priceStrategy; // 0 = stored fixed price

    /// @dev Extension minters, granted explicitly by the owner. They may call
    ///      mintTo/mintToAt (non-payable); all value handling is theirs.
    mapping(address => bool) private _minters;

    /// @dev Admins, granted by the owner via setAdmin. An admin may call every
    ///      management function the owner can, with two exceptions reserved to
    ///      the owner: managing the admin set (setAdmin) and transferring
    ///      ownership. That keeps the owner the single root that hands out and
    ///      revokes keys and that marketplaces read as owner(). Owner is an
    ///      implicit admin. A grant is a bare mapping flag, revocable any time.
    mapping(address => bool) private _admins;

    CollectionConfig private _cfg;
    WorkConfig private _work;
    bool private _closing;

    // Sequential-mode id counter (first id = 1). Unused in pooled mode.
    uint256 private _nextId;
    // Mints ever (both modes; assigns mintIndex). Burns never decrement it.
    uint256 private _mintedEver;
    uint256 private _burnedCount;

    mapping(uint256 => MintRecord) private _record; // current instance's mark
    mapping(uint256 => bytes32) private _seed; // current instance's entropy

    mapping(uint256 => string) private _tokenArtwork;

    Edge[] private _edges;
    mapping(uint256 => Path) private _tokenPath;
    mapping(uint256 => bool) private _tokenPathSet;
    Path private _defaultPath;

    // Bilateral Collection Graph: an edge A --edgeType--> B is "claimed" by A
    // via addEdge; B acknowledges it here so a reader can show "verified
    // mutual" vs "claimed", with no central registry.
    mapping(bytes32 => bool) private _inboundAck;

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
        _cfg = p.cfg;
        _copyWork(p.work);
        _renderer = p.cfg.renderer;
        _mintHook = p.cfg.mintHook;
        _priceStrategy = p.cfg.priceStrategy;
        defaultRenderer = p.defaultRenderer;
        _nextId = 1;
        for (uint256 i = 0; i < p.initialMinters.length; i++) {
            if (!(p.initialMinters[i] != address(0))) revert ZeroMinter();
            _minters[p.initialMinters[i]] = true;
            emit MinterSet(p.initialMinters[i], true);
        }
        // Collab roster: written by the collection itself, which is what the
        // Attribution singleton authorizes. The singleton is a deploy-time,
        // deployer-trusted parameter; init cannot be re-entered (initializer).
        if (p.attribution != address(0) && p.artists.length > 0) {
            IAttribution(p.attribution).setArtists(address(this), p.artists);
        }
        emit CollectionConfigured(
            p.cfg.kind,
            p.cfg.idMode,
            p.cfg.price,
            p.cfg.supplyCap,
            p.cfg.mintStart,
            p.cfg.mintEnd,
            p.cfg.artworkURI
        );
    }

    /// @dev Explicit field-by-field copy: structs with nested dynamic arrays
    ///      cannot be assigned calldata -> storage wholesale.
    function _copyWork(WorkConfig calldata w) private {
        for (uint256 i = 0; i < w.code.length; i++) {
            _work.code.push(w.code[i]);
        }
        for (uint256 i = 0; i < w.deps.length; i++) {
            _work.deps.push(w.deps[i]);
        }
        _work.codeURI = w.codeURI;
        _work.codeHash = w.codeHash;
        _work.liveness = w.liveness;
        _work.injectionVersion = w.injectionVersion;
        _work.renderParams = w.renderParams;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Mint: built-in paid paths (value custody stays here)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Simple mint. The surface defaults to address(0), so the full
    ///         price goes to the artist (no surface share is taken). This is
    ///         the honest default path: a direct minter gives the artist 100%.
    function mint(uint256 quantity) external payable override nonReentrant {
        _mintPaid(quantity, address(0), "");
    }

    /// @notice Mint crediting a `surface` its share (PND on PND, the artist on
    ///         their own self-hosted page). surface == 0 folds the share back
    ///         to the artist. `hookData` is forwarded to the mint hook and the
    ///         price strategy (one blob, both readers).
    function mintWithRewards(uint256 quantity, address surface, bytes calldata hookData)
        external
        payable
        override
        nonReentrant
    {
        _mintPaid(quantity, surface, hookData);
    }

    function _mintPaid(uint256 quantity, address surface, bytes memory hookData) private {
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
        address strategy = _priceStrategy;
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

        uint256 firstTokenId = _nextId;
        _runBeforeHook(msg.sender, quantity, firstTokenId, surface, hookData);

        CollectionStatus statusAtMint = _statusForMark(); // Open or Closing here
        uint256 firstMintIndex = _mintedEver;
        for (uint256 i = 0; i < quantity; i++) {
            _mintOne(msg.sender, firstTokenId + i, surface, statusAtMint);
        }
        _nextId = firstTokenId + quantity;

        _settle(required, surface);
        _runAfterHook(msg.sender, quantity, firstTokenId, surface, hookData);

        emit Minted(
            msg.sender,
            surface,
            firstTokenId,
            quantity,
            firstMintIndex,
            uint48(block.number),
            statusAtMint
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Mint: extension path (economics live in the authorized minter)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Sequential mode only. Non-payable: the calling minter carries
    ///         all value handling (and, if it takes payment, honors the
    ///         surface share by convention). Hooks run here too, so gating
    ///         composes with custom minters. Cap and id assignment are
    ///         enforced exactly as on the paid path; the sale window is not:
    ///         an extension minter owns its own schedule, and the artist's
    ///         lever is revoking the grant.
    function mintTo(address to, address surface, bytes calldata hookData)
        external
        override
        nonReentrant
        returns (uint256 tokenId)
    {
        if (!(_minters[msg.sender])) revert NotMinter();
        if (!(_cfg.idMode == IdMode.Sequential)) revert PooledNeedsMintToAt();
        _checkCap(1);
        tokenId = _nextId;
        _runBeforeHook(to, 1, tokenId, surface, hookData);
        CollectionStatus statusAtMint = _statusForMark();
        uint256 mintIndex = _mintedEver;
        _mintOne(to, tokenId, surface, statusAtMint);
        _nextId = tokenId + 1;
        _runAfterHook(to, 1, tokenId, surface, hookData);
        emit Minted(to, surface, tokenId, 1, mintIndex, uint48(block.number), statusAtMint);
    }

    /// @notice Pooled mode only: the minter supplies the id (tokenId ==
    ///         sourceId forms; id 0 is legal). A previously burned id mints
    ///         again as a NEW instance: fresh Mint Mark, fresh entropy. The
    ///         prior instance's history persists in events and offchain
    ///         indexing.
    function mintToAt(address to, uint256 tokenId, address surface, bytes calldata hookData)
        external
        override
        nonReentrant
    {
        if (!(_minters[msg.sender])) revert NotMinter();
        if (!(_cfg.idMode == IdMode.Pooled)) revert SequentialAssignsIds();
        _checkCap(1);
        _runBeforeHook(to, 1, tokenId, surface, hookData);
        CollectionStatus statusAtMint = _statusForMark();
        uint256 mintIndex = _mintedEver;
        _mintOne(to, tokenId, surface, statusAtMint);
        _runAfterHook(to, 1, tokenId, surface, hookData);
        emit Minted(to, surface, tokenId, 1, mintIndex, uint48(block.number), statusAtMint);
    }

    /// @dev Shared per-token mint effects: ownership, Mint Mark, entropy.
    ///      OZ _mint reverts on an existing id, which is the whole pooled-mode
    ///      correctness argument: a live id can never be minted over.
    function _mintOne(address to, uint256 tokenId, address surface, CollectionStatus statusAtMint)
        private
    {
        uint256 mintIndex = _mintedEver;
        _mintedEver = mintIndex + 1;
        _mint(to, tokenId);
        _record[tokenId] = MintRecord({
            mintBlock: uint48(block.number),
            mintIndex: uint40(mintIndex),
            statusAtMint: uint8(statusAtMint),
            surface: surface
        });
        _seed[tokenId] =
            keccak256(abi.encode(block.prevrandao, address(this), tokenId, to, mintIndex));
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

    /// @dev The truthful lifecycle status stamped into a Mint Mark. On the
    ///      paid path this is Open or Closing (Closed mints revert on the
    ///      window/cap checks). On the extension path Closed is possible and
    ///      correct: a pooled re-mint after the window (a redeem cycle) is a
    ///      legitimate mint whose mark should say so.
    function _statusForMark() private view returns (CollectionStatus) {
        return _lifecycleStatus();
    }

    function _runBeforeHook(
        address minter,
        uint256 quantity,
        uint256 firstTokenId,
        address surface,
        bytes memory hookData
    ) private {
        address hook = _mintHook;
        if (hook != address(0)) {
            if (!(IMintHook(hook).beforeMint(minter, quantity, firstTokenId, surface, hookData)
                    == IMintHook.beforeMint.selector)) revert HookRejected();
        }
    }

    function _runAfterHook(
        address minter,
        uint256 quantity,
        uint256 firstTokenId,
        address surface,
        bytes memory hookData
    ) private {
        address hook = _mintHook;
        if (hook != address(0)) {
            IMintHook(hook).afterMint(minter, quantity, firstTokenId, surface, hookData);
        }
    }

    /// @dev Accrue `total` (pull-payment) split between the surface share and
    ///      the artist payout. surface == 0 folds the whole amount to the
    ///      artist. No external call here; recipients claim via withdraw(), so
    ///      a reverting recipient can never brick a mint.
    function _settle(uint256 total, address surface) private {
        if (total == 0) return;
        _totalPending += total;
        uint256 surfaceCut = surface == address(0) ? 0 : (total * SURFACE_SHARE_BPS) / BPS;
        if (surfaceCut > 0) {
            _pending[surface] += surfaceCut;
            emit SurfacePaid(surface, surfaceCut);
        }
        uint256 artistCut = total - surfaceCut;
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
    ///      granted via setAdmin. Gates every management function except
    ///      setAdmin and ownership transfer, which stay owner-only.
    modifier onlyOwnerOrAdmin() {
        if (msg.sender != owner() && !_admins[msg.sender]) revert NotAuthorized();
        _;
    }

    /// @notice Grant or revoke an admin. An admin can call every management
    ///         function the owner can, except managing admins and transferring
    ///         ownership. Owner-only: the owner is the root that hands out and
    ///         revokes keys.
    function setAdmin(address account, bool allowed) external override onlyOwner {
        if (!(account != address(0))) revert ZeroAccount();
        _admins[account] = allowed;
        emit AdminSet(account, allowed);
    }

    /// @notice Whether `account` holds an explicit admin grant. Owner is an
    ///         implicit admin and is not required to appear here.
    function isAdmin(address account) external view override returns (bool) {
        return _admins[account];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Config (owner root; every setter below also accepts admins)
    // ─────────────────────────────────────────────────────────────────────────

    function setClosing(bool closing) external override onlyOwnerOrAdmin {
        _closing = closing;
        emit ClosingSet(closing);
    }

    function setRenderer(address renderer_) external override onlyOwnerOrAdmin {
        if (!(!_metadataFrozen)) revert MetadataIsFrozen();
        _renderer = renderer_;
        emit RendererSet(renderer_);
    }

    function setMintHook(address hook) external override onlyOwnerOrAdmin {
        _mintHook = hook;
        emit MintHookSet(hook);
    }

    function setPriceStrategy(address strategy) external override onlyOwnerOrAdmin {
        _priceStrategy = strategy;
        emit PriceStrategySet(strategy);
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

    function setTokenArtwork(uint256 tokenId, string calldata cid) external override onlyOwnerOrAdmin {
        if (!(!_metadataFrozen)) revert MetadataIsFrozen();
        if (!(_wasMinted(tokenId))) revert NotMinted();
        _tokenArtwork[tokenId] = cid;
        emit TokenArtworkSet(tokenId, cid);
    }

    function setTokenArtworkBatch(uint256[] calldata tokenIds, string[] calldata cids)
        external
        override
        onlyOwnerOrAdmin
    {
        if (!(!_metadataFrozen)) revert MetadataIsFrozen();
        if (!(tokenIds.length == cids.length)) revert LengthMismatch();
        for (uint256 i = 0; i < tokenIds.length; i++) {
            if (!(_wasMinted(tokenIds[i]))) revert NotMinted();
            _tokenArtwork[tokenIds[i]] = cids[i];
            emit TokenArtworkSet(tokenIds[i], cids[i]);
        }
    }

    /// @notice Update where the artist's share accrues for FUTURE mints. Past
    ///         accruals remain claimable at the old address.
    function setPayoutAddress(address payoutAddress) external override onlyOwnerOrAdmin {
        _cfg.payoutAddress = payoutAddress;
        emit PayoutAddressSet(payoutAddress);
    }

    /// @notice One-way: renounce the ability to change the renderer or
    ///         per-token artwork, so collectors get a presentation-permanence
    ///         guarantee.
    function freezeMetadata() external override onlyOwnerOrAdmin {
        if (!(!_metadataFrozen)) revert AlreadyFrozen();
        _metadataFrozen = true;
        emit MetadataFrozen();
    }

    /// @notice Replace the work definition (script refs, deps, render spec) — the algorithm
    ///         the renderer runs. The artist may refine it until they lock it; reverts once
    ///         `lockWork` has been called.
    function setWork(WorkConfig calldata work) external override onlyOwnerOrAdmin {
        if (_workLocked) revert WorkAlreadyLocked();
        delete _work; // clear the previous code/deps arrays before re-copying
        _copyWork(work);
        emit WorkSet(work.codeHash);
    }

    /// @notice One-way: permanently lock the work config (what the work IS), so `setWork` can
    ///         never change it again. Together with freezeMetadata this is the art-permanence
    ///         guarantee; the contract itself is immutable from deploy.
    function lockWork() external override onlyOwnerOrAdmin {
        if (!(!_workLocked)) revert WorkAlreadyLocked();
        _workLocked = true;
        emit WorkLocked();
    }

    /// @notice Disabled. Renouncing would orphan the collection: default
    ///         proceeds would accrue to owner() == address(0) and every admin
    ///         lever would be permanently bricked. Immutability comes from the
    ///         clone having no upgrade path, not from burning the owner.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Collection Graph (owner, append-only)
    // ─────────────────────────────────────────────────────────────────────────

    function addEdge(EdgeType edgeType, Ref calldata target) external override onlyOwnerOrAdmin {
        _edges.push(Edge({edgeType: edgeType, target: target}));
        emit EdgeAdded(edgeType, target);
    }

    function edges() external view override returns (Edge[] memory) {
        return _edges;
    }

    /// @notice Acknowledge (ack=true) or revoke (ack=false) an inbound edge
    ///         claimed by `source`, so a reader can verify the relationship is
    ///         mutual with no central registry. Idempotent.
    function acknowledgeEdge(EdgeType edgeType, Ref calldata source, bool ack)
        external
        override
        onlyOwnerOrAdmin
    {
        _inboundAck[keccak256(abi.encode(edgeType, source))] = ack;
        emit EdgeAcknowledged(edgeType, source, ack);
    }

    function isEdgeAcknowledged(EdgeType edgeType, Ref calldata source)
        external
        view
        override
        returns (bool)
    {
        return _inboundAck[keccak256(abi.encode(edgeType, source))];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Token Path (owner in v1; pointer layer only)
    // ─────────────────────────────────────────────────────────────────────────

    function setDefaultPath(PathType pathType, Ref calldata target, bytes32 data)
        external
        override
        onlyOwnerOrAdmin
    {
        _defaultPath = Path({pathType: pathType, target: target, data: data});
        emit DefaultPathSet(pathType, target, data);
    }

    function setPath(uint256 tokenId, PathType pathType, Ref calldata target, bytes32 data)
        external
        override
        onlyOwnerOrAdmin
    {
        if (!(_wasMinted(tokenId))) revert NotMinted();
        _tokenPath[tokenId] = Path({pathType: pathType, target: target, data: data});
        _tokenPathSet[tokenId] = true;
        emit PathSet(tokenId, pathType, target, data);
    }

    function pathOf(uint256 tokenId) external view override returns (Path memory) {
        if (_tokenPathSet[tokenId]) return _tokenPath[tokenId];
        return _defaultPath;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Mint Marks + reads
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice The Mint Mark of a token's CURRENT (or most recent) instance.
    ///         Readable for burned ids until a pooled re-mint overwrites them.
    function mintMarkOf(uint256 tokenId) public view override returns (MintMark memory m) {
        MintRecord storage r = _record[tokenId];
        if (!(r.mintBlock != 0)) revert NeverMinted();
        m = MintMark({
            mintIndex: r.mintIndex,
            mintBlock: r.mintBlock,
            statusAtMint: CollectionStatus(r.statusAtMint),
            surface: r.surface,
            isFirst: r.mintIndex == 0,
            isFinal: _lifecycleStatus() == CollectionStatus.Closed
                && r.mintIndex == _mintedEver - 1
        });
    }

    /// @notice Mint-time entropy of the current instance, stamped in the mint
    ///         transaction. Derived from prevrandao: acceptable unpredictability
    ///         for art, not for lotteries.
    function tokenSeed(uint256 tokenId) external view override returns (bytes32) {
        if (!(_record[tokenId].mintBlock != 0)) revert NeverMinted();
        return _seed[tokenId];
    }

    /// @dev "Was ever minted" (any instance). Sequential: id below the
    ///      counter. Pooled: a mint record exists.
    function _wasMinted(uint256 tokenId) internal view returns (bool) {
        return _record[tokenId].mintBlock != 0;
    }

    function _lifecycleStatus() internal view returns (CollectionStatus) {
        if (_cfg.mintEnd != 0 && block.timestamp >= _cfg.mintEnd) return CollectionStatus.Closed;
        if (_cfg.supplyCap != 0 && _cfg.idMode == IdMode.Sequential && _mintedEver >= _cfg.supplyCap)
        {
            return CollectionStatus.Closed;
        }
        if (_closing) return CollectionStatus.Closing;
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

    function surfaceShareBps() external pure override returns (uint16) {
        return SURFACE_SHARE_BPS;
    }

    function currentPrice(address minter, uint256 quantity, bytes calldata data)
        external
        view
        override
        returns (uint256)
    {
        address strategy = _priceStrategy;
        if (strategy == address(0)) return _cfg.price * quantity;
        return IPriceStrategy(strategy).priceOf(address(this), minter, quantity, data);
    }

    function workConfig() external view override returns (WorkConfig memory) {
        return _work;
    }

    function isWorkLocked() external view override returns (bool) {
        return _workLocked;
    }

    function idMode() external view override returns (IdMode) {
        return _cfg.idMode;
    }

    function artwork() external view override returns (string memory) {
        return _cfg.artworkURI;
    }

    function tokenArtwork(uint256 tokenId) external view override returns (string memory) {
        return _tokenArtwork[tokenId];
    }

    function renderer() public view override returns (address) {
        return _renderer != address(0) ? _renderer : defaultRenderer;
    }

    function mintHook() external view override returns (address) {
        return _mintHook;
    }

    function priceStrategy() external view override returns (address) {
        return _priceStrategy;
    }

    function isMinter(address minter) external view override returns (bool) {
        return _minters[minter];
    }

    function isMetadataFrozen() external view override returns (bool) {
        return _metadataFrozen;
    }

    /// @notice metadataFrozen && workLocked: the art-permanence guarantee.
    ///         There is no seal() dimension: the contract is immutable from
    ///         deploy.
    function isPermanent() external view override returns (bool) {
        return _metadataFrozen && _workLocked;
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
        return interfaceId == INTERFACE_ID_ERC2981 || super.supportsInterface(interfaceId);
    }
}
