// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.20;

import {Clones} from "openzeppelin-contracts/contracts/proxy/Clones.sol";

import {PndAuctionHouse} from "./PndAuctionHouse.sol";

/// @title PND Auction House Factory (immutable)
/// @notice Deploys per-artist auction houses as EIP-1167 minimal-proxy clones.
///         All clones delegate to one fixed implementation deployed alongside
///         this factory. There is no admin, no upgrade path, no setters —
///         every parameter is locked at construction time.
/// @dev    To change the protocol fee, fee recipient, or the implementation,
///         deploy a new factory and migrate. By design — see PndAuctionHouse.
contract PndAuctionHouseFactory {
    /// @notice The PndAuctionHouse implementation. Clones delegate here.
    address public immutable implementation;

    /// @notice Protocol fee in basis points baked into every house this factory
    ///         deploys. Locked forever for this factory.
    uint16 public immutable defaultProtocolFeeBps;

    /// @notice Where each new house pays its protocol fee. Locked forever.
    address payable public immutable defaultFeeRecipient;

    /// @notice Lookup: artist address -> their deployed auction house (or zero).
    ///         An artist can only have one auction house from this factory.
    mapping(address => address) public houseOf;

    /// @notice All deployed houses, in order of creation.
    address[] public allHouses;

    /// @notice Reverse lookup so callers (the frontend) can cheaply ask
    ///         "is this address a PND auction house?" without enumerating.
    mapping(address => bool) public isHouse;

    /// @notice Emitted once per house. Includes the (immutable) fee terms so
    ///         indexers can recover them without an extra read.
    event AuctionHouseCreated(
        address indexed artist,
        address indexed house,
        address feeRecipient,
        uint16 protocolFeeBps
    );

    /// @param implementation_         PndAuctionHouse implementation address.
    ///                                Must be a deployed contract; an EOA or
    ///                                empty address is rejected so a typo'd
    ///                                deploy can't produce useless clones.
    /// @param defaultFeeRecipient_    Treasury that receives protocol fees.
    /// @param defaultProtocolFeeBps_  Protocol fee bps (<= 500). Locked forever.
    constructor(
        address implementation_,
        address payable defaultFeeRecipient_,
        uint16 defaultProtocolFeeBps_
    ) {
        require(implementation_ != address(0), "impl required");
        require(implementation_.code.length > 0, "implementation has no code");
        require(defaultProtocolFeeBps_ <= 500, "fee above cap");
        require(
            defaultProtocolFeeBps_ == 0 ||
                defaultFeeRecipient_ != address(0),
            "fee recipient required when fee > 0"
        );
        implementation = implementation_;
        defaultFeeRecipient = defaultFeeRecipient_;
        defaultProtocolFeeBps = defaultProtocolFeeBps_;
    }

    /// @notice Deploy a new auction house owned by msg.sender. The artist
    ///         identity is taken from the caller — there is no third-party
    ///         "create-on-behalf-of" path so a stranger can't squat on someone
    ///         else's slot in this factory.
    function createAuctionHouse() external returns (address house) {
        address artist = msg.sender;
        require(houseOf[artist] == address(0), "House already exists");

        house = Clones.clone(implementation);
        PndAuctionHouse(payable(house)).initialize(
            artist,
            defaultFeeRecipient,
            defaultProtocolFeeBps
        );

        houseOf[artist] = house;
        allHouses.push(house);
        isHouse[house] = true;

        emit AuctionHouseCreated(
            artist,
            house,
            defaultFeeRecipient,
            defaultProtocolFeeBps
        );
    }

    function totalHouses() external view returns (uint256) {
        return allHouses.length;
    }
}
