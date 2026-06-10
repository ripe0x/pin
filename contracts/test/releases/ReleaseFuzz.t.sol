// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReleasesTestBase} from "./ReleasesTestBase.sol";
import {Release} from "../../src/releases/Release.sol";
import {GateMode, ReleaseParams} from "../../src/releases/IRelease.sol";
import {MockERC721} from "../MockERC721.sol";

contract ReleaseFuzzTest is ReleasesTestBase {
    /// @notice The money sentence, fuzzed: exact value required; the artist
    ///         accrues price * qty always; the surface accrues fee * qty
    ///         iff named and the release is priced; nothing else moves.
    function testFuzz_pricing(uint96 price_, uint8 qtySeed, bool surfaced)
        public
    {
        uint256 quantity = bound(uint256(qtySeed), 1, 40);
        ReleaseParams memory p = defaultParams();
        p.price = price_;
        Release r = createRelease(p);
        address surface_ = surfaced ? surface : address(0);

        uint256 priceTotal = uint256(price_) * quantity;
        uint256 feeTotal =
            (price_ == 0 || !surfaced) ? 0 : SURFACE_FEE * quantity;
        uint256 cost = priceTotal + feeTotal;

        vm.deal(collector, cost + 1);

        // Any other value reverts.
        vm.prank(collector);
        vm.expectRevert("wrong payment");
        r.mint{value: cost + 1}(collector, quantity, surface_);
        if (cost > 0) {
            vm.prank(collector);
            vm.expectRevert("wrong payment");
            r.mint{value: cost - 1}(collector, quantity, surface_);
        }

        vm.prank(collector);
        r.mint{value: cost}(collector, quantity, surface_);

        assertEq(r.artistBalance(), priceTotal);
        assertEq(r.owed(surface_), surfaced ? feeTotal : 0);
        assertEq(address(r).balance, cost);
        assertEq(r.balanceOf(collector), quantity);

        // Both legs drain exactly, to the right parties.
        if (priceTotal > 0) {
            uint256 before = artist.balance;
            r.withdraw();
            assertEq(artist.balance - before, priceTotal);
        }
        if (feeTotal > 0) {
            uint256 before = surface.balance;
            r.claimSurfaceFees(surface);
            assertEq(surface.balance - before, feeTotal);
        }
        assertEq(address(r).balance, 0);
    }

    /// @notice Free means free, fuzzed: a zero-price release accepts zero
    ///         value and nothing else, whatever the surface.
    function testFuzz_freeIsFree(uint8 qtySeed, address surface_, uint96 sent)
        public
    {
        uint256 quantity = bound(uint256(qtySeed), 1, 40);
        ReleaseParams memory p = defaultParams();
        p.price = 0;
        Release free = createRelease(p);

        if (sent > 0) {
            vm.deal(collector, sent);
            vm.prank(collector);
            vm.expectRevert("wrong payment");
            free.mint{value: sent}(collector, quantity, surface_);
        }

        vm.prank(collector);
        free.mint(collector, quantity, surface_);
        assertEq(free.balanceOf(collector), quantity);
        assertEq(address(free).balance, 0);
        assertEq(free.artistBalance(), 0);
        if (surface_ != address(0)) assertEq(free.owed(surface_), 0);
    }

    /// @notice Window fuzz: a mint lands iff start <= now < end, against
    ///         arbitrary clocks and windows.
    function testFuzz_window(uint64 start, uint64 durationSeed, uint64 at)
        public
    {
        start = uint64(bound(start, T0, T0 + 365 days));
        uint64 duration = uint64(bound(durationSeed, 1, 365 days));
        uint64 end = start + duration;
        vm.assume(end > block.timestamp);

        ReleaseParams memory p = defaultParams();
        p.startTime = start;
        p.endTime = end;
        Release r = createRelease(p);

        at = uint64(bound(at, T0, T0 + 730 days));
        vm.warp(at);

        bool inWindow = at >= start && at < end;
        vm.prank(collector);
        if (!inWindow) {
            vm.expectRevert(
                at < start
                    ? bytes("release not started")
                    : bytes("release ended")
            );
        }
        r.mint{value: PRICE}(collector, 1, address(0));
        assertEq(r.totalMinted(), inWindow ? 1 : 0);
    }

    /// @notice Cap fuzz: minted can reach but never pass maxSupply.
    function testFuzz_capNeverExceeded(uint8 capSeed, uint8 a, uint8 b)
        public
    {
        uint64 cap = uint64(bound(capSeed, 1, 30));
        uint256 first = bound(a, 1, 30);
        uint256 second = bound(b, 1, 30);

        ReleaseParams memory p = defaultParams();
        p.maxSupply = cap;
        p.price = 0;
        Release r = createRelease(p);

        vm.startPrank(collector);
        if (first > cap) {
            vm.expectRevert("exceeds max supply");
            r.mint(collector, first, address(0));
        } else {
            r.mint(collector, first, address(0));
            if (first + second > cap) {
                vm.expectRevert("exceeds max supply");
                r.mint(collector, second, address(0));
            } else {
                r.mint(collector, second, address(0));
            }
        }
        vm.stopPrank();
        assertLe(r.totalMinted(), cap);
    }

    /// @notice Royalty math fuzz under the cap.
    function testFuzz_royalty(uint96 bps, uint128 salePrice) public {
        bps = uint96(bound(bps, 0, 5_000));
        ReleaseParams memory p = defaultParams();
        p.royaltyBps = bps;
        Release r = createRelease(p);

        (address receiver, uint256 amount) = r.royaltyInfo(1, salePrice);
        if (bps == 0) {
            assertEq(receiver, address(0));
            assertEq(amount, 0);
        } else {
            assertEq(receiver, artist);
            assertEq(amount, (uint256(salePrice) * bps) / 10_000);
            assertLe(amount, uint256(salePrice) / 2);
        }
    }

    /// @notice HOLD gate fuzz: n distinct sources mint n tokens, and every
    ///         one of them is spent afterwards.
    function testFuzz_holdGateClaims(uint8 nSeed) public {
        uint256 n = bound(uint256(nSeed), 1, 25);
        MockERC721 gate = new MockERC721();
        uint256[] memory ids = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            gate.mint(collector, i + 100);
            ids[i] = i + 100;
        }

        ReleaseParams memory p = defaultParams();
        p.gateToken = address(gate);
        p.gateMode = GateMode.HOLD;
        p.price = 0;
        Release r = createRelease(p);

        vm.prank(collector);
        r.mintGated(collector, ids, address(0));

        assertEq(r.balanceOf(collector), n);
        for (uint256 i = 0; i < n; i++) {
            assertTrue(r.gateUsed(ids[i]));
        }
    }
}
