// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {ERC721Upgradeable} from "openzeppelin-contracts-upgradeable/contracts/token/ERC721/ERC721Upgradeable.sol";
import {Ownable2StepUpgradeable} from "openzeppelin-contracts-upgradeable/contracts/access/Ownable2StepUpgradeable.sol";
import {
    ReentrancyGuardUpgradeable
} from "openzeppelin-contracts-upgradeable/contracts/utils/ReentrancyGuardUpgradeable.sol";

import {ISurfaceV2, InitParamsV2} from "./interfaces/ISurfaceV2.sol";
import {ISeedSourceV2} from "./interfaces/ISeedSourceV2.sol";
import {IRenderer} from "../interfaces/IRenderer.sol";
import {ICatalog} from "../interfaces/ICatalog.sol";
import {SurfaceConfig, IdMode} from "../SurfaceTypes.sol";

/// @title SurfaceV2
/// @notice Sequential-id ERC721 collection: the contract assigns ids in mint
///         order (1, 2, 3, ...) and never reuses them after a burn. The
///         owner controls the renderer, supply, royalty, and the authorized
///         minters, and can lock chosen properties permanently, or seal the
///         collection in one call. Holds no value and runs no sale logic:
///         every mint goes through an authorized minter, non-payable. Stores
///         one mint-time seed per token and nothing else.
///
/// @dev    Deployed as immutable EIP-1167 clones: no proxy admin, no upgrade
///         path (the implementation calls _disableInitializers). The OZ
///         upgradeable bases are used only for their initializer pattern (a
///         clone runs no constructor); initialize() sets all state. New
///         behavior ships as new implementations behind a new factory, never
///         by changing a deployed collection.
///
///         v2 of the Surface protocol: art-only, one id mode. Pooled mode,
///         the abstract core/final split, and minter-chosen ids from v1 are
///         removed. Storage layout, event shapes, and the read selectors
///         renderers depend on (config, idMode, tokenSeed, name, tokenURI,
///         contractURI) match v1 so v1 renderers work against this
///         collection unmodified.
contract SurfaceV2 is ERC721Upgradeable, Ownable2StepUpgradeable, ReentrancyGuardUpgradeable, ISurfaceV2 {
    /// @notice Implementation version, monotonic across the Surface protocol's
    ///         implementation lineage. The v1 core reports 1.
    uint256 public constant version = 2;

    /// @dev EIP-2981 is advisory. The 50% ceiling caps the royalty a
    ///      permissionless deployer can set on someone else's behalf.
    uint16 internal constant BPS = 10_000;
    uint16 internal constant MAX_ROYALTY_BPS = 5_000;
    bytes4 internal constant INTERFACE_ID_ERC2981 = 0x2a55205a;
    bytes4 internal constant INTERFACE_ID_ERC4906 = 0x49064906;

    // ─────────────────────────────────────────────────────────────────────────
    // Storage. Declaration order is the storage layout; see
    // docs/pnd-surface-v2-plan.md for the slot table.
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Extension minters, granted explicitly by the owner or an admin.
    ///      They call mintTo/mintToSeeded (non-payable); they handle all
    ///      economics themselves.
    mapping(address => bool) internal _minters;

    /// @dev Count of currently granted minters, kept in sync with _minters.
    uint256 internal _minterCount;

    /// @dev One-way freeze of the minter set. Once true, no grant or revoke
    ///      succeeds.
    bool internal _minterLocked;

    /// @dev Frontend-discovery default, not an authority record: every
    ///      granted minter in _minters is independently callable regardless
    ///      of this pointer. Owner/admin-set, cleared when the pointed-to
    ///      minter is revoked.
    address internal _primaryMinter;

    /// @dev Admins, granted by the owner only. An admin can call every
    ///      management function the owner can, except managing the admin
    ///      set and transferring ownership, which stay owner-only.
    // account => the owner that granted it (0 = not an admin). Validity rule
    // in _isAdmin.
    mapping(address => address) internal _admins;

    // Source of the renderer, supply-cap, and royalty configuration,
    // including rendererLocked and supplyLocked, the two one-way locks
    // contained in SurfaceConfig. Setters edit fields in place, so config()
    // always reflects what the contract uses. The minter set and royalty
    // locks are separate state, not part of this struct.
    SurfaceConfig internal _cfg;

    // Total mints across the contract's lifetime. Burns do not decrement it.
    // The next id is _mintedEver + 1: mint order and id are the same
    // number, so there is no separate mint-index counter.
    uint256 internal _mintedEver;
    uint256 internal _burnedCount;

    // The only per-token storage: mint-time entropy, used as render input
    // that cannot be reconstructed later. Left unset (0) for a token whose
    // seed is served by seedSource instead; keccak output is never zero, so
    // a stored nonzero seed always wins over the fallback for that token.
    mapping(uint256 => bytes32) internal _seed;

    // Attribution is two-sided. The owner lists creators here; each listed
    // creator confirms by claiming this collection in the Catalog from
    // their own address. isConfirmedCreator is the intersection of the two;
    // neither side alone can create a confirmation.
    address internal _catalog; // Catalog singleton; 0 disables confirmation
    mapping(address => bool) public isListedCreator;

    /// @notice External seed fallback for a token with no stored seed. 0
    ///         disables the fallback. Set once at initialize(); no setter,
    ///         no lock, because it can never change afterward.
    address public seedSource;

    /// @dev One-way freeze of the royalty (bps and receiver).
    bool internal _royaltyLocked;

    constructor() {
        _disableInitializers();
    }

    function initialize(InitParamsV2 calldata p) external initializer {
        if (p.owner == address(0)) revert OwnerRequired();
        if (p.cfg.royaltyBps > MAX_ROYALTY_BPS) revert RoyaltyTooHigh();
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
        _catalog = p.catalog;
        // seedSource is set once here with no setter and no lock. An address
        // without code would make tokenSeed revert forever for every token
        // it serves, with no recovery path, so it is rejected at init.
        if (p.seedSource != address(0) && p.seedSource.code.length == 0) {
            revert SeedSourceNotContract(p.seedSource);
        }
        seedSource = p.seedSource;
        for (uint256 i = 0; i < p.initialMinters.length; i++) {
            address m = p.initialMinters[i];
            if (m == address(0)) revert ZeroMinter();
            if (_minters[m]) continue; // a repeated address is not a second grant
            _minters[m] = true;
            _minterCount += 1;
            emit MinterSet(m, true);
        }
        if (p.primaryMinter != address(0)) {
            if (!_minters[p.primaryMinter]) revert PrimaryMinterNotAuthorized();
            _primaryMinter = p.primaryMinter;
            emit PrimaryMinterSet(p.primaryMinter);
        }
        for (uint256 i = 0; i < p.creators.length; i++) {
            isListedCreator[p.creators[i]] = true;
            emit CreatorListed(p.creators[i], true);
        }
        // rendererLocked/supplyLocked, passed in p.cfg, apply from
        // initialization; emit their events. The minter set and royalty
        // have no initialize-time lock; they are frozen only by a later
        // lockMinter()/lockRoyalty() call.
        if (_cfg.rendererLocked) emit RendererLocked();
        if (_cfg.supplyLocked) emit SupplyLocked();
        emit SurfaceConfigured(idMode(), p.cfg.supplyCap);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Mint: authorized minters only (economics live in the minter)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Authorized minters only. Non-payable: the calling minter
    ///         handles all economics. Mints `quantity` tokens with ids
    ///         `firstTokenId .. firstTokenId + quantity - 1` in one call,
    ///         deriving every token's seed, one Minted event.
    function mintTo(address to, uint256 quantity) external override nonReentrant returns (uint256 firstTokenId) {
        if (!_minters[msg.sender]) revert NotMinter();
        if (quantity == 0) revert ZeroQuantity();
        _checkCap(quantity);
        uint256 mintedEver = _mintedEver;
        firstTokenId = mintedEver + 1;
        for (uint256 i = 0; i < quantity; i++) {
            _mintOne(to, firstTokenId + i, bytes32(0));
        }
        // Written once per call regardless of quantity: every iteration's id
        // is already fixed by firstTokenId + i above.
        _mintedEver = mintedEver + quantity;
        emit Minted(msg.sender, to, firstTokenId, quantity, firstTokenId);
    }

    /// @notice Authorized minters only. Same id assignment as mintTo, but
    ///         the caller supplies each token's seed: `seeds.length` is the
    ///         quantity, and a zero entry derives the default seed for that
    ///         token instead of taking a literal seed. A nonzero entry is
    ///         stored and takes precedence over seedSource for that token.
    function mintToSeeded(address to, bytes32[] calldata seeds)
        external
        override
        nonReentrant
        returns (uint256 firstTokenId)
    {
        if (!_minters[msg.sender]) revert NotMinter();
        uint256 quantity = seeds.length;
        if (quantity == 0) revert ZeroQuantity();
        _checkCap(quantity);
        uint256 mintedEver = _mintedEver;
        firstTokenId = mintedEver + 1;
        for (uint256 i = 0; i < quantity; i++) {
            _mintOne(to, firstTokenId + i, seeds[i]);
        }
        _mintedEver = mintedEver + quantity;
        emit Minted(msg.sender, to, firstTokenId, quantity, firstTokenId);
    }

    /// @dev Shared per-token effects: ownership and seed. OZ _mint reverts
    ///      on an existing id, which cannot happen here since tokenId is
    ///      always _mintedEver + 1 or higher at call time.
    ///
    ///      Seed resolution: a nonzero `suppliedSeed` is stored as-is and
    ///      wins over seedSource for this token. A zero `suppliedSeed`
    ///      derives the default seed and stores it, unless seedSource is
    ///      set, in which case the write is skipped and tokenSeed falls
    ///      back to the source for this token.
    function _mintOne(address to, uint256 tokenId, bytes32 suppliedSeed) internal {
        _mint(to, tokenId);
        if (suppliedSeed != bytes32(0)) {
            _seed[tokenId] = suppliedSeed;
        } else if (seedSource == address(0)) {
            // Pure function of public chain state and token identity.
            // Excludes the recipient address: a recipient input would let a
            // minter grind wallets for a favorable seed. Spec:
            // docs/injection-convention.md.
            _seed[tokenId] = keccak256(abi.encode(block.prevrandao, address(this), tokenId));
        }
    }

    /// @notice Burn a token. Authorized for the token holder or an address
    ///         the holder approved. The burned token's seed stays readable.
    function burn(uint256 tokenId) external override nonReentrant {
        address tokenOwner = _requireOwned(tokenId);
        if (!_isAuthorized(tokenOwner, msg.sender, tokenId)) revert NotAuthorized();
        _burn(tokenId);
        _burnedCount += 1;
        emit Burned(tokenId);
    }

    /// @dev Reverts when `quantity` would push mints-ever past the cap
    ///      (0 = no cap). Burning a token does not free capacity.
    function _checkCap(uint256 quantity) internal view {
        uint256 cap = _cfg.supplyCap;
        if (cap == 0) return;
        uint256 attempted = _mintedEver + quantity;
        if (attempted > cap) revert ExceedsCap(cap, attempted);
    }

    /// @notice Sweep the ETH balance. No function of this contract receives
    ///         ETH, so any balance arrived by force (selfdestruct, pre-funded
    ///         address) and is owed to no one.
    function rescueStrayETH(address to) external override onlyOwnerOrAdmin nonReentrant {
        if (to == address(0)) revert ZeroAccount();
        uint256 stray = address(this).balance;
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

    /// @dev An admin grant is valid only while the owner that made it is
    ///      still the owner: `_admins[account]` holds that granting owner,
    ///      so an ownership transfer invalidates every inherited grant. The
    ///      nonzero check also means a renounced collection (owner()==0)
    ///      has no admins.
    function _isAdmin(address account) internal view returns (bool) {
        address grantedBy = _admins[account];
        return grantedBy != address(0) && grantedBy == owner();
    }

    /// @notice Grant an admin (owner-only). Reverts on the zero address, on a
    ///         duplicate grant, and on the current owner (who already counts
    ///         as an admin). The grant records the granting owner and stops
    ///         being valid once ownership changes (see _isAdmin), so a new
    ///         owner does not inherit the old owner's admins.
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

    /// @notice Whether `account` may use the admin-gated setters: the owner,
    ///         or any address holding a valid grant. The owner is included to
    ///         match what the onlyOwnerOrAdmin modifier admits.
    function isAdmin(address account) external view override returns (bool) {
        return account == owner() || _isAdmin(account);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Config (owner root; every setter below also accepts admins)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Update the EIP-2981 royalty. Same cap as init; receiver 0
    ///         resolves to owner(). Reverts once lockRoyalty() has engaged.
    function setRoyalty(uint16 royaltyBps, address royaltyReceiver) external override onlyOwnerOrAdmin {
        if (_royaltyLocked) revert RoyaltyIsLocked();
        if (royaltyBps > MAX_ROYALTY_BPS) revert RoyaltyTooHigh();
        _cfg.royaltyBps = royaltyBps;
        _cfg.royaltyReceiver = royaltyReceiver;
        emit RoyaltySet(royaltyBps, royaltyReceiver);
    }

    /// @notice One-way, optional: lock the royalty (bps and receiver)
    ///         permanently.
    function lockRoyalty() external onlyOwnerOrAdmin {
        if (_royaltyLocked) revert RoyaltyIsLocked();
        _royaltyLocked = true;
        emit RoyaltyLocked();
    }

    /// @notice Update the supply cap (0 = no cap). A cap below current usage
    ///         reverts.
    function setSupplyCap(uint256 supplyCap) external override onlyOwnerOrAdmin {
        if (_cfg.supplyLocked) revert SupplyIsLocked();
        if (supplyCap != 0) {
            uint256 floor_ = _mintedEver;
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

    /// @notice Grant or revoke an extension minter. Reverts once the minter
    ///         set is locked. A call that does not change the state is a
    ///         no-op. Revoking the current primary clears the pointer.
    function setMinter(address minter, bool allowed) external override onlyOwnerOrAdmin {
        if (minter == address(0)) revert ZeroMinter();
        if (_minterLocked) revert MinterIsLocked();
        if (_minters[minter] == allowed) return; // already in the requested state
        _minters[minter] = allowed;
        if (allowed) {
            _minterCount += 1;
        } else {
            _minterCount -= 1;
            if (minter == _primaryMinter) {
                _primaryMinter = address(0);
                emit PrimaryMinterSet(address(0));
            }
        }
        emit MinterSet(minter, allowed);
    }

    /// @notice Repoint the frontend-discovery default at `minter`, or clear
    ///         it with the zero address. `minter` must be a currently
    ///         granted minter. Reverts after lockMinter, so the primary
    ///         freezes with the rest of the minter set.
    function setPrimaryMinter(address minter) external override onlyOwnerOrAdmin {
        if (_minterLocked) revert MinterIsLocked();
        if (minter != address(0) && !_minters[minter]) revert PrimaryMinterNotAuthorized();
        _primaryMinter = minter;
        emit PrimaryMinterSet(minter);
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

    /// @notice One-way, optional. Freezes the list of authorized minters:
    ///         after this call, setMinter always reverts, so no one can add
    ///         or remove a minter. The lock does not stop minting. Every
    ///         minter granted before the lock keeps its authority and can
    ///         still mint. Locking with no minter granted leaves the
    ///         collection unable to mint, forever, because all minting goes
    ///         through authorized minters.
    function lockMinter() external override onlyOwnerOrAdmin {
        if (_minterLocked) revert MinterIsLocked();
        _minterLocked = true;
        emit MinterLocked();
    }

    /// @notice Owner-only, one transaction: engages every un-engaged lock
    ///         (renderer, supply, minter, royalty), then renounces
    ///         ownership. Sealing with zero granted minters permanently
    ///         ends minting: all minting goes through authorized minters,
    ///         and after this call no one can grant another.
    function seal() external onlyOwner {
        if (!_cfg.rendererLocked) {
            _cfg.rendererLocked = true;
            emit RendererLocked();
        }
        if (!_cfg.supplyLocked) {
            _cfg.supplyLocked = true;
            emit SupplyLocked();
        }
        if (!_minterLocked) {
            _minterLocked = true;
            emit MinterLocked();
        }
        if (!_royaltyLocked) {
            _royaltyLocked = true;
            emit RoyaltyLocked();
        }
        _transferOwnership(address(0));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Provenance + reads
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Mint-time entropy. Reverts NeverMinted for `tokenId == 0 ||
    ///         tokenId > mints-ever`. A stored seed is returned directly;
    ///         an in-range token with no stored seed (seedSource set at
    ///         mint time, no minter-supplied seed) falls back to
    ///         `seedSource`. Readable for a burned id.
    function tokenSeed(uint256 tokenId) external view override returns (bytes32) {
        if (tokenId == 0 || tokenId > _mintedEver) revert NeverMinted();
        bytes32 seed = _seed[tokenId];
        if (seed != bytes32(0)) return seed;
        return ISeedSourceV2(seedSource).seedOf(address(this), tokenId);
    }

    function totalSupply() public view returns (uint256) {
        return _mintedEver - _burnedCount;
    }

    function config() external view override returns (SurfaceConfig memory cfg, uint256 minted) {
        cfg = _cfg;
        minted = _mintedEver;
    }

    function renderer() public view override returns (address) {
        return _cfg.renderer;
    }

    function isMinter(address minter) external view override returns (bool) {
        return _minters[minter];
    }

    /// @notice Frontend-discovery default (see ISurfaceV2.primaryMinter).
    function primaryMinter() external view override returns (address) {
        return _primaryMinter;
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

    function isRoyaltyLocked() external view override returns (bool) {
        return _royaltyLocked;
    }

    /// @notice Compat shim for renderers built against v1's ISurfaceView:
    ///         always Sequential. Not a mutable setting.
    function idMode() public pure override returns (IdMode) {
        return IdMode.Sequential;
    }

    /// @notice Snapshot of every one-way lock plus renounce state, in one
    ///         call. `sealed_` is `owner() == address(0)`.
    function permanence()
        external
        view
        override
        returns (
            bool rendererLocked,
            bool supplyLocked,
            bool minterLocked,
            bool royaltyLocked,
            bool sealed_,
            uint256 version_
        )
    {
        return (_cfg.rendererLocked, _cfg.supplyLocked, _minterLocked, _royaltyLocked, owner() == address(0), version);
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

    /// @dev A renounced collection with no explicit royaltyReceiver resolves
    ///      to owner() == address(0). A nonzero amount there would send a
    ///      marketplace's royalty payment to the zero address, so the
    ///      function returns zero instead.
    function royaltyInfo(uint256, uint256 salePrice) external view returns (address receiver, uint256 royaltyAmount) {
        receiver = _cfg.royaltyReceiver == address(0) ? owner() : _cfg.royaltyReceiver;
        if (receiver == address(0)) return (address(0), 0);
        royaltyAmount = (salePrice * _cfg.royaltyBps) / BPS;
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721Upgradeable) returns (bool) {
        return interfaceId == INTERFACE_ID_ERC2981 || interfaceId == INTERFACE_ID_ERC4906
            || super.supportsInterface(interfaceId);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Self-custody guard
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Rejects any mint or transfer that would land a token at this
    ///      contract's own address: the collection has no code path to move
    ///      a token back out, so a token there is stranded permanently.
    ///      Covers mint, transfer, and safeTransfer, since OZ routes all of
    ///      them through _update; does not affect burns (to == address(0)).
    function _update(address to, uint256 tokenId, address auth)
        internal
        override(ERC721Upgradeable)
        returns (address)
    {
        if (to == address(this)) revert SelfCustodyRejected(tokenId);
        return super._update(to, tokenId, auth);
    }
}
