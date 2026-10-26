// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OwnableUpgradeable} from "openzeppelin-contracts-upgradeable/contracts/access/OwnableUpgradeable.sol";

import {DeploySurfaceV2} from "../../../script/DeploySurfaceV2.s.sol";
import {Surface} from "../../../src/surface/v2/Surface.sol";
import {FixedPriceSale} from "../../../src/surface/v2/FixedPriceSale.sol";
import {AllowlistGate} from "../../../src/surface/v2/AllowlistGate.sol";
import {CloneFactory} from "../../../src/surface/v2/CloneFactory.sol";
import {Launcher} from "../../../src/surface/v2/Launcher.sol";
import {IMinter} from "../../../src/surface/v2/interfaces/IMinter.sol";
import {ISurface} from "../../../src/surface/v2/interfaces/ISurface.sol";
import {MockRenderer} from "../mocks/SurfaceMocks.sol";
import {GoodReceiver} from "./SurfaceV2Base.sol";

/// @notice End-to-end: deploy the system through DeploySurfaceV2, then walk one
///         collection through its whole life (allowlist phase, public phase,
///         batches, airdrop, wallet cap, renderer and name changes, burns, the
///         cap, a second sale, every payout, renounce) asserting value and
///         state at each step. A second test covers the bespoke path.
contract SurfaceV2E2ETest is Test {
    uint256 internal constant PRICE = 0.02 ether;

    address internal signer = makeAddr("signer");
    address internal pnd = makeAddr("pnd");
    address internal artist = makeAddr("artist");
    address internal artistSite = makeAddr("artistSite");
    address internal host = makeAddr("host");
    address[4] internal listed;
    address internal outsider = makeAddr("outsider");

    DeploySurfaceV2.Deployment internal d;
    Surface internal token;
    FixedPriceSale internal sale;
    AllowlistGate internal gate;
    MockRenderer internal renderer;

    // ghost value accounting
    uint256 internal paidIn;
    mapping(address => uint256) internal owed;

    function setUp() public {
        vm.chainId(31337);
        d = new DeploySurfaceV2()
            .runWith(signer, DeploySurfaceV2.Config({expectedDeployer: signer, defaultReferrer: pnd, landPaused: true}));
        gate = AllowlistGate(d.allowlistGate);
        renderer = new MockRenderer();
        listed = [makeAddr("l0"), makeAddr("l1"), makeAddr("l2"), makeAddr("l3")];
        for (uint256 i = 0; i < 4; i++) {
            vm.deal(listed[i], 10 ether);
        }
        vm.deal(outsider, 10 ether);
        vm.deal(host, 10 ether);
        vm.deal(artist, 10 ether);
    }

    // ─── merkle helpers (OZ standard tree, 4 leaves) ────────────────────────

    function _leaf(address a) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(a))));
    }

    function _pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }

    function _root() internal view returns (bytes32) {
        return _pair(_pair(_leaf(listed[0]), _leaf(listed[1])), _pair(_leaf(listed[2]), _leaf(listed[3])));
    }

    function _proof(uint256 i) internal view returns (bytes memory) {
        bytes32[] memory p = new bytes32[](2);
        p[0] = _leaf(listed[i ^ 1]);
        p[1] = i < 2 ? _pair(_leaf(listed[2]), _leaf(listed[3])) : _pair(_leaf(listed[0]), _leaf(listed[1]));
        return abi.encode(p);
    }

    // ─── value-tracking mint helpers ────────────────────────────────────────

    function _credit(uint256 paid, address referrer) internal {
        uint256 referral = referrer == address(0) ? 0 : (paid * 500) / 10_000;
        owed[referrer] += referral;
        owed[sale.payoutRecipient()] += paid - referral;
        paidIn += paid;
    }

    function _simpleMint(address who, uint256 q) internal {
        uint256 paid = sale.price() * q;
        vm.prank(who);
        sale.mint{value: paid}(q);
        _credit(paid, pnd);
    }

    function _refMint(address payer, address to, uint256 q, address referrer, bytes memory data) internal {
        uint256 paid = sale.price() * q;
        vm.prank(payer);
        sale.mintWithReferral{value: paid}(to, q, referrer, data);
        _credit(paid, referrer);
    }

    function _assertBooks(address[] memory parties) internal view {
        uint256 sum;
        for (uint256 i = 0; i < parties.length; i++) {
            assertEq(sale.pendingWithdrawal(parties[i]), owed[parties[i]], "pending != expected");
            sum += owed[parties[i]];
        }
        assertEq(address(sale).balance, sum, "sale balance != sum owed");
    }

    function _parties() internal view returns (address[] memory p) {
        p = new address[](4);
        (p[0], p[1], p[2], p[3]) = (artist, pnd, artistSite, host);
    }

    // ─── the lifecycle ──────────────────────────────────────────────────────

    function test_e2e_fullCollectionLifecycle() public {
        Launcher launcher = Launcher(d.launcherV2);
        CloneFactory tokenFactory = CloneFactory(d.surfaceFactoryV2);
        CloneFactory saleFactory = CloneFactory(d.saleFactoryV2);

        // Factories land paused; the deployer opens them.
        vm.expectRevert(CloneFactory.FactoryPaused.selector);
        launcher.launch(_tokenParams(), _saleParams());
        vm.startPrank(signer);
        tokenFactory.setPaused(false);
        saleFactory.setPaused(false);
        vm.stopPrank();

        // Launch: first batch of 4, allowlist gate on, cap 10.
        Launcher.SaleParams memory sp = _saleParams();
        sp.maxMints = 4;
        sp.gate = address(gate);
        vm.prank(artist);
        (address c, address s) = launcher.launch(_tokenParams(), sp);
        token = Surface(c);
        sale = FixedPriceSale(s);
        assertEq(token.minter(), address(sale));
        assertEq(sale.defaultReferrer(), pnd);

        // Allowlist phase: gate has no root yet, so everything fails closed.
        vm.prank(listed[0]);
        vm.expectRevert(IMinter.GateRejected.selector);
        sale.mintWithReferral{value: PRICE}(listed[0], 1, address(0), _proof(0));
        vm.prank(artist);
        gate.setRoot(address(token), _root());
        for (uint256 i = 0; i < 3; i++) {
            _refMint(listed[i], listed[i], 1, artistSite, _proof(i));
        }
        // The simple path carries no proof.
        vm.prank(listed[3]);
        vm.expectRevert(IMinter.GateRejected.selector);
        sale.mint{value: PRICE}(1);
        // A valid proof for someone else does not admit the outsider.
        vm.prank(outsider);
        vm.expectRevert(IMinter.GateRejected.selector);
        sale.mintWithReferral{value: PRICE}(outsider, 1, address(0), _proof(3));
        _refMint(listed[3], listed[3], 1, address(0), _proof(3));
        assertEq(token.totalSupply(), 4);

        // Batch 1 is sold out at maxMints = 4.
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(IMinter.MaxMintsExceeded.selector, 4, 5));
        sale.mint{value: PRICE}(1);

        // Public phase, batch 2: raise the ceiling, drop the gate, wallet cap 2.
        vm.startPrank(artist);
        sale.setMaxMints(8);
        sale.setGate(address(0));
        sale.setWalletCap(2);
        vm.stopPrank();
        _simpleMint(outsider, 2);
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(IMinter.WalletCapExceeded.selector, 2, 3));
        sale.mint{value: PRICE}(1);
        // listed[0] already holds 1 from the allowlist phase: the cap counts it.
        vm.prank(listed[0]);
        vm.expectRevert(abi.encodeWithSelector(IMinter.WalletCapExceeded.selector, 2, 3));
        sale.mint{value: 2 * PRICE}(2);
        // A contract wallet that accepts ERC721.
        address wallet = address(new GoodReceiver());
        _refMint(host, wallet, 1, host, "");
        assertEq(token.ownerOf(7), wallet);

        // Airdrop an artist proof, then hand minting back to the sale.
        vm.startPrank(artist);
        token.setMinter(artist);
        uint256 proofId = token.mintTo(artist, 1);
        token.setMinter(address(sale));
        vm.stopPrank();
        assertEq(proofId, 8, "airdrop takes the next id");
        assertEq(sale.totalMinted(), 7, "the airdrop is not a sale mint");

        // Renderer and name changes refresh every token.
        MockRenderer next = new MockRenderer();
        vm.expectEmit(address(token));
        emit ISurface.BatchMetadataUpdate(0, type(uint256).max);
        vm.prank(artist);
        token.setRenderer(address(next));
        assertEq(token.tokenURI(1), next.tokenURI(address(token), 1));
        vm.prank(artist);
        token.setName("Renamed", "RNM");
        assertEq(token.name(), "Renamed");

        // Burns: supply drops, cap room does not return, ids are never reused.
        vm.prank(listed[1]);
        token.burn(2);
        assertEq(token.totalSupply(), 7);
        vm.prank(artist);
        sale.setWalletCap(0);
        _simpleMint(host, 1); // id 9; sale has room for 1 more (maxMints 8)
        assertEq(token.ownerOf(9), host);
        vm.prank(artist);
        sale.setMaxMints(0);
        _simpleMint(host, 1); // id 10 = cap
        vm.prank(host);
        vm.expectRevert(abi.encodeWithSelector(ISurface.ExceedsCap.selector, 10, 11));
        sale.mint{value: PRICE}(1);

        // Close the first sale; a second sale through the factory owner path.
        vm.prank(artist);
        sale.close();
        _assertBooks(_parties());
        FixedPriceSale first = sale;
        vm.prank(artist);
        token.setSupplyCap(12);
        address predicted = saleFactory.predictCreate(artist);
        vm.startPrank(artist);
        token.setMinter(predicted);
        sale = FixedPriceSale(
            saleFactory.create(
                abi.encodeCall(
                    FixedPriceSale.initialize, (address(token), 2 * PRICE, 0, 0, 0, 0, artist, address(0), address(0))
                )
            )
        );
        vm.stopPrank();
        assertEq(address(sale), predicted);
        vm.prank(host);
        sale.mint{value: 2 * PRICE}(1); // zero default referrer: artist keeps all
        assertEq(sale.pendingWithdrawal(artist), 2 * PRICE);
        assertEq(token.ownerOf(11), host);

        // Every party withdraws from the first sale; nothing is left over.
        sale = first;
        uint256 artistBefore = artist.balance;
        vm.prank(outsider);
        sale.withdraw(artist);
        assertEq(artist.balance - artistBefore, owed[artist]);
        address pndSafe = makeAddr("pndSafe");
        vm.prank(pnd);
        sale.withdrawTo(pndSafe);
        assertEq(pndSafe.balance, owed[pnd]);
        sale.withdraw(artistSite);
        sale.withdraw(host);
        assertEq(address(sale).balance, 0, "first sale fully paid out");
        assertEq(paidIn, owed[artist] + owed[pnd] + owed[artistSite] + owed[host], "every wei accounted");

        // Renounce: token, both sales and the gate root freeze; payouts and
        // renderer refreshes keep working.
        FixedPriceSale second = FixedPriceSale(predicted);
        vm.startPrank(artist);
        token.renounceOwnership();
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, artist));
        token.setMinter(artist);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, artist));
        token.setSupplyCap(0);
        vm.expectRevert(FixedPriceSale.NotAuthorized.selector);
        second.setPrice(0);
        vm.expectRevert(FixedPriceSale.NotAuthorized.selector);
        second.close();
        vm.expectRevert(AllowlistGate.NotAuthorized.selector);
        gate.setRoot(address(token), bytes32(0));
        vm.stopPrank();
        vm.prank(host);
        second.mint{value: 2 * PRICE}(1); // id 12, the frozen cap
        vm.prank(host);
        vm.expectRevert(abi.encodeWithSelector(ISurface.ExceedsCap.selector, 12, 13));
        second.mint{value: 2 * PRICE}(1);
        second.withdraw(artist);
        assertEq(address(second).balance, 0);
        vm.prank(address(next));
        token.notifyMetadataUpdate(1, 12);
        assertEq(token.totalSupply(), 11);
    }

    function test_e2e_bespokePath_noLauncher() public {
        vm.startPrank(signer);
        CloneFactory(d.surfaceFactoryV2).setPaused(false);
        vm.stopPrank();
        BespokePoolMinter m = new BespokePoolMinter();
        vm.prank(artist);
        token = Surface(
            CloneFactory(d.surfaceFactoryV2)
                .create(
                    abi.encodeCall(
                        Surface.initialize, ("Homage", "HMG", artist, address(renderer), 3, 0, artist, address(m))
                    )
                )
        );
        m.bind(token);
        vm.prank(host);
        m.buy{value: 1 ether}();
        vm.prank(outsider);
        m.buy{value: 1 ether}();
        assertEq(token.ownerOf(1), host);
        assertEq(token.ownerOf(2), outsider);
        assertEq(address(m).balance, 2 ether, "the bespoke minter holds its own economics");
        assertEq(address(token).balance, 0);
        assertFalse(CloneFactory(d.saleFactoryV2).isInstance(address(m)), "not a canonical sale");
        // The artist can swap the bespoke minter for a canonical sale later.
        vm.prank(artist);
        token.setMinter(address(0));
        vm.prank(host);
        vm.expectRevert(ISurface.NotMinter.selector);
        m.buy{value: 1 ether}();
    }

    function _tokenParams() internal view returns (Launcher.TokenParams memory) {
        return Launcher.TokenParams("E2E", "E2E", artist, address(renderer), 10, 500, address(0));
    }

    function _saleParams() internal pure returns (Launcher.SaleParams memory) {
        return Launcher.SaleParams(PRICE, 0, 0, 0, 0, address(0), address(0));
    }
}

/// @dev Homage-shaped stand-in: bespoke pricing, holds its own ETH.
contract BespokePoolMinter {
    Surface internal token;

    function bind(Surface t) external {
        token = t;
    }

    function buy() external payable {
        require(msg.value == 1 ether, "price");
        token.mintTo(msg.sender, 1);
    }
}
