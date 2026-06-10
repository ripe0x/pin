// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";
import {IERC721A} from "erc721a/contracts/IERC721A.sol";

import {ReleasesTestBase} from "./ReleasesTestBase.sol";
import {Release} from "../../src/releases/Release.sol";
import {
    GateMode,
    IRelease,
    ReleaseParams,
    ReleaseStatus,
    ReleaseSummary
} from "../../src/releases/IRelease.sol";
import {GreedyPayout, StaticRenderer} from "./ReleasesMocks.sol";
import {RevertingReceiver} from "../RevertingReceiver.sol";

contract ReleaseTest is ReleasesTestBase {
    Release internal r;

    function setUp() public override {
        super.setUp();
        r = createDefault();
    }

    // ── Window ───────────────────────────────────────────────────────────

    function test_mint_beforeStartReverts() public {
        ReleaseParams memory p = defaultParams();
        p.startTime = uint64(block.timestamp + 1 hours);
        p.endTime = uint64(block.timestamp + 1 days);
        Release scheduled = createRelease(p);

        vm.prank(collector);
        vm.expectRevert("release not started");
        scheduled.mint{value: PRICE}(collector, 1, address(0));
        assertEq(uint8(scheduled.status()), uint8(ReleaseStatus.Scheduled));

        // Inclusive start: the first second of the window mints.
        vm.warp(p.startTime);
        vm.prank(collector);
        scheduled.mint{value: PRICE}(collector, 1, address(0));
        assertEq(scheduled.balanceOf(collector), 1);
    }

    function test_mint_windowEndBoundary() public {
        uint64 end = r.endTime();

        // Last second inside the window.
        vm.warp(end - 1);
        vm.prank(collector);
        r.mint{value: PRICE}(collector, 1, address(0));

        // Exclusive end: the closing second is outside.
        vm.warp(end);
        vm.prank(collector);
        vm.expectRevert("release ended");
        r.mint{value: PRICE}(collector, 1, address(0));
        assertEq(uint8(r.status()), uint8(ReleaseStatus.Ended));
    }

    function test_mint_openEndedRunsUntilClosed() public {
        ReleaseParams memory p = defaultParams();
        p.endTime = 0;
        Release open = createRelease(p);

        vm.warp(block.timestamp + 365 days);
        vm.prank(collector);
        open.mint{value: PRICE}(collector, 1, address(0));
        assertEq(uint8(open.status()), uint8(ReleaseStatus.Live));

        vm.prank(artist);
        open.close();
        vm.prank(collector);
        vm.expectRevert("release closed");
        open.mint{value: PRICE}(collector, 1, address(0));
    }

    function test_close_isOneWayAndOwnerOnly() public {
        vm.prank(collector);
        vm.expectRevert(
            abi.encodeWithSelector(
                Ownable.OwnableUnauthorizedAccount.selector,
                collector
            )
        );
        r.close();

        vm.prank(artist);
        vm.expectEmit();
        emit IRelease.Closed();
        r.close();
        assertTrue(r.closed());
        assertEq(uint8(r.status()), uint8(ReleaseStatus.Closed));

        vm.prank(artist);
        vm.expectRevert("already closed");
        r.close();
    }

    function test_close_beforeOpenIsCancel() public {
        ReleaseParams memory p = defaultParams();
        p.startTime = uint64(block.timestamp + 1 days);
        p.endTime = uint64(block.timestamp + 2 days);
        Release scheduled = createRelease(p);

        vm.prank(artist);
        scheduled.close();

        vm.warp(p.startTime);
        vm.prank(collector);
        vm.expectRevert("release closed");
        scheduled.mint{value: PRICE}(collector, 1, address(0));
    }

    // ── Pricing ──────────────────────────────────────────────────────────

    function test_mint_noSurfacePaysPriceOnly() public {
        vm.prank(collector);
        vm.expectEmit();
        emit IRelease.Minted(collector, address(0), 1, 2, 2 * PRICE, 0);
        r.mint{value: 2 * PRICE}(collector, 2, address(0));

        assertEq(r.artistBalance(), 2 * PRICE);
        assertEq(r.owed(address(0)), 0);
        assertEq(address(r).balance, 2 * PRICE);
    }

    function test_mint_withSurfacePaysPricePlusFeePerToken() public {
        uint256 cost = 3 * (PRICE + SURFACE_FEE);
        vm.prank(collector);
        vm.expectEmit();
        emit IRelease.Minted(collector, pnd, 1, 3, 3 * PRICE, 3 * SURFACE_FEE);
        r.mint{value: cost}(collector, 3, pnd);

        // The artist's leg is untouched by the surface's.
        assertEq(r.artistBalance(), 3 * PRICE);
        assertEq(r.owed(pnd), 3 * SURFACE_FEE);
        assertEq(address(r).balance, cost);
    }

    function test_mint_exactValueRequired() public {
        // Underpay, overpay, off-by-one in both directions, fee omitted,
        // fee included when no surface named: all revert.
        uint256 cost = PRICE + SURFACE_FEE;
        vm.startPrank(collector);

        vm.expectRevert("wrong payment");
        r.mint{value: cost - 1}(collector, 1, pnd);
        vm.expectRevert("wrong payment");
        r.mint{value: cost + 1}(collector, 1, pnd);
        vm.expectRevert("wrong payment");
        r.mint{value: PRICE}(collector, 1, pnd); // fee omitted
        vm.expectRevert("wrong payment");
        r.mint{value: cost}(collector, 1, address(0)); // unowed fee sent
        vm.expectRevert("wrong payment");
        r.mint{value: 0}(collector, 1, address(0));

        vm.stopPrank();
    }

    function test_mint_freeIsFreeOnEverySurface() public {
        ReleaseParams memory p = defaultParams();
        p.price = 0;
        Release free = createRelease(p);

        // Gas only — even when a surface is named, even PND's.
        vm.startPrank(collector);
        free.mint(collector, 5, address(0));
        free.mint(collector, 5, pnd);
        free.mint(collector, 5, collector);

        // Any value at all reverts, on any surface.
        vm.expectRevert("wrong payment");
        free.mint{value: 1}(collector, 1, address(0));
        vm.expectRevert("wrong payment");
        free.mint{value: 1}(collector, 1, pnd);
        vm.stopPrank();

        assertEq(free.balanceOf(collector), 15);
        assertEq(free.artistBalance(), 0);
        assertEq(free.owed(pnd), 0);
        assertEq(address(free).balance, 0);
    }

    function test_mint_feeToSelfIsHarmless() public {
        // A minter naming themselves as surface pays the fee to
        // themselves. Net cost = price + gas; the artist's leg is
        // identical either way.
        uint256 cost = PRICE + SURFACE_FEE;
        vm.prank(collector);
        r.mint{value: cost}(collector, 1, collector);

        assertEq(r.artistBalance(), PRICE);
        assertEq(r.owed(collector), SURFACE_FEE);

        uint256 balBefore = collector.balance;
        r.claimSurfaceFees(collector);
        assertEq(collector.balance - balBefore, SURFACE_FEE);
    }

    function test_mint_giftToAnotherRecipient() public {
        vm.prank(collector);
        r.mint{value: PRICE}(other, 1, address(0));
        assertEq(r.ownerOf(1), other);
    }

    function test_mint_zeroQuantityReverts() public {
        vm.prank(collector);
        vm.expectRevert(IERC721A.MintZeroQuantity.selector);
        r.mint{value: 0}(collector, 0, address(0));
    }

    // ── Supply ───────────────────────────────────────────────────────────

    function _cappedRelease(uint64 cap) internal returns (Release) {
        ReleaseParams memory p = defaultParams();
        p.maxSupply = cap;
        return createRelease(p);
    }

    function test_mint_capBoundary() public {
        Release capped = _cappedRelease(5);

        vm.startPrank(collector);
        capped.mint{value: 3 * PRICE}(collector, 3, address(0));

        // Over the remainder reverts whole — no partial fill.
        vm.expectRevert("exceeds max supply");
        capped.mint{value: 3 * PRICE}(collector, 3, address(0));

        // The exact remainder mints.
        capped.mint{value: 2 * PRICE}(collector, 2, address(0));
        vm.stopPrank();

        assertEq(capped.totalMinted(), 5);
        assertEq(uint8(capped.status()), uint8(ReleaseStatus.SoldOut));

        vm.prank(collector);
        vm.expectRevert("exceeds max supply");
        capped.mint{value: PRICE}(collector, 1, address(0));
    }

    function test_burn_doesNotReopenCap() public {
        Release capped = _cappedRelease(2);
        vm.startPrank(collector);
        capped.mint{value: 2 * PRICE}(collector, 2, address(0));
        capped.burn(1);
        vm.expectRevert("exceeds max supply");
        capped.mint{value: PRICE}(collector, 1, address(0));
        vm.stopPrank();

        assertEq(capped.totalSupply(), 1);
        assertEq(capped.totalMinted(), 2);
    }

    function test_status_closedBeatsSoldOut() public {
        Release capped = _cappedRelease(1);
        vm.prank(collector);
        capped.mint{value: PRICE}(collector, 1, address(0));
        vm.prank(artist);
        capped.close();
        assertEq(uint8(capped.status()), uint8(ReleaseStatus.Closed));
    }

    // ── Funds ────────────────────────────────────────────────────────────

    function test_withdraw_sendsToPayoutAndZeroes() public {
        vm.prank(collector);
        r.mint{value: 4 * PRICE}(collector, 4, address(0));

        uint256 before = artist.balance;
        // Permissionless trigger: anyone's gas, funds only ever to payout.
        vm.prank(other);
        vm.expectEmit();
        emit IRelease.ArtistWithdrawn(artist, 4 * PRICE);
        r.withdraw();

        assertEq(artist.balance - before, 4 * PRICE);
        assertEq(r.artistBalance(), 0);
        assertEq(address(r).balance, 0);

        vm.expectRevert("nothing to withdraw");
        r.withdraw();
    }

    function test_withdraw_followsPayoutChanges() public {
        vm.prank(collector);
        r.mint{value: PRICE}(collector, 1, address(0));

        vm.prank(artist);
        vm.expectEmit();
        emit IRelease.PayoutSet(other);
        r.setPayout(other);

        uint256 before = other.balance;
        r.withdraw();
        assertEq(other.balance - before, PRICE);
    }

    function test_setPayout_validation() public {
        vm.prank(artist);
        vm.expectRevert("payout required");
        r.setPayout(address(0));

        vm.prank(collector);
        vm.expectRevert(
            abi.encodeWithSelector(
                Ownable.OwnableUnauthorizedAccount.selector,
                collector
            )
        );
        r.setPayout(collector);
    }

    function test_withdraw_revertingPayoutNeverBricksMinting() public {
        RevertingReceiver bad = new RevertingReceiver();
        vm.prank(artist);
        r.setPayout(address(bad));

        vm.prank(collector);
        r.mint{value: PRICE}(collector, 1, address(0));

        // The withdraw fails — minting does not.
        vm.expectRevert("withdraw failed");
        r.withdraw();
        vm.prank(collector);
        r.mint{value: PRICE}(collector, 1, address(0));

        // The artist repoints payout and recovers everything.
        vm.prank(artist);
        r.setPayout(artist);
        uint256 before = artist.balance;
        r.withdraw();
        assertEq(artist.balance - before, 2 * PRICE);
    }

    function test_claimSurfaceFees_permissionlessToSurfaceOnly() public {
        vm.prank(collector);
        r.mint{value: 2 * (PRICE + SURFACE_FEE)}(collector, 2, surface);

        uint256 before = surface.balance;
        vm.prank(other); // anyone triggers; only the surface is paid
        vm.expectEmit();
        emit IRelease.SurfaceFeesClaimed(surface, 2 * SURFACE_FEE);
        r.claimSurfaceFees(surface);

        assertEq(surface.balance - before, 2 * SURFACE_FEE);
        assertEq(r.owed(surface), 0);
        // The artist's leg is still intact.
        assertEq(address(r).balance, r.artistBalance());

        vm.expectRevert("nothing owed");
        r.claimSurfaceFees(surface);
    }

    function test_claimSurfaceFees_revertingSurfaceOnlyHurtsItself() public {
        RevertingReceiver bad = new RevertingReceiver();
        vm.startPrank(collector);
        r.mint{value: PRICE + SURFACE_FEE}(collector, 1, address(bad));
        r.mint{value: PRICE + SURFACE_FEE}(collector, 1, surface);
        vm.stopPrank();

        vm.expectRevert("claim failed");
        r.claimSurfaceFees(address(bad));

        // Its fees stay owed; everyone else is unaffected.
        assertEq(r.owed(address(bad)), SURFACE_FEE);
        r.claimSurfaceFees(surface);
        r.withdraw();
    }

    // ── Metadata ─────────────────────────────────────────────────────────

    function test_tokenURI_identicalByDefault() public {
        vm.prank(collector);
        r.mint{value: 2 * PRICE}(collector, 2, address(0));
        assertEq(r.tokenURI(1), "ipfs://meta.json");
        assertEq(r.tokenURI(2), "ipfs://meta.json");
    }

    function test_tokenURI_perTokenAppendsId() public {
        ReleaseParams memory p = defaultParams();
        p.uri = "ipfs://folder/";
        p.uriPerToken = true;
        Release perToken = createRelease(p);

        vm.prank(collector);
        perToken.mint{value: 2 * PRICE}(collector, 2, address(0));
        assertEq(perToken.tokenURI(1), "ipfs://folder/1");
        assertEq(perToken.tokenURI(2), "ipfs://folder/2");
    }

    function test_tokenURI_rendererOverrides() public {
        StaticRenderer renderer = new StaticRenderer();
        vm.prank(collector);
        r.mint{value: PRICE}(collector, 1, address(0));

        vm.prank(artist);
        r.setMetadata("ignored", false, address(renderer));
        assertEq(r.tokenURI(1), "rendered:1");
    }

    function test_tokenURI_nonexistentReverts() public {
        vm.expectRevert(IERC721A.URIQueryForNonexistentToken.selector);
        r.tokenURI(1);
    }

    function test_setMetadata_emitsAndUpdates() public {
        vm.prank(artist);
        vm.expectEmit();
        emit IRelease.MetadataSet("ipfs://v2.json", true, address(0));
        vm.expectEmit();
        emit IRelease.BatchMetadataUpdate(1, type(uint256).max);
        r.setMetadata("ipfs://v2.json", true, address(0));

        assertEq(r.uri(), "ipfs://v2.json");
        assertTrue(r.uriPerToken());
    }

    function test_setMetadata_rendererNeedsCode() public {
        vm.prank(artist);
        vm.expectRevert("renderer has no code");
        r.setMetadata("x", false, makeAddr("eoa-renderer"));
    }

    function test_freezeMetadata_oneWayLocksEverything() public {
        vm.prank(artist);
        vm.expectEmit();
        emit IRelease.MetadataFrozen();
        r.freezeMetadata();
        assertTrue(r.metadataFrozen());

        vm.startPrank(artist);
        vm.expectRevert("metadata frozen");
        r.setMetadata("x", false, address(0));
        vm.expectRevert("metadata frozen");
        r.setContractURI("x");
        vm.expectRevert("metadata frozen");
        r.freezeMetadata();
        vm.stopPrank();
    }

    function test_setContractURI() public {
        assertEq(r.contractURI(), "ipfs://contract.json");
        vm.prank(artist);
        vm.expectEmit();
        emit IRelease.ContractURIUpdated();
        r.setContractURI("ipfs://contract-v2.json");
        assertEq(r.contractURI(), "ipfs://contract-v2.json");
    }

    function test_metadataSetters_ownerOnly() public {
        vm.startPrank(collector);
        bytes memory err = abi.encodeWithSelector(
            Ownable.OwnableUnauthorizedAccount.selector,
            collector
        );
        vm.expectRevert(err);
        r.setMetadata("x", false, address(0));
        vm.expectRevert(err);
        r.setContractURI("x");
        vm.expectRevert(err);
        r.freezeMetadata();
        vm.stopPrank();
    }

    // ── Royalties ────────────────────────────────────────────────────────

    function test_royaltyInfo_math() public view {
        (address receiver, uint256 amount) = r.royaltyInfo(1, 1 ether);
        assertEq(receiver, artist);
        assertEq(amount, 0.05 ether); // 500 bps
    }

    function test_royalty_noneWhenUnset() public {
        ReleaseParams memory p = defaultParams();
        p.royaltyBps = 0;
        Release plain = createRelease(p);
        (address receiver, uint256 amount) = plain.royaltyInfo(1, 1 ether);
        assertEq(receiver, address(0));
        assertEq(amount, 0);
    }

    function test_setRoyalty() public {
        vm.prank(artist);
        vm.expectEmit();
        emit IRelease.RoyaltySet(other, 1_000);
        r.setRoyalty(other, 1_000);
        (address receiver, uint256 amount) = r.royaltyInfo(1, 1 ether);
        assertEq(receiver, other);
        assertEq(amount, 0.1 ether);
    }

    function test_setRoyalty_validation() public {
        vm.startPrank(artist);
        vm.expectRevert("royalty above cap");
        r.setRoyalty(other, 5_001);
        vm.expectRevert("receiver required");
        r.setRoyalty(address(0), 100);
        r.setRoyalty(address(0), 0); // clearing is fine
        vm.stopPrank();
    }

    // ── ERC721 surface ───────────────────────────────────────────────────

    function test_tokenIdsStartAtOne() public {
        vm.prank(collector);
        uint256 first = r.mint{value: PRICE}(collector, 1, address(0));
        assertEq(first, 1);
        assertEq(r.ownerOf(1), collector);
    }

    function test_supportsInterface() public view {
        assertTrue(r.supportsInterface(0x01ffc9a7)); // ERC-165
        assertTrue(r.supportsInterface(0x80ac58cd)); // ERC-721
        assertTrue(r.supportsInterface(0x5b5e139f)); // ERC-721 Metadata
        assertTrue(r.supportsInterface(0x2a55205a)); // ERC-2981
        assertTrue(r.supportsInterface(0x49064906)); // ERC-4906
        assertFalse(r.supportsInterface(0xffffffff));
    }

    function test_burn_ownerAndApproved() public {
        vm.prank(collector);
        r.mint{value: 2 * PRICE}(collector, 2, address(0));

        vm.prank(collector);
        r.burn(1);
        assertEq(r.totalSupply(), 1);

        // A stranger can't burn.
        vm.prank(other);
        vm.expectRevert(
            IERC721A.TransferCallerNotOwnerNorApproved.selector
        );
        r.burn(2);

        // An approved operator can — this is what BURN gates rely on.
        vm.prank(collector);
        r.setApprovalForAll(other, true);
        vm.prank(other);
        r.burn(2);
        assertEq(r.totalSupply(), 0);
    }

    function test_ownershipHandoverKeepsArtistAttribution() public {
        vm.prank(artist);
        r.transferOwnership(other);
        vm.prank(other);
        r.acceptOwnership();

        assertEq(r.owner(), other);
        assertEq(r.artist(), artist); // attribution never moves
    }

    // ── Summary ──────────────────────────────────────────────────────────

    function test_summary_oneCallRendersTheMintUI() public {
        vm.prank(collector);
        r.mint{value: 3 * PRICE}(collector, 3, address(0));
        vm.prank(collector);
        r.burn(3);

        ReleaseSummary memory s = r.summary();
        assertEq(s.name, "Test Release");
        assertEq(s.symbol, "TEST");
        assertEq(s.artist, artist);
        assertEq(s.payout, artist);
        assertEq(s.price, PRICE);
        assertEq(s.surfaceFee, SURFACE_FEE);
        assertEq(s.startTime, r.startTime());
        assertEq(s.endTime, r.endTime());
        assertEq(s.maxSupply, 0);
        assertEq(s.gateToken, address(0));
        assertEq(uint8(s.gateMode), uint8(GateMode.NONE));
        assertEq(uint8(s.status), uint8(ReleaseStatus.Live));
        assertEq(s.totalMinted, 3);
        assertEq(s.totalSupply, 2);
        assertFalse(s.closed);
        assertFalse(s.metadataFrozen);
        assertEq(s.uri, "ipfs://meta.json");
        assertFalse(s.uriPerToken);
        assertEq(s.renderer, address(0));
        assertEq(s.royaltyReceiver, artist);
        assertEq(s.royaltyBps, 500);
    }
}
