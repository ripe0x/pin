// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {PndAuctionHouse} from "../src/PndAuctionHouse.sol";
import {PndAuctionHouseFactory} from "../src/PndAuctionHouseFactory.sol";
import {UpgradeableBeacon} from "openzeppelin-contracts/contracts/proxy/beacon/UpgradeableBeacon.sol";
import {MockERC721} from "./MockERC721.sol";

/// @notice Extends PndAuctionHouse with one new view to prove the beacon
///         upgrade routes calls to the new implementation while preserving
///         existing storage.
contract PndAuctionHouseV2 is PndAuctionHouse {
    function version() external pure returns (string memory) {
        return "v2";
    }
}

contract PndAuctionHouseUpgradeTest is Test {
    PndAuctionHouseFactory internal factory;
    MockERC721 internal nft;

    address internal artist = address(0xA11CE);
    address internal alice = address(0xA1);
    address internal pndAdmin = address(0xAD);
    address payable internal pndTreasury = payable(address(0xFEE));
    address internal beaconOwner = address(0xBEAC);
    address internal factoryOwner = address(0xFAC);

    function setUp() public {
        nft = new MockERC721();
        nft.mint(artist, 1);
        nft.mint(artist, 2);

        PndAuctionHouse impl = new PndAuctionHouse();
        factory = new PndAuctionHouseFactory(
            address(impl),
            beaconOwner,
            factoryOwner,
            pndAdmin,
            pndTreasury,
            0
        );
        vm.deal(alice, 100 ether);
    }

    function test_BeaconUpgrade_AppliesToAllClones_PreservesState() public {
        // Two artists deploy houses BEFORE the upgrade.
        address aliceHouseAddr = factory.createAuctionHouse(alice);
        address artistHouseAddr = factory.createAuctionHouse(artist);

        PndAuctionHouse artistHouse = PndAuctionHouse(payable(artistHouseAddr));

        // Artist creates an auction so we have state to preserve.
        vm.prank(artist);
        nft.setApprovalForAll(artistHouseAddr, true);
        vm.prank(artist);
        uint256 auctionId = artistHouse.createAuction(
            1,
            address(nft),
            24 hours,
            1 ether,
            payable(address(0)),
            0
        );
        vm.prank(alice);
        artistHouse.createBid{value: 1 ether}(auctionId);

        // Pre-upgrade: V2 selector doesn't exist.
        (bool ok, ) = aliceHouseAddr.call(abi.encodeWithSignature("version()"));
        assertFalse(ok);

        // Beacon owner ships the upgrade.
        PndAuctionHouseV2 v2 = new PndAuctionHouseV2();
        UpgradeableBeacon beacon = factory.beacon();
        vm.prank(beaconOwner);
        beacon.upgradeTo(address(v2));

        // Post-upgrade: V2 selector now resolves on EVERY clone.
        PndAuctionHouseV2 aliceHouseAsV2 = PndAuctionHouseV2(payable(aliceHouseAddr));
        PndAuctionHouseV2 artistHouseAsV2 = PndAuctionHouseV2(payable(artistHouseAddr));
        assertEq(aliceHouseAsV2.version(), "v2");
        assertEq(artistHouseAsV2.version(), "v2");

        // State preserved on the upgraded clone — auction still there with the bid.
        ( , , , uint256 amount, , , , , , address payable bidder, ) = artistHouseAsV2.auctions(auctionId);
        assertEq(amount, 1 ether);
        assertEq(bidder, alice);
        assertEq(artistHouseAsV2.owner(), artist);
        assertEq(artistHouseAsV2.protocolFeeAdmin(), pndAdmin);
    }

    function test_BeaconUpgrade_OnlyBeaconOwnerCanUpgrade() public {
        PndAuctionHouseV2 v2 = new PndAuctionHouseV2();
        UpgradeableBeacon beacon = factory.beacon();
        vm.expectRevert();
        vm.prank(alice);
        beacon.upgradeTo(address(v2));
    }
}
