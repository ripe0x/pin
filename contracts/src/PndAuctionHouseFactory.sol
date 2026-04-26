// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.20;

import {UpgradeableBeacon} from "openzeppelin-contracts/contracts/proxy/beacon/UpgradeableBeacon.sol";
import {BeaconProxy} from "openzeppelin-contracts/contracts/proxy/beacon/BeaconProxy.sol";
import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";

import {PndAuctionHouse} from "./PndAuctionHouse.sol";

/// @title PND Auction House Factory
/// @notice Deploys per-artist auction houses as BeaconProxy clones. All clones
///         share one upgradeable implementation via the beacon — security
///         patches reach every artist with one transaction.
/// @dev    The factory owner controls the initial deploy (e.g. PND ops). The
///         beacon is owned by a separate (configurable) admin so we can split
///         "operate factory" from "ship implementation upgrades".
contract PndAuctionHouseFactory is Ownable {
    /// @notice Deployed beacon. Its `implementation()` is the active impl.
    UpgradeableBeacon public immutable beacon;

    /// @notice Default protocol-fee admin baked into newly-deployed houses.
    address public defaultProtocolFeeAdmin;

    /// @notice Default fee recipient baked into newly-deployed houses.
    address payable public defaultFeeRecipient;

    /// @notice Default protocol fee in basis points for newly-deployed houses.
    uint16 public defaultProtocolFeeBps;

    /// @notice Lookup: artist address -> their deployed auction house (or zero).
    ///         An artist can only have one auction house from this factory.
    mapping(address => address) public houseOf;

    /// @notice All deployed houses, in order of creation. Convenience for
    ///         enumeration and indexing.
    address[] public allHouses;

    /// @notice Reverse lookup so callers (the frontend) can cheaply ask
    ///         "is this address a PND auction house?" without enumerating.
    mapping(address => bool) public isHouse;

    event AuctionHouseCreated(address indexed artist, address house);
    event DefaultProtocolFeeAdminUpdated(address newAdmin);
    event DefaultFeeRecipientUpdated(address newRecipient);
    event DefaultProtocolFeeBpsUpdated(uint16 newBps);

    /// @param implementation_      Initial PndAuctionHouse implementation address.
    /// @param beaconOwner          Owner of the beacon (controls upgrades). May
    ///                             differ from factory owner so that "operate
    ///                             factory" and "upgrade implementation" can be
    ///                             separate keys.
    /// @param factoryOwner         Owner of this factory.
    /// @param defaultProtocolFeeAdmin_ Address baked in as protocolFeeAdmin on new houses.
    /// @param defaultFeeRecipient_     Address baked in as feeRecipient on new houses.
    /// @param defaultProtocolFeeBps_   Initial protocolFeeBps for new houses (<= cap).
    constructor(
        address implementation_,
        address beaconOwner,
        address factoryOwner,
        address defaultProtocolFeeAdmin_,
        address payable defaultFeeRecipient_,
        uint16 defaultProtocolFeeBps_
    ) Ownable(factoryOwner) {
        require(implementation_ != address(0), "impl required");
        require(beaconOwner != address(0), "beacon owner required");
        require(defaultProtocolFeeAdmin_ != address(0), "fee admin required");
        require(defaultProtocolFeeBps_ <= 500, "Above cap");
        beacon = new UpgradeableBeacon(implementation_, beaconOwner);
        defaultProtocolFeeAdmin = defaultProtocolFeeAdmin_;
        defaultFeeRecipient = defaultFeeRecipient_;
        defaultProtocolFeeBps = defaultProtocolFeeBps_;
    }

    /// @notice Deploy a new auction house owned by `artist`. Anyone can call;
    ///         a single artist can only have one house from this factory.
    function createAuctionHouse(address artist) external returns (address house) {
        require(artist != address(0), "artist required");
        require(houseOf[artist] == address(0), "House already exists");

        bytes memory initData = abi.encodeWithSelector(
            PndAuctionHouse.initialize.selector,
            artist,
            defaultProtocolFeeAdmin,
            defaultFeeRecipient,
            defaultProtocolFeeBps
        );

        BeaconProxy proxy = new BeaconProxy(address(beacon), initData);
        house = address(proxy);
        houseOf[artist] = house;
        allHouses.push(house);
        isHouse[house] = true;

        emit AuctionHouseCreated(artist, house);
    }

    function totalHouses() external view returns (uint256) {
        return allHouses.length;
    }

    /// @notice Update default protocol-fee admin baked into FUTURE houses.
    ///         Existing houses are unaffected (they have their own state).
    function setDefaultProtocolFeeAdmin(address newAdmin) external onlyOwner {
        require(newAdmin != address(0), "Zero address");
        defaultProtocolFeeAdmin = newAdmin;
        emit DefaultProtocolFeeAdminUpdated(newAdmin);
    }

    function setDefaultFeeRecipient(address payable newRecipient) external onlyOwner {
        defaultFeeRecipient = newRecipient;
        emit DefaultFeeRecipientUpdated(newRecipient);
    }

    function setDefaultProtocolFeeBps(uint16 newBps) external onlyOwner {
        // Soft-validate — the impl re-checks against its own cap on initialize.
        require(newBps <= 500, "Above cap");
        defaultProtocolFeeBps = newBps;
        emit DefaultProtocolFeeBpsUpdated(newBps);
    }
}
