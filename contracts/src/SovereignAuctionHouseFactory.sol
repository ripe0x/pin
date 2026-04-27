// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.20;

import {Clones} from "openzeppelin-contracts/contracts/proxy/Clones.sol";

import {SovereignAuctionHouse} from "./SovereignAuctionHouse.sol";

/// @title Sovereign Auction House Factory (immutable)
/// @notice Deploys per-owner auction houses as EIP-1167 minimal-proxy clones.
///         Anyone — artist, collector, anonymous wallet — can call
///         createAuctionHouse and get back their own SovereignAuctionHouse
///         instance. All clones delegate to one fixed implementation deployed
///         alongside this factory. There is no admin, no upgrade path, no
///         setters — every parameter is locked at construction time.
/// @dev    To change the protocol fee, fee recipient, or the implementation,
///         deploy a new factory and migrate. By design — see
///         SovereignAuctionHouse.
contract SovereignAuctionHouseFactory {
    /// @notice The SovereignAuctionHouse implementation. Clones delegate here.
    address public immutable implementation;

    /// @notice Protocol fee in basis points baked into every house this factory
    ///         deploys. Locked forever for this factory.
    uint16 public immutable defaultProtocolFeeBps;

    /// @notice Where each new house pays its protocol fee. Locked forever.
    address payable public immutable defaultFeeRecipient;

    /// @notice Lookup: owner address -> their deployed auction house (or zero).
    ///         An address can only have one auction house from this factory.
    mapping(address => address) public houseOf;

    /// @notice All deployed houses, in order of creation.
    address[] public allHouses;

    /// @notice Reverse lookup so callers (the frontend) can cheaply ask
    ///         "is this address an auction house from this factory?" without
    ///         enumerating.
    mapping(address => bool) public isHouse;

    /// @notice Emitted once per house. Includes the (immutable) fee terms so
    ///         indexers can recover them without an extra read.
    event AuctionHouseCreated(
        address indexed owner,
        address indexed house,
        address feeRecipient,
        uint16 protocolFeeBps
    );

    /// @param implementation_         SovereignAuctionHouse implementation address.
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

    /// @notice Deploy a new auction house owned by msg.sender. The owner
    ///         identity is taken from the caller — there is no third-party
    ///         "create-on-behalf-of" path so a stranger can't squat on someone
    ///         else's slot in this factory.
    /// @dev    Reverts if the caller already has a house in this factory.
    ///         Uses CREATE2 (cloneDeterministic) keyed on the owner address
    ///         so the deployed house's address is predictable from the owner
    ///         alone via predictHouseAddress — handy for clients that want
    ///         to display "your house will live at 0x…" before the user
    ///         signs the deploy tx.
    /// @return house The address of the newly deployed clone.
    function createAuctionHouse() external returns (address house) {
        address owner = msg.sender;
        require(houseOf[owner] == address(0), "House already exists");

        bytes32 salt = bytes32(uint256(uint160(owner)));
        house = Clones.cloneDeterministic(implementation, salt);
        SovereignAuctionHouse(payable(house)).initialize(
            owner,
            defaultFeeRecipient,
            defaultProtocolFeeBps
        );

        houseOf[owner] = house;
        allHouses.push(house);
        isHouse[house] = true;

        emit AuctionHouseCreated(
            owner,
            house,
            defaultFeeRecipient,
            defaultProtocolFeeBps
        );
    }

    /// @notice Predict the address the auction house for `owner` will land at
    ///         (or already lives at). Salt is the owner address packed into
    ///         a bytes32 — same input createAuctionHouse uses. The returned
    ///         address is deterministic regardless of whether the house has
    ///         been deployed yet.
    /// @dev    NOTE: ETH or NFTs sent to the predicted address before the
    ///         house is deployed are not generally recoverable. Once deployed
    ///         the clone's `receive()` reverts new ETH sends and
    ///         `recoverStuckERC721` works for NFTs that arrived post-deploy,
    ///         but pre-deploy ETH sits at the address with no withdraw path.
    function predictHouseAddress(address owner) external view returns (address) {
        return Clones.predictDeterministicAddress(
            implementation,
            bytes32(uint256(uint160(owner)))
        );
    }

    /// @notice Number of auction houses deployed by this factory.
    function totalHouses() external view returns (uint256) {
        return allHouses.length;
    }
}
