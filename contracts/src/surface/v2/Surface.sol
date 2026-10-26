// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {ERC721Upgradeable} from "openzeppelin-contracts-upgradeable/contracts/token/ERC721/ERC721Upgradeable.sol";
import {OwnableUpgradeable} from "openzeppelin-contracts-upgradeable/contracts/access/OwnableUpgradeable.sol";
import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";

import {ISurface} from "./interfaces/ISurface.sol";
import {IRenderer} from "../interfaces/IRenderer.sol";

/// @title Surface (v2)
/// @notice The token primitive. Ids equal mint order (1, 2, 3, ...) and are
///         never reused. One minter slot mints; the owner sets the renderer,
///         minter, cap, royalty and name. Renouncing ownership freezes all
///         of it. Stores one mint-time seed per token and holds no value.
///
/// @dev    Deployed as immutable EIP-1167 clones through a CloneFactory. The
///         OZ upgradeable bases are used only for the initializer pattern.
///         Name and symbol live in this contract's own storage (not the OZ
///         ERC721 slots) so setName can change them; __ERC721_init is not
///         called.
contract Surface is ERC721Upgradeable, OwnableUpgradeable, ISurface {
    /// @notice Implementation lineage marker. The v1 core reports 1.
    uint256 public constant override version = 2;

    uint16 internal constant BPS = 10_000;
    /// @dev EIP-2981 is advisory. The ceiling caps what a launcher caller can
    ///      set on an owner's behalf.
    uint16 internal constant MAX_ROYALTY_BPS = 5_000;
    bytes4 internal constant INTERFACE_ID_ERC2981 = 0x2a55205a;
    bytes4 internal constant INTERFACE_ID_ERC4906 = 0x49064906;

    address public override renderer;
    /// @notice The one address allowed to call mintTo. 0 = no one can mint.
    address public override minter;
    /// @notice Lifetime mint ceiling. 0 = open. Burns never free room.
    uint256 public override supplyCap;
    uint16 public royaltyBps;
    address public royaltyReceiver;

    uint256 internal _mintedEver;
    uint256 internal _burnedCount;
    /// @dev The only per-token storage: mint-time entropy that cannot be
    ///      recreated later.
    mapping(uint256 => bytes32) internal _seed;

    string internal _name;
    string internal _symbol;

    constructor() {
        _disableInitializers();
    }

    function initialize(
        string calldata name_,
        string calldata symbol_,
        address owner_,
        address renderer_,
        uint256 supplyCap_,
        uint16 royaltyBps_,
        address royaltyReceiver_,
        address minter_
    ) external initializer {
        // __Ownable_init rejects a zero owner (OwnableInvalidOwner).
        __Ownable_init(owner_);
        // Not checked for code: the launcher passes a sale's predicted
        // address before the sale is deployed.
        if (minter_ == address(0)) revert MinterRequired();
        _name = name_;
        _symbol = symbol_;
        _setRenderer(renderer_);
        _setRoyalty(royaltyBps_, royaltyReceiver_);
        supplyCap = supplyCap_;
        emit SupplyCapSet(supplyCap_);
        minter = minter_;
        emit MinterSet(minter_);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Mint and burn
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Minter only. Mints ids `firstTokenId .. firstTokenId +
    ///         quantity - 1` to `to` and stores each token's seed. Uses
    ///         _mint, never _safeMint: the mint path makes no external call.
    ///         A minter that wants a receiver check does it itself.
    function mintTo(address to, uint256 quantity) external override returns (uint256 firstTokenId) {
        if (msg.sender != minter) revert NotMinter();
        if (quantity == 0) revert ZeroQuantity();
        uint256 mintedEver = _mintedEver;
        uint256 cap = supplyCap;
        if (cap != 0 && mintedEver + quantity > cap) revert ExceedsCap(cap, mintedEver + quantity);
        firstTokenId = mintedEver + 1;
        for (uint256 i = 0; i < quantity; i++) {
            uint256 tokenId = firstTokenId + i;
            _mint(to, tokenId);
            // Spec: docs/injection-convention.md. Excludes the recipient so a
            // minter cannot grind wallets for a favorable seed.
            _seed[tokenId] = keccak256(abi.encode(block.prevrandao, address(this), tokenId));
        }
        _mintedEver = mintedEver + quantity;
        emit Minted(msg.sender, to, firstTokenId, quantity);
    }

    /// @notice Holder or approved. Burns never free cap; the seed stays
    ///         readable.
    function burn(uint256 tokenId) external override {
        // The auth argument makes OZ check owner-or-approved
        // (ERC721InsufficientApproval / ERC721NonexistentToken).
        _update(address(0), tokenId, msg.sender);
        _burnedCount += 1;
        emit Burned(tokenId);
    }

    function totalSupply() external view override returns (uint256) {
        return _mintedEver - _burnedCount;
    }

    /// @dev Rejects transfers and mints into the collection's own address,
    ///      where a token could never move again.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        if (to == address(this)) revert SelfCustodyRejected();
        return super._update(to, tokenId, auth);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Owner setters
    // ─────────────────────────────────────────────────────────────────────────

    function setRenderer(address renderer_) external override onlyOwner {
        _setRenderer(renderer_);
        emit BatchMetadataUpdate(0, type(uint256).max);
        emit ContractURIUpdated();
    }

    /// @notice Zero is allowed: nobody can mint until a minter is set again.
    function setMinter(address minter_) external override onlyOwner {
        minter = minter_;
        emit MinterSet(minter_);
    }

    /// @notice 0 = open. A nonzero cap below the lifetime mint count reverts.
    function setSupplyCap(uint256 supplyCap_) external override onlyOwner {
        uint256 mintedEver = _mintedEver;
        if (supplyCap_ != 0 && supplyCap_ < mintedEver) revert BadSupplyCap(mintedEver, supplyCap_);
        supplyCap = supplyCap_;
        emit SupplyCapSet(supplyCap_);
    }

    function setRoyalty(uint16 bps, address receiver) external override onlyOwner {
        _setRoyalty(bps, receiver);
    }

    function setName(string calldata name_, string calldata symbol_) external override onlyOwner {
        _name = name_;
        _symbol = symbol_;
        emit NameSet(name_, symbol_);
        emit BatchMetadataUpdate(0, type(uint256).max);
        emit ContractURIUpdated();
    }

    /// @notice ERC-4906 refresh for changes the token cannot observe (a live
    ///         work's output, a reveal). Callable by the renderer or the
    ///         owner, so a renderer can still signal after a renounce.
    function notifyMetadataUpdate(uint256 fromTokenId, uint256 toTokenId) external override {
        if (msg.sender != renderer && msg.sender != owner()) revert NotAuthorized();
        emit BatchMetadataUpdate(fromTokenId, toTokenId);
    }

    function _setRenderer(address renderer_) internal {
        if (renderer_ == address(0)) revert RendererRequired();
        if (renderer_.code.length == 0) revert RendererNotContract(renderer_);
        renderer = renderer_;
        emit RendererSet(renderer_);
    }

    function _setRoyalty(uint16 bps, address receiver) internal {
        if (receiver == address(0)) revert RoyaltyReceiverRequired();
        if (bps > MAX_ROYALTY_BPS) revert RoyaltyTooHigh(bps);
        royaltyBps = bps;
        royaltyReceiver = receiver;
        emit RoyaltySet(bps, receiver);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Reads
    // ─────────────────────────────────────────────────────────────────────────

    function owner() public view override(OwnableUpgradeable, ISurface) returns (address) {
        return super.owner();
    }

    function name() public view override returns (string memory) {
        return _name;
    }

    function symbol() public view override returns (string memory) {
        return _symbol;
    }

    /// @notice Mint-time entropy. Reverts NeverMinted for an id outside
    ///         1..mintedEver; stays readable after a burn.
    function tokenSeed(uint256 tokenId) external view override returns (bytes32) {
        if (tokenId == 0 || tokenId > _mintedEver) revert NeverMinted(tokenId);
        return _seed[tokenId];
    }

    function config()
        external
        view
        override
        returns (
            address renderer_,
            address minter_,
            uint256 supplyCap_,
            uint16 royaltyBps_,
            address royaltyReceiver_,
            uint256 minted
        )
    {
        return (renderer, minter, supplyCap, royaltyBps, royaltyReceiver, _mintedEver);
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return IRenderer(renderer).tokenURI(address(this), tokenId);
    }

    function contractURI() external view override returns (string memory) {
        return IRenderer(renderer).contractURI(address(this));
    }

    /// @notice EIP-2981. The same receiver and rate for every token. mulDiv
    ///         so any salePrice answers instead of overflowing.
    function royaltyInfo(uint256, uint256 salePrice) external view returns (address, uint256) {
        return (royaltyReceiver, Math.mulDiv(salePrice, royaltyBps, BPS));
    }

    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == INTERFACE_ID_ERC2981 || interfaceId == INTERFACE_ID_ERC4906
            || super.supportsInterface(interfaceId);
    }
}
