// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {SovereignAuctionHouse} from "../src/SovereignAuctionHouse.sol";
import {SovereignAuctionHouseFactory} from "../src/SovereignAuctionHouseFactory.sol";
import {IERC721} from "openzeppelin-contracts/contracts/token/ERC721/IERC721.sol";

/// @notice Mainnet fork test: deploy the full system + run an auction against a
///         real ERC721 NFT (BAYC 1234 — chosen because it's a vanilla ERC721,
///         publicly checkable, and its current owner can be impersonated).
///
/// Run with: MAINNET_RPC_URL=... forge test --fork-url $MAINNET_RPC_URL \
///           --match-path test/SovereignAuctionHouseFork.t.sol -vv
contract SovereignAuctionHouseForkTest is Test {
    IERC721 internal constant BAYC = IERC721(0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D);
    uint256 internal constant TOKEN_ID = 1234;

    address internal artist; // current owner of the NFT (impersonated)
    address internal alice = address(0xA1);
    address payable internal protocolTreasury = payable(address(0xFEE));

    SovereignAuctionHouseFactory internal factory;
    SovereignAuctionHouse internal house;

    function setUp() public {
        // Skip the suite when no fork URL is provided (regular `forge test` runs
        // shouldn't fail because of missing env vars).
        try vm.envString("MAINNET_RPC_URL") returns (string memory) {} catch {
            vm.skip(true);
        }

        // Resolve the real owner of the test NFT and impersonate them.
        artist = BAYC.ownerOf(TOKEN_ID);

        SovereignAuctionHouse impl = new SovereignAuctionHouse();
        factory = new SovereignAuctionHouseFactory(
            address(impl),
            protocolTreasury,
            250 // 2.5% protocol fee, locked for this factory
        );

        // Artist deploys their own house — createAuctionHouse uses msg.sender.
        vm.prank(artist);
        house = SovereignAuctionHouse(payable(factory.createAuctionHouse()));

        // Artist approves the house to escrow the NFT.
        vm.prank(artist);
        BAYC.setApprovalForAll(address(house), true);

        vm.deal(alice, 100 ether);
    }

    function test_Fork_FullAuctionFlow_RealERC721() public {
        // Artist creates an auction.
        vm.prank(artist);
        uint256 auctionId = house.createAuction(
            TOKEN_ID,
            address(BAYC),
            24 hours,
            10 ether
        );

        // NFT escrowed in the house.
        assertEq(BAYC.ownerOf(TOKEN_ID), address(house));

        // Alice bids at reserve.
        vm.prank(alice);
        house.createBid{value: 10 ether}(auctionId);

        // Time passes and the auction settles.
        vm.warp(block.timestamp + 24 hours + 1);

        uint256 artistBefore = artist.balance;
        uint256 treasuryBefore = protocolTreasury.balance;
        house.endAuction(auctionId);

        // NFT delivered to the winner.
        assertEq(BAYC.ownerOf(TOKEN_ID), alice);
        // 2.5% to protocol treasury, 97.5% to the artist.
        uint256 protocolFee = (10 ether * 250) / 10000;
        assertEq(protocolTreasury.balance - treasuryBefore, protocolFee);
        assertEq(artist.balance - artistBefore, 10 ether - protocolFee);
    }
}
