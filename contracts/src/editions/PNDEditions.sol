// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {ERC721AUpgradeable} from "erc721a-upgradeable/contracts/ERC721AUpgradeable.sol";
import {Ownable2StepUpgradeable} from
    "openzeppelin-contracts-upgradeable/contracts/access/Ownable2StepUpgradeable.sol";
import {UUPSUpgradeable} from
    "openzeppelin-contracts-upgradeable/contracts/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from
    "openzeppelin-contracts-upgradeable/contracts/utils/ReentrancyGuardUpgradeable.sol";

import {IPNDEditions} from "./interfaces/IPNDEditions.sol";
import {IPNDRenderer} from "./interfaces/IPNDRenderer.sol";
import {IPNDMintHook} from "./interfaces/IPNDMintHook.sol";
import {
    EditionConfig,
    EditionStatus,
    MintBatch,
    MintMark,
    Edge,
    EdgeType,
    Path,
    PathType,
    Ref
} from "./PNDEditionsTypes.sol";

/// @title PNDEditions
/// @notice One artist edition. An ERC721A collection with shared artwork +
///         shared mint conditions, where every minted token keeps its own
///         identity: a per-batch Mint Mark (provenance) and a per-token Token
///         Path (forward pointer). Honest pricing: the collector pays exactly
///         price * quantity. A fixed protocol Surface Share is paid out of
///         that price to whoever hosts the mint (PND on PND; the artist on
///         their own site; folded back to the artist on a direct mint).
///
/// @dev    Always deployed as a UUPS proxy. The owner can upgrade until they
///         seal() to renounce upgradeability forever.
contract PNDEditions is
    ERC721AUpgradeable,
    Ownable2StepUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable,
    IPNDEditions
{
    uint16 private constant BPS = 10_000;
    /// @notice Fixed protocol surface share: 10%. Paid to the mint surface
    ///         (PND on PND, the artist on their own site). Not artist-set.
    uint16 public constant SURFACE_SHARE_BPS = 1_000;
    /// @notice Hard ceiling on the artist-set EIP-2981 royalty (50%). 2981 is
    ///         advisory, but a sane cap avoids a footgun, and a permissionless
    ///         deployer setting an absurd royalty on an edition owned by someone
    ///         else.
    uint16 private constant MAX_ROYALTY_BPS = 5_000;
    bytes4 private constant INTERFACE_ID_ERC2981 = 0x2a55205a;

    bool private _sealedMode;
    bool private _metadataFrozen;

    // Pull-payment balances: mint() accrues here; recipients claim via
    // withdraw(). No external transfer happens during mint, so a reverting
    // recipient can never brick minting.
    mapping(address => uint256) private _pending;
    // Running sum of every _pending balance. _authorizeUpgrade requires this to
    // be zero, so a malicious upgrade can never sweep funds owed to the surface,
    // the artist payout, or collaborators: they must be settled (paid out) first.
    uint256 private _totalPending;

    address public defaultRenderer; // canonical fallback, set at init
    address private _renderer; // edition renderer override; 0 = default
    address private _mintHook; // 0 = none

    EditionConfig private _cfg;
    bool private _closing;

    mapping(uint256 => MintBatch) private _batchAt; // key = batch head tokenId
    uint256[] private _batchHeads; // ascending by construction

    mapping(uint256 => string) private _tokenArtwork;

    Edge[] private _edges;
    mapping(uint256 => Path) private _tokenPath;
    mapping(uint256 => bool) private _tokenPathSet;
    Path private _defaultPath;

    // Bilateral Edition Graph: an edge A --edgeType--> B is "claimed" by A via
    // addEdge; B acknowledges it here so a reader can show "verified mutual" vs
    // "claimed", with no central registry. Keyed by keccak256(edgeType, source).
    mapping(bytes32 => bool) private _inboundAck;

    // Append-only storage. New state variables go directly ABOVE this gap; never
    // reorder or insert among existing slots. The base contracts use namespaced
    // (OZ ERC-7201) / diamond (ERC721A) storage, so these sequential slots belong
    // to PNDEditions alone, and appending before the gap stays upgrade-safe.
    uint256[49] private __gap;

    constructor() {
        _disableInitializers();
    }

    function initialize(
        string calldata name_,
        string calldata symbol_,
        address owner_,
        EditionConfig calldata cfg,
        address defaultRenderer_
    ) external override initializerERC721A initializer {
        require(owner_ != address(0), "PND: owner required");
        require(defaultRenderer_ != address(0), "PND: renderer required");
        require(cfg.royaltyBps <= MAX_ROYALTY_BPS, "PND: royalty too high");
        require(cfg.mintEnd == 0 || cfg.mintEnd > cfg.mintStart, "PND: bad window");
        __ERC721A_init(name_, symbol_);
        __Ownable_init(owner_);
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        _cfg = cfg;
        _renderer = cfg.renderer;
        _mintHook = cfg.mintHook;
        defaultRenderer = defaultRenderer_;
        emit EditionConfigured(
            cfg.kind, cfg.price, cfg.supplyCap, cfg.mintStart, cfg.mintEnd, cfg.artworkURI
        );
    }

    function _startTokenId() internal pure override returns (uint256) {
        return 1;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Mint
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Simple mint. The surface defaults to address(0), so the full
    ///         price goes to the artist (no surface share is taken). This is
    ///         the honest default path: a direct minter gives the artist 100%.
    function mint(uint256 quantity) external payable override nonReentrant {
        _mintCore(quantity, address(0), "");
    }

    /// @notice Mint crediting a `surface` its share (PND on PND, the artist on
    ///         their own self-hosted page). surface == 0 folds the share back
    ///         to the artist. `hookData` is forwarded to the mint hook if set.
    function mintWithRewards(uint256 quantity, address surface, bytes calldata hookData)
        external
        payable
        override
        nonReentrant
    {
        _mintCore(quantity, surface, hookData);
    }

    function _mintCore(uint256 quantity, address surface, bytes memory hookData) private {
        require(quantity > 0, "PND: zero qty");
        require(block.timestamp >= _cfg.mintStart, "PND: not started");
        require(_cfg.mintEnd == 0 || block.timestamp < _cfg.mintEnd, "PND: ended");
        require(_cfg.supplyCap == 0 || _totalMinted() + quantity <= _cfg.supplyCap, "PND: exceeds cap");
        require(msg.value == _cfg.price * quantity, "PND: wrong payment");

        uint256 firstTokenId = _nextTokenId();

        address hook = _mintHook;
        if (hook != address(0)) {
            require(
                IPNDMintHook(hook).beforeMint(msg.sender, quantity, firstTokenId, surface, hookData)
                    == IPNDMintHook.beforeMint.selector,
                "PND: hook rejected"
            );
        }

        _mint(msg.sender, quantity);
        EditionStatus statusAtMint = _closing ? EditionStatus.Closing : EditionStatus.Open;
        _batchAt[firstTokenId] =
            MintBatch({mintBlock: uint48(block.number), statusAtMint: uint8(statusAtMint), surface: surface});
        _batchHeads.push(firstTokenId);

        _settle(msg.value, surface);
        if (hook != address(0)) {
            IPNDMintHook(hook).afterMint(msg.sender, quantity, firstTokenId, surface, hookData);
        }

        emit Minted(msg.sender, surface, firstTokenId, quantity, uint48(block.number), statusAtMint);
    }

    /// @dev Accrue `total` (pull-payment) split between the surface share and
    ///      the artist payout. surface == 0 folds the whole amount to the
    ///      artist. No external call here — recipients claim via withdraw() —
    ///      so a reverting recipient can never brick a mint.
    function _settle(uint256 total, address surface) private {
        if (total == 0) return;
        // Track the running owed total so _authorizeUpgrade can require it to be
        // zero (surfaceCut + artistCut == total, so one add covers both legs).
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
        require(account != address(0), "PND: zero account");
        uint256 amount = _pending[account];
        require(amount > 0, "PND: nothing to withdraw");
        _pending[account] = 0;
        _totalPending -= amount;
        (bool ok,) = payable(account).call{value: amount}("");
        require(ok, "PND: withdraw failed");
        emit Withdrawn(account, amount);
    }

    function pendingWithdrawal(address account) external view override returns (uint256) {
        return _pending[account];
    }

    /// @notice Sweep ONLY ETH that is not owed to any payee (e.g. force-fed via
    ///         selfdestruct or a block reward). Pull-payment balances are
    ///         untouchable: only the surplus above _totalPending is ever sent.
    function rescueStrayETH(address to) external override onlyOwner nonReentrant {
        require(to != address(0), "PND: zero account");
        uint256 stray = address(this).balance - _totalPending;
        require(stray > 0, "PND: no stray eth");
        (bool ok,) = payable(to).call{value: stray}("");
        require(ok, "PND: rescue failed");
        emit StrayETHRescued(to, stray);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Config (owner)
    // ─────────────────────────────────────────────────────────────────────────

    function setClosing(bool closing) external override onlyOwner {
        _closing = closing;
        emit ClosingSet(closing);
    }

    function setRenderer(address renderer_) external override onlyOwner {
        require(!_metadataFrozen, "PND: metadata frozen");
        _renderer = renderer_;
        emit RendererSet(renderer_);
    }

    function setTokenArtwork(uint256 tokenId, string calldata cid) external override onlyOwner {
        require(!_metadataFrozen, "PND: metadata frozen");
        require(_wasMinted(tokenId), "PND: not minted");
        _tokenArtwork[tokenId] = cid;
        emit TokenArtworkSet(tokenId, cid);
    }

    function setTokenArtworkBatch(uint256[] calldata tokenIds, string[] calldata cids)
        external
        override
        onlyOwner
    {
        require(!_metadataFrozen, "PND: metadata frozen");
        require(tokenIds.length == cids.length, "PND: length");
        for (uint256 i = 0; i < tokenIds.length; i++) {
            require(_wasMinted(tokenIds[i]), "PND: not minted");
            _tokenArtwork[tokenIds[i]] = cids[i];
            emit TokenArtworkSet(tokenIds[i], cids[i]);
        }
    }

    function setMintHook(address hook) external override onlyOwner {
        require(!_sealedMode, "PND: sealed");
        _mintHook = hook;
        emit MintHookSet(hook);
    }

    /// @notice Update where the artist's share accrues for FUTURE mints. Past
    ///         accruals remain claimable at the old address. Fixes a bad payout
    ///         without an upgrade.
    function setPayoutAddress(address payoutAddress) external override onlyOwner {
        _cfg.payoutAddress = payoutAddress;
        emit PayoutAddressSet(payoutAddress);
    }

    /// @notice One-way: renounce the ability to change the renderer or per-token
    ///         artwork, so collectors get a permanence guarantee. Independent of
    ///         seal() (which only stops upgrades).
    function freezeMetadata() external override onlyOwner {
        require(!_metadataFrozen, "PND: already frozen");
        _metadataFrozen = true;
        emit MetadataFrozen();
    }

    function isMetadataFrozen() external view override returns (bool) {
        return _metadataFrozen;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Edition Graph (owner, append-only)
    // ─────────────────────────────────────────────────────────────────────────

    function addEdge(EdgeType edgeType, Ref calldata target) external override onlyOwner {
        _edges.push(Edge({edgeType: edgeType, target: target}));
        emit EdgeAdded(edgeType, target);
    }

    function edges() external view override returns (Edge[] memory) {
        return _edges;
    }

    /// @notice Acknowledge (ack=true) or revoke (ack=false) an inbound edge
    ///         claimed by `source`. An edge A --edgeType--> B is one-directional
    ///         and unauthenticated on A's side; B calls this so a reader can
    ///         verify the relationship is mutual (A claims it AND B acknowledges
    ///         it), with no central registry. Idempotent.
    function acknowledgeEdge(EdgeType edgeType, Ref calldata source, bool ack)
        external
        override
        onlyOwner
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
        onlyOwner
    {
        _defaultPath = Path({pathType: pathType, target: target, data: data});
        emit DefaultPathSet(pathType, target, data);
    }

    function setPath(uint256 tokenId, PathType pathType, Ref calldata target, bytes32 data)
        external
        override
        onlyOwner
    {
        require(_wasMinted(tokenId), "PND: not minted");
        _tokenPath[tokenId] = Path({pathType: pathType, target: target, data: data});
        _tokenPathSet[tokenId] = true;
        emit PathSet(tokenId, pathType, target, data);
    }

    function pathOf(uint256 tokenId) external view override returns (Path memory) {
        if (_tokenPathSet[tokenId]) return _tokenPath[tokenId];
        return _defaultPath;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Upgradeability
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Disabled. Renouncing would orphan the edition: default proceeds
    ///         would accrue to owner() == address(0) (burnable by a
    ///         permissionless withdraw), and every admin lever (seal, freeze,
    ///         payout, upgrade) would be permanently bricked. Use seal() to
    ///         renounce upgradeability without orphaning the contract.
    function renounceOwnership() public pure override {
        revert("PND: renounce disabled");
    }

    function seal() external override onlyOwner {
        require(!_sealedMode, "PND: already sealed");
        _sealedMode = true;
        emit Sealed();
    }

    function isUpgradeable() external view override returns (bool) {
        return !_sealedMode;
    }

    function isSealed() external view override returns (bool) {
        return _sealedMode;
    }

    /// @notice True only when the edition is BOTH sealed (no upgrades) and
    ///         metadata-frozen (no renderer/artwork changes). This is the real
    ///         permanence guarantee: freezeMetadata() alone does NOT make art
    ///         permanent, because an unsealed owner can still upgrade to a new
    ///         implementation that changes the rendered art. Surfaces should
    ///         claim "permanent" only when this is true.
    function isPermanent() external view override returns (bool) {
        return _sealedMode && _metadataFrozen;
    }

    function _authorizeUpgrade(address) internal view override onlyOwner {
        require(!_sealedMode, "PND: sealed");
        // Settle-before-upgrade: an upgrade is only authorized when nothing is
        // owed, so a malicious upgrade target cannot sweep accrued pull-payment
        // balances (the surface share, the artist payout, or collaborators).
        // withdraw() is permissionless, so anyone can flush every payee first.
        require(_totalPending == 0, "PND: settle pending");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Mint Marks + reads
    // ─────────────────────────────────────────────────────────────────────────

    function mintMarkOf(uint256 tokenId) public view override returns (MintMark memory m) {
        require(_wasMinted(tokenId), "PND: not minted");
        MintBatch storage b = _batchAt[_batchHeadOf(tokenId)];
        uint256 start = _startTokenId();
        uint32 idx = uint32(tokenId - start);
        m = MintMark({
            indexInEdition: idx,
            mintBlock: b.mintBlock,
            statusAtMint: EditionStatus(b.statusAtMint),
            surface: b.surface,
            isFirst: idx == 0,
            isFinal: _lifecycleStatus() == EditionStatus.Closed
                && tokenId == start + _totalMinted() - 1
        });
    }

    /// @dev Greatest batch head <= tokenId (binary search over _batchHeads).
    function _batchHeadOf(uint256 tokenId) internal view returns (uint256) {
        uint256[] storage heads = _batchHeads;
        uint256 lo = 0;
        uint256 hi = heads.length; // exclusive; >= 1 because token was minted
        while (lo + 1 < hi) {
            uint256 mid = (lo + hi) >> 1;
            if (heads[mid] <= tokenId) lo = mid;
            else hi = mid;
        }
        return heads[lo];
    }

    function _wasMinted(uint256 tokenId) internal view returns (bool) {
        return tokenId >= _startTokenId() && tokenId < _startTokenId() + _totalMinted();
    }

    function _lifecycleStatus() internal view returns (EditionStatus) {
        if (_cfg.mintEnd != 0 && block.timestamp >= _cfg.mintEnd) return EditionStatus.Closed;
        if (_cfg.supplyCap != 0 && _totalMinted() >= _cfg.supplyCap) return EditionStatus.Closed;
        if (_closing) return EditionStatus.Closing;
        return EditionStatus.Open;
    }

    function config()
        external
        view
        override
        returns (EditionConfig memory cfg, EditionStatus status, uint256 minted)
    {
        cfg = _cfg;
        status = _lifecycleStatus();
        minted = _totalMinted();
    }

    function surfaceShareBps() external pure override returns (uint16) {
        return SURFACE_SHARE_BPS;
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

    // ─────────────────────────────────────────────────────────────────────────
    // Metadata + royalties
    // ─────────────────────────────────────────────────────────────────────────

    function tokenURI(uint256 tokenId)
        public
        view
        override(ERC721AUpgradeable)
        returns (string memory)
    {
        if (!_exists(tokenId)) revert URIQueryForNonexistentToken();
        return IPNDRenderer(renderer()).tokenURI(tokenId);
    }

    function contractURI() external view returns (string memory) {
        return IPNDRenderer(renderer()).contractURI();
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
        override(ERC721AUpgradeable)
        returns (bool)
    {
        return interfaceId == INTERFACE_ID_ERC2981 || super.supportsInterface(interfaceId);
    }
}
