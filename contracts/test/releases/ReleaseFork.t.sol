// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC721} from "openzeppelin-contracts/contracts/token/ERC721/IERC721.sol";

import {Release} from "../../src/releases/Release.sol";
import {ReleaseFactory} from "../../src/releases/ReleaseFactory.sol";
import {GateMode, ReleaseParams} from "../../src/releases/IRelease.sol";
import {DeployReleases} from "../../script/DeployReleases.s.sol";

/// @notice Mainnet fork tests: the continuation gates against real chain
///         state. HOLD is exercised against BAYC (a vanilla foreign ERC721
///         we didn't write, current holder impersonated — same pattern as
///         SovereignAuctionHouseFork). BURN's owner-or-approved
///         burn(uint256) requirement is exercised cross-release on the
///         fork; note that e.g. Foundation's shared contract does NOT
///         qualify as a BURN gate (its burn is creator-restricted —
///         verified), which is exactly why HOLD exists for arbitrary
///         foreign 721s.
///
/// Run with: MAINNET_RPC_URL=https://ethereum-rpc.publicnode.com \
///           forge test --fork-url $MAINNET_RPC_URL \
///           --match-path test/releases/ReleaseFork.t.sol -vv
contract ReleaseForkTest is Test {
    IERC721 internal constant BAYC =
        IERC721(0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D);
    uint256 internal constant TOKEN_ID = 1234;
    uint256 internal constant PRICE = 0.01 ether;

    ReleaseFactory internal factory;
    address internal artist = makeAddr("artist");
    address internal holder; // real BAYC holder, impersonated
    address internal pnd = makeAddr("pnd");

    function setUp() public {
        // Skip when no fork URL is provided (regular `forge test` runs
        // shouldn't fail because of missing env vars).
        try vm.envString("MAINNET_RPC_URL") returns (string memory) {} catch {
            vm.skip(true);
        }

        holder = BAYC.ownerOf(TOKEN_ID);
        vm.deal(holder, 10 ether);
        factory = new ReleaseFactory(pnd, 0.002 ether, 0.0005 ether);
    }

    function _params() internal view returns (ReleaseParams memory p) {
        p = ReleaseParams({
            name: "Fork Release",
            symbol: "FORK",
            price: PRICE,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp + 3 days),
            maxSupply: 0,
            gateToken: address(0),
            gateMode: GateMode.NONE,
            payout: address(0),
            royaltyReceiver: address(0),
            royaltyBps: 500,
            uri: "ipfs://meta.json",
            uriPerToken: false,
            renderer: address(0),
            contractURI: ""
        });
    }

    function test_fork_holdGateAgainstRealForeign721() public {
        ReleaseParams memory p = _params();
        p.gateToken = address(BAYC);
        p.gateMode = GateMode.HOLD;
        vm.prank(artist);
        Release r = Release(factory.createRelease(p));

        uint256[] memory ids = new uint256[](1);
        ids[0] = TOKEN_ID;

        // A non-holder can't claim with someone else's token.
        vm.deal(pnd, 1 ether);
        vm.prank(pnd);
        vm.expectRevert("not source owner");
        r.mintGated{value: PRICE}(pnd, ids, address(0));

        // The real holder claims; their BAYC is untouched and spent.
        vm.prank(holder);
        r.mintGated{value: PRICE}(holder, ids, address(0));

        assertEq(r.ownerOf(1), holder);
        assertEq(BAYC.ownerOf(TOKEN_ID), holder);
        assertTrue(r.gateUsed(TOKEN_ID));

        vm.prank(holder);
        vm.expectRevert("source already used");
        r.mintGated{value: PRICE}(holder, ids, address(0));
    }

    function test_fork_burnGateCrossRelease() public {
        // Release A on the fork…
        vm.prank(artist);
        Release a = Release(factory.createRelease(_params()));
        vm.prank(holder);
        a.mint{value: PRICE}(holder, 1, address(0));

        // …burned into release C.
        ReleaseParams memory pc = _params();
        pc.gateToken = address(a);
        pc.gateMode = GateMode.BURN;
        pc.price = 0;
        vm.prank(artist);
        Release c = Release(factory.createRelease(pc));

        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        vm.startPrank(holder);
        a.setApprovalForAll(address(c), true);
        c.mintGated(holder, ids, address(0));
        vm.stopPrank();

        assertEq(c.ownerOf(1), holder);
        assertEq(a.totalSupply(), 0);
    }

    function test_fork_deployScriptDryRun() public {
        ReleaseFactory deployed = new DeployReleases().run();
        assertEq(deployed.surfaceFee(), 0.0005 ether);
        assertEq(deployed.maxSurfaceFee(), 0.002 ether);
    }

    function test_fork_endToEndEconomics() public {
        vm.prank(artist);
        Release r = Release(factory.createRelease(_params()));

        // Served by PND's surface…
        vm.prank(holder);
        r.mint{value: 2 * (PRICE + 0.0005 ether)}(holder, 2, pnd);
        // …and direct with no surface.
        vm.prank(holder);
        r.mint{value: PRICE}(holder, 1, address(0));

        assertEq(r.artistBalance(), 3 * PRICE);
        assertEq(r.owed(pnd), 2 * 0.0005 ether);

        uint256 artistBefore = artist.balance;
        uint256 pndBefore = pnd.balance;
        r.withdraw();
        r.claimSurfaceFees(pnd);
        assertEq(artist.balance - artistBefore, 3 * PRICE);
        assertEq(pnd.balance - pndBefore, 2 * 0.0005 ether);
        assertEq(address(r).balance, 0);
    }
}
