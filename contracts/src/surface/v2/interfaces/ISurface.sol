// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

/// @title ISurface (v2)
/// @notice The token primitive: an ERC721 collection whose ids equal mint
///         order, one minter slot, a renderer pointer, a supply cap and an
///         EIP-2981 royalty. Every setter is owner-only; renouncing
///         ownership is the only permanence mechanism. Sales, gates and
///         other companions borrow authority by reading `owner()`.
interface ISurface {
    // ── errors ──────────────────────────────────────────────────────────────
    error RendererRequired();
    error RendererNotContract(address renderer);
    error RoyaltyReceiverRequired();
    error RoyaltyTooHigh(uint16 bps);
    error MinterRequired();
    error NotMinter();
    error NotAuthorized();
    error ZeroQuantity();
    error ExceedsCap(uint256 cap, uint256 attempted);
    error BadSupplyCap(uint256 minted, uint256 cap);
    error NeverMinted(uint256 tokenId);
    error SelfCustodyRejected();

    // ── events ──────────────────────────────────────────────────────────────
    event Minted(address indexed minter, address indexed to, uint256 firstTokenId, uint256 quantity);
    event Burned(uint256 indexed tokenId);
    event RendererSet(address indexed renderer);
    event MinterSet(address indexed minter);
    event SupplyCapSet(uint256 supplyCap);
    event RoyaltySet(uint16 bps, address indexed receiver);
    event NameSet(string name, string symbol);
    /// @dev ERC-4906.
    event BatchMetadataUpdate(uint256 fromTokenId, uint256 toTokenId);
    /// @dev ERC-7572.
    event ContractURIUpdated();

    // ── mint and burn ───────────────────────────────────────────────────────
    function mintTo(address to, uint256 quantity) external returns (uint256 firstTokenId);

    function burn(uint256 tokenId) external;

    // ── owner setters ───────────────────────────────────────────────────────
    function setRenderer(address renderer) external;

    function setMinter(address minter) external;

    function setSupplyCap(uint256 supplyCap) external;

    function setRoyalty(uint16 bps, address receiver) external;

    function setName(string calldata name, string calldata symbol) external;

    function notifyMetadataUpdate(uint256 fromTokenId, uint256 toTokenId) external;

    // ── reads ───────────────────────────────────────────────────────────────
    function owner() external view returns (address);

    function renderer() external view returns (address);

    function minter() external view returns (address);

    function supplyCap() external view returns (uint256);

    function totalSupply() external view returns (uint256);

    function tokenSeed(uint256 tokenId) external view returns (bytes32);

    function config()
        external
        view
        returns (
            address renderer,
            address minter,
            uint256 supplyCap,
            uint16 royaltyBps,
            address royaltyReceiver,
            uint256 minted
        );

    function contractURI() external view returns (string memory);

    function version() external view returns (uint256);
}
