// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {ERC721AUpgradeable} from "erc721a-upgradeable/contracts/ERC721AUpgradeable.sol";
import {OwnableUpgradeable} from
    "openzeppelin-contracts-upgradeable/contracts/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from
    "openzeppelin-contracts-upgradeable/contracts/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from
    "openzeppelin-contracts-upgradeable/contracts/utils/ReentrancyGuardUpgradeable.sol";

import {IPNDEditions} from "./interfaces/IPNDEditions.sol";
import {IPNDRenderer} from "./interfaces/IPNDRenderer.sol";
import {IPNDMintHook} from "./interfaces/IPNDMintHook.sol";
import {
    ReleaseConfig,
    ReleaseStatus,
    MintBatch,
    MintMark,
    Edge,
    EdgeType,
    Path,
    PathType,
    Ref
} from "./PNDEditionsTypes.sol";

/// @title PNDEditions
/// @notice One artist project. An ERC721A collection that holds one or more
///         releases (shared art + shared mint conditions), where every minted
///         token keeps its own identity: a per-batch Mint Mark (provenance) and
///         a per-token Token Path (forward pointer). Honest pricing: the
///         collector pays exactly price * quantity, split out of that price
///         between the artist and the mint surface. No protocol fee.
///
/// @dev    Initializer-based so it works as both an EIP-1167 clone target
///         (immutable projects) and a UUPS implementation (upgradeable
///         projects). Upgradeability is opt-in and sealable; immutable clones
///         can never upgrade.
contract PNDEditions is
    ERC721AUpgradeable,
    OwnableUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable,
    IPNDEditions
{
    uint256 private constant BPS = 10_000;
    bytes4 private constant INTERFACE_ID_ERC2981 = 0x2a55205a;

    // ── upgradeability ──────────────────────────────────────────────────────
    bool private _upgradeableMode;
    bool private _sealedMode;

    // ── renderer / hook ───────────────────────────────────────────────────────
    address public defaultRenderer; // canonical fallback, set at init
    address private _projectRenderer;
    address private _projectMintHook;

    // ── releases ──────────────────────────────────────────────────────────────
    ReleaseConfig[] private _releases;
    mapping(uint256 => bool) private _releaseClosing;
    mapping(uint256 => uint256) private _releaseMinted;
    mapping(uint256 => uint256) private _releaseFirstTokenId;
    mapping(uint256 => uint256) private _releaseLastTokenId;
    mapping(uint256 => address) private _releaseRenderer;
    mapping(uint256 => address) private _releaseMintHook;

    // ── mint marks (per batch) ─────────────────────────────────────────────────
    mapping(uint256 => MintBatch) private _batchAt; // key = batch head tokenId
    uint256[] private _batchHeads; // ascending by construction

    // ── per-token art ───────────────────────────────────────────────────────────
    mapping(uint256 => string) private _tokenArtwork;

    // ── release graph / token path ────────────────────────────────────────────
    mapping(uint256 => Edge[]) private _edges;
    mapping(uint256 => Path) private _tokenPath;
    mapping(uint256 => bool) private _tokenPathSet;
    mapping(uint256 => Path) private _releaseDefaultPath;

    /// @dev Lock the implementation so it can never be initialized directly.
    constructor() {
        _disableInitializers();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Initialization
    // ─────────────────────────────────────────────────────────────────────────

    function initialize(
        string calldata name_,
        string calldata symbol_,
        address owner_,
        bool upgradeable_,
        address defaultRenderer_
    ) external override initializerERC721A initializer {
        require(owner_ != address(0), "PND: owner required");
        require(defaultRenderer_ != address(0), "PND: renderer required");
        __ERC721A_init(name_, symbol_);
        __Ownable_init(owner_);
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        _upgradeableMode = upgradeable_;
        defaultRenderer = defaultRenderer_;
        _projectRenderer = defaultRenderer_;
    }

    function _startTokenId() internal pure override returns (uint256) {
        return 1;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Releases (owner)
    // ─────────────────────────────────────────────────────────────────────────

    function createRelease(ReleaseConfig calldata cfg)
        external
        override
        onlyOwner
        returns (uint256 releaseId)
    {
        require(cfg.surfaceShareBps <= BPS, "PND: surface bps");
        require(cfg.royaltyBps <= BPS, "PND: royalty bps");
        require(cfg.mintEnd == 0 || cfg.mintEnd > cfg.mintStart, "PND: bad window");
        releaseId = _releases.length;
        require(releaseId < type(uint32).max, "PND: too many releases");
        _releases.push(cfg);
        emit ReleaseCreated(
            releaseId,
            cfg.kind,
            cfg.price,
            cfg.surfaceShareBps,
            cfg.supplyCap,
            cfg.mintStart,
            cfg.mintEnd,
            cfg.defaultArtworkURI
        );
    }

    function setClosing(uint256 releaseId, bool closing) external override onlyOwner {
        require(releaseId < _releases.length, "PND: no release");
        _releaseClosing[releaseId] = closing;
        emit ReleaseClosingSet(releaseId, closing);
    }

    function setProjectRenderer(address renderer) external override onlyOwner {
        _projectRenderer = renderer;
        emit ProjectRendererSet(renderer);
    }

    function setReleaseRenderer(uint256 releaseId, address renderer) external override onlyOwner {
        require(releaseId < _releases.length, "PND: no release");
        _releaseRenderer[releaseId] = renderer;
        emit ReleaseRendererSet(releaseId, renderer);
    }

    function setTokenArtwork(uint256 tokenId, string calldata cid) external override onlyOwner {
        require(_wasMinted(tokenId), "PND: not minted");
        _tokenArtwork[tokenId] = cid;
        emit TokenArtworkSet(tokenId, cid);
    }

    function setTokenArtworkBatch(uint256[] calldata tokenIds, string[] calldata cids)
        external
        override
        onlyOwner
    {
        require(tokenIds.length == cids.length, "PND: length");
        for (uint256 i = 0; i < tokenIds.length; i++) {
            require(_wasMinted(tokenIds[i]), "PND: not minted");
            _tokenArtwork[tokenIds[i]] = cids[i];
            emit TokenArtworkSet(tokenIds[i], cids[i]);
        }
    }

    function setProjectMintHook(address hook) external override onlyOwner {
        _projectMintHook = hook;
        emit ProjectMintHookSet(hook);
    }

    function setReleaseMintHook(uint256 releaseId, address hook) external override onlyOwner {
        require(releaseId < _releases.length, "PND: no release");
        _releaseMintHook[releaseId] = hook;
        emit ReleaseMintHookSet(releaseId, hook);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Mint
    // ─────────────────────────────────────────────────────────────────────────

    function mint(uint256 releaseId, uint256 quantity, address surface, bytes calldata hookData)
        external
        payable
        override
        nonReentrant
    {
        require(releaseId < _releases.length, "PND: no release");
        require(quantity > 0, "PND: zero qty");
        ReleaseConfig storage r = _releases[releaseId];

        require(block.timestamp >= r.mintStart, "PND: not started");
        require(r.mintEnd == 0 || block.timestamp < r.mintEnd, "PND: ended");

        uint256 mintedSoFar = _releaseMinted[releaseId];
        require(r.supplyCap == 0 || mintedSoFar + quantity <= r.supplyCap, "PND: exceeds cap");
        require(msg.value == r.price * quantity, "PND: wrong payment");

        uint256 firstTokenId = _nextTokenId();

        // Hook gate (before effects; reentrancy is blocked by nonReentrant).
        address hook = mintHookOf(releaseId);
        if (hook != address(0)) {
            require(
                IPNDMintHook(hook).beforeMint(
                    msg.sender, releaseId, quantity, firstTokenId, surface, hookData
                ) == IPNDMintHook.beforeMint.selector,
                "PND: hook rejected"
            );
        }

        // Effects: mint the ERC721A batch and record one Mint Mark batch.
        _mint(msg.sender, quantity);
        ReleaseStatus statusAtMint =
            _recordBatch(releaseId, firstTokenId, quantity, mintedSoFar, surface);

        // Interactions: pay out of the price (no protocol fee), then notify hook.
        _settle(releaseId, r, msg.value, surface);
        if (hook != address(0)) {
            IPNDMintHook(hook).afterMint(
                msg.sender, releaseId, quantity, firstTokenId, surface, hookData
            );
        }

        emit Minted(
            releaseId,
            msg.sender,
            surface,
            firstTokenId,
            quantity,
            uint32(mintedSoFar),
            uint48(block.number),
            statusAtMint
        );
    }

    /// @dev Record one Mint Mark batch and advance the release counters.
    function _recordBatch(
        uint256 releaseId,
        uint256 firstTokenId,
        uint256 quantity,
        uint256 mintedSoFar,
        address surface
    ) private returns (ReleaseStatus statusAtMint) {
        statusAtMint = _releaseClosing[releaseId] ? ReleaseStatus.Closing : ReleaseStatus.Open;
        _batchAt[firstTokenId] = MintBatch({
            releaseId: uint32(releaseId),
            startIndexInRelease: uint32(mintedSoFar),
            mintBlock: uint48(block.number),
            statusAtMint: uint8(statusAtMint),
            surface: surface
        });
        _batchHeads.push(firstTokenId);
        if (mintedSoFar == 0) _releaseFirstTokenId[releaseId] = firstTokenId;
        _releaseMinted[releaseId] = mintedSoFar + quantity;
        _releaseLastTokenId[releaseId] = firstTokenId + quantity - 1;
    }

    /// @dev Split `total` out of the price between surface and artist payout.
    function _settle(uint256 releaseId, ReleaseConfig storage r, uint256 total, address surface)
        private
    {
        uint256 surfaceCut = (surface == address(0) || r.surfaceShareBps == 0)
            ? 0
            : (total * r.surfaceShareBps) / BPS;
        if (surfaceCut > 0) {
            _pay(surface, surfaceCut);
            emit SurfacePaid(releaseId, surface, surfaceCut);
        }
        uint256 artistCut = total - surfaceCut;
        if (artistCut > 0) {
            _pay(r.payoutAddress == address(0) ? owner() : r.payoutAddress, artistCut);
        }
    }

    function _pay(address to, uint256 amount) private {
        (bool ok,) = payable(to).call{value: amount}("");
        require(ok, "PND: pay failed");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Release Graph (owner, append-only)
    // ─────────────────────────────────────────────────────────────────────────

    function addEdge(uint256 releaseId, EdgeType edgeType, Ref calldata target)
        external
        override
        onlyOwner
    {
        require(releaseId < _releases.length, "PND: no release");
        _edges[releaseId].push(Edge({edgeType: edgeType, target: target}));
        emit EdgeAdded(releaseId, edgeType, target);
    }

    function edgesOf(uint256 releaseId) external view override returns (Edge[] memory) {
        return _edges[releaseId];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Token Path (owner in v1; pointer layer only)
    // ─────────────────────────────────────────────────────────────────────────

    function setReleaseDefaultPath(
        uint256 releaseId,
        PathType pathType,
        Ref calldata target,
        bytes32 data
    ) external override onlyOwner {
        require(releaseId < _releases.length, "PND: no release");
        _releaseDefaultPath[releaseId] = Path({pathType: pathType, target: target, data: data});
        emit ReleaseDefaultPathSet(releaseId, pathType, target, data);
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
        return _releaseDefaultPath[releaseOf(tokenId)];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Upgradeability
    // ─────────────────────────────────────────────────────────────────────────

    function seal() external override onlyOwner {
        require(_upgradeableMode, "PND: not upgradeable");
        require(!_sealedMode, "PND: already sealed");
        _sealedMode = true;
        emit Sealed();
    }

    function isUpgradeable() external view override returns (bool) {
        return _upgradeableMode && !_sealedMode;
    }

    function isSealed() external view override returns (bool) {
        return _sealedMode;
    }

    function _authorizeUpgrade(address) internal view override onlyOwner {
        require(_upgradeableMode && !_sealedMode, "PND: not upgradeable");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Mint Marks + reads
    // ─────────────────────────────────────────────────────────────────────────

    function mintMarkOf(uint256 tokenId) public view override returns (MintMark memory m) {
        require(_wasMinted(tokenId), "PND: not minted");
        uint256 head = _batchHeadOf(tokenId);
        MintBatch storage b = _batchAt[head];
        uint256 rid = b.releaseId;
        uint32 idx = uint32(b.startIndexInRelease + (tokenId - head));
        m = MintMark({
            releaseId: b.releaseId,
            indexInRelease: idx,
            mintBlock: b.mintBlock,
            statusAtMint: ReleaseStatus(b.statusAtMint),
            surface: b.surface,
            isFirst: idx == 0,
            isFinal: _lifecycleStatus(rid) == ReleaseStatus.Closed
                && tokenId == _releaseLastTokenId[rid]
        });
    }

    function releaseOf(uint256 tokenId) public view override returns (uint256) {
        require(_wasMinted(tokenId), "PND: not minted");
        return _batchAt[_batchHeadOf(tokenId)].releaseId;
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

    function _lifecycleStatus(uint256 releaseId) internal view returns (ReleaseStatus) {
        ReleaseConfig storage r = _releases[releaseId];
        if (r.mintEnd != 0 && block.timestamp >= r.mintEnd) return ReleaseStatus.Closed;
        if (r.supplyCap != 0 && _releaseMinted[releaseId] >= r.supplyCap) return ReleaseStatus.Closed;
        if (_releaseClosing[releaseId]) return ReleaseStatus.Closing;
        return ReleaseStatus.Open;
    }

    function release(uint256 releaseId)
        external
        view
        override
        returns (ReleaseConfig memory cfg, ReleaseStatus status, uint256 minted)
    {
        require(releaseId < _releases.length, "PND: no release");
        cfg = _releases[releaseId];
        status = _lifecycleStatus(releaseId);
        minted = _releaseMinted[releaseId];
    }

    function totalReleases() external view override returns (uint256) {
        return _releases.length;
    }

    function releaseArtwork(uint256 releaseId) external view override returns (string memory) {
        require(releaseId < _releases.length, "PND: no release");
        return _releases[releaseId].defaultArtworkURI;
    }

    function tokenArtwork(uint256 tokenId) external view override returns (string memory) {
        return _tokenArtwork[tokenId];
    }

    function rendererOf(uint256 releaseId) public view override returns (address) {
        address rr = _releaseRenderer[releaseId];
        if (rr != address(0)) return rr;
        if (_projectRenderer != address(0)) return _projectRenderer;
        return defaultRenderer;
    }

    function mintHookOf(uint256 releaseId) public view override returns (address) {
        address rh = _releaseMintHook[releaseId];
        if (rh != address(0)) return rh;
        return _projectMintHook;
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
        return IPNDRenderer(rendererOf(releaseOf(tokenId))).tokenURI(tokenId);
    }

    function contractURI() external view returns (string memory) {
        return IPNDRenderer(rendererOf(0)).contractURI();
    }

    /// @notice EIP-2981 royalty info, per release.
    function royaltyInfo(uint256 tokenId, uint256 salePrice)
        external
        view
        returns (address receiver, uint256 royaltyAmount)
    {
        ReleaseConfig storage r = _releases[releaseOf(tokenId)];
        receiver = r.royaltyReceiver == address(0) ? owner() : r.royaltyReceiver;
        royaltyAmount = (salePrice * r.royaltyBps) / BPS;
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
