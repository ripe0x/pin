// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {OwnableUpgradeable} from "openzeppelin-contracts-upgradeable/contracts/access/OwnableUpgradeable.sol";

import {SurfaceV2Base, GoodReceiver} from "./SurfaceV2Base.sol";
import {DeploySurfaceV2} from "../../../script/DeploySurfaceV2.s.sol";
import {Surface} from "../../../src/surface/v2/Surface.sol";
import {FixedPriceSale} from "../../../src/surface/v2/FixedPriceSale.sol";
import {AllowlistGate} from "../../../src/surface/v2/AllowlistGate.sol";
import {CloneFactory} from "../../../src/surface/v2/CloneFactory.sol";
import {Launcher} from "../../../src/surface/v2/Launcher.sol";
import {IMinter} from "../../../src/surface/v2/interfaces/IMinter.sol";
import {ISurface} from "../../../src/surface/v2/interfaces/ISurface.sol";
import {MockRenderer} from "../mocks/SurfaceMocks.sol";

/// @notice A full local lifecycle through the production deploy script and a
///         second collection using the factory without the launcher.
contract SurfaceV2E2ETest is SurfaceV2Base {
    DeploySurfaceV2 internal deployScript;
    CloneFactory internal deployedTokenFactory;
    CloneFactory internal deployedSaleFactory;
    Launcher internal deployedLauncher;
    AllowlistGate internal deployedGate;
    Surface internal token;
    FixedPriceSale internal sale;
    FixedPriceSale internal nextSale;
    MockRenderer internal nextRenderer;
    GoodReceiver internal contractReceiver;

    address internal signer = makeAddr("deployment signer");
    address internal siteReferrer = makeAddr("artist site referrer");
    address internal fourth = makeAddr("fourth allowlisted wallet");
    address internal outsider = makeAddr("public phase collector");
    address internal siteDestination = makeAddr("site withdrawal destination");
    address internal artistDestination = makeAddr("artist withdrawal destination");

    function setUp() public override {
        super.setUp();
        vm.chainId(31337);
        deployScript = new DeploySurfaceV2();
        contractReceiver = new GoodReceiver();
        vm.deal(outsider, 100 ether);
        vm.deal(fourth, 100 ether);
    }

    function _deploy(bool landPaused) internal {
        DeploySurfaceV2.Deployment memory d = deployScript.runWith(
            signer,
            DeploySurfaceV2.Config({expectedDeployer: signer, defaultReferrer: pnd, landPaused: landPaused})
        );
        deployedTokenFactory = CloneFactory(d.surfaceFactoryV2);
        deployedSaleFactory = CloneFactory(d.saleFactoryV2);
        deployedLauncher = Launcher(d.launcherV2);
        deployedGate = AllowlistGate(d.allowlistGate);
        assertEq(deployedTokenFactory.implementation(), d.surfaceImplV2);
        assertEq(deployedSaleFactory.implementation(), d.saleImplV2);
        assertEq(address(deployedLauncher.tokenFactory()), d.surfaceFactoryV2);
        assertEq(address(deployedLauncher.saleFactory()), d.saleFactoryV2);
        assertEq(deployedLauncher.defaultReferrer(), pnd);
    }

    function _sortedLeaves() internal view returns (bytes32[4] memory leaves) {
        leaves[0] = _leaf(collector);
        leaves[1] = _leaf(stranger);
        leaves[2] = _leaf(fourth);
        leaves[3] = _leaf(address(contractReceiver));
        // OpenZeppelin's standard tree sorts leaves before pairing them.
        for (uint256 i = 0; i < 4; i++) {
            for (uint256 j = i + 1; j < 4; j++) {
                if (leaves[j] < leaves[i]) (leaves[i], leaves[j]) = (leaves[j], leaves[i]);
            }
        }
    }

    function _root() internal view returns (bytes32) {
        bytes32[4] memory leaves = _sortedLeaves();
        return _hashPair(_hashPair(leaves[0], leaves[1]), _hashPair(leaves[2], leaves[3]));
    }

    function _proof(address account) internal view returns (bytes memory) {
        bytes32[4] memory leaves = _sortedLeaves();
        bytes32 target = _leaf(account);
        uint256 index = 4;
        for (uint256 i = 0; i < 4; i++) {
            if (leaves[i] == target) index = i;
        }
        assertLt(index, 4, "account must be in the tree");
        bytes32[] memory siblings = new bytes32[](2);
        siblings[0] = leaves[index ^ 1];
        siblings[1] = index < 2 ? _hashPair(leaves[2], leaves[3]) : _hashPair(leaves[0], leaves[1]);
        return abi.encode(siblings);
    }

    function _launchGatedCollection() internal {
        _deploy(true);
        assertTrue(deployedTokenFactory.paused());
        assertTrue(deployedSaleFactory.paused());
        vm.startPrank(signer);
        deployedTokenFactory.setPaused(false);
        deployedSaleFactory.setPaused(false);
        vm.stopPrank();
        assertFalse(deployedTokenFactory.paused());
        assertFalse(deployedSaleFactory.paused());

        (address collection, address saleAddress) = deployedLauncher.launch(
            Launcher.TokenParams("E2E Surface", "E2E", artist, address(renderer), 9, 500, address(0)),
            Launcher.SaleParams(PRICE, 0, 0, 2, 0, address(0), address(deployedGate))
        );
        token = Surface(collection);
        sale = FixedPriceSale(saleAddress);
        assertTrue(deployedTokenFactory.isInstance(collection));
        assertTrue(deployedSaleFactory.isInstance(saleAddress));
        assertEq(token.owner(), artist);
        assertEq(token.minter(), saleAddress);
        assertEq(token.supplyCap(), 9);
        assertEq(sale.collection(), collection);
        assertEq(sale.payoutRecipient(), artist);
        assertEq(sale.defaultReferrer(), pnd);
        assertEq(sale.gate(), address(deployedGate));
        assertEq(sale.maxMints(), 2);
    }

    function _allowlistPhase() internal {
        bytes32 root = _root();
        vm.prank(artist);
        deployedGate.setRoot(address(token), root);
        assertEq(deployedGate.root(address(token)), root);
        assertTrue(deployedGate.check(address(token), collector, 1, _proof(collector)));
        assertTrue(deployedGate.check(address(token), stranger, 1, _proof(stranger)));
        assertFalse(deployedGate.check(address(token), outsider, 1, _proof(collector)));

        vm.prank(outsider);
        vm.expectRevert(IMinter.GateRejected.selector);
        sale.mintWithReferral{value: PRICE}(outsider, 1, siteReferrer, _proof(collector));

        vm.expectEmit(address(sale));
        emit IMinter.Sold(collector, collector, address(0), 1, PRICE, 1);
        vm.prank(collector);
        sale.mintWithReferral{value: PRICE}(collector, 1, address(0), _proof(collector));
        assertEq(token.ownerOf(1), collector);
        assertEq(sale.mintedBy(collector), 1);
        assertEq(sale.pendingWithdrawal(artist), PRICE);

        vm.expectEmit(address(sale));
        emit IMinter.ReferralPaid(siteReferrer, PRICE / 20);
        vm.prank(stranger);
        sale.mintWithReferral{value: PRICE}(stranger, 1, siteReferrer, _proof(stranger));
        assertEq(token.ownerOf(2), stranger);
        assertEq(sale.totalMinted(), 2);
        assertEq(sale.pendingWithdrawal(siteReferrer), PRICE / 20);
        assertEq(address(sale).balance, 2 * PRICE);
    }

    function _publicPhaseAndAirdrop() internal {
        vm.startPrank(artist);
        sale.setGate(address(0));
        sale.setMaxMints(4);
        vm.stopPrank();
        assertEq(sale.gate(), address(0));
        assertEq(sale.maxMints(), 4);

        vm.expectEmit(address(sale));
        emit IMinter.ReferralPaid(pnd, PRICE / 20);
        vm.prank(collector);
        sale.mint{value: PRICE}(1);
        assertEq(token.ownerOf(3), collector);
        assertEq(sale.mintedBy(collector), 2);

        vm.prank(collector);
        sale.mintWithReferral{value: PRICE}(address(contractReceiver), 1, siteReferrer, "");
        assertEq(token.ownerOf(4), address(contractReceiver));
        assertEq(sale.mintedBy(address(contractReceiver)), 1);

        vm.startPrank(artist);
        sale.setMaxMints(7);
        sale.setWalletCap(2);
        vm.stopPrank();
        assertEq(sale.maxMints(), 7);
        assertEq(sale.walletCap(), 2);
        vm.prank(collector);
        vm.expectRevert(abi.encodeWithSelector(IMinter.WalletCapExceeded.selector, 2, 3));
        sale.mint{value: PRICE}(1);

        vm.prank(stranger);
        sale.mint{value: PRICE}(1);
        assertEq(token.ownerOf(5), stranger);
        assertEq(sale.mintedBy(stranger), 2);

        vm.startPrank(artist);
        token.setMinter(artist);
        uint256 airdropId = token.mintTo(fourth, 1);
        token.setMinter(address(sale));
        vm.stopPrank();
        assertEq(airdropId, 6);
        assertEq(token.ownerOf(6), fourth);
        assertEq(sale.totalMinted(), 5, "airdrop is outside this sale");

        vm.expectEmit(address(sale));
        emit IMinter.Sold(outsider, outsider, pnd, 2, 2 * PRICE, 7);
        vm.prank(outsider);
        sale.mint{value: 2 * PRICE}(2);
        assertEq(token.ownerOf(7), outsider);
        assertEq(token.ownerOf(8), outsider);
        assertEq(sale.totalMinted(), 7);
        assertEq(sale.mintedBy(outsider), 2);
        assertEq(address(sale).balance, 7 * PRICE);
        assertEq(sale.pendingWithdrawal(pnd), 4 * PRICE / 20);
        assertEq(sale.pendingWithdrawal(siteReferrer), 2 * PRICE / 20);
        assertEq(sale.pendingWithdrawal(artist), 7 * PRICE - 6 * PRICE / 20);
    }

    function _metadataBurnAndClose() internal {
        nextRenderer = new MockRenderer();
        vm.expectEmit(address(token));
        emit ISurface.RendererSet(address(nextRenderer));
        vm.expectEmit(address(token));
        emit ISurface.BatchMetadataUpdate(0, type(uint256).max);
        vm.expectEmit(address(token));
        emit ISurface.ContractURIUpdated();
        vm.prank(artist);
        token.setRenderer(address(nextRenderer));
        assertEq(token.renderer(), address(nextRenderer));

        vm.expectEmit(address(token));
        emit ISurface.NameSet("Renamed E2E", "RE2E");
        vm.expectEmit(address(token));
        emit ISurface.BatchMetadataUpdate(0, type(uint256).max);
        vm.expectEmit(address(token));
        emit ISurface.ContractURIUpdated();
        vm.prank(artist);
        token.setName("Renamed E2E", "RE2E");
        assertEq(token.name(), "Renamed E2E");
        assertEq(token.symbol(), "RE2E");

        bytes32 seed = token.tokenSeed(1);
        vm.expectEmit(address(token));
        emit ISurface.Burned(1);
        vm.prank(collector);
        token.burn(1);
        assertEq(token.tokenSeed(1), seed);
        bytes32 secondSeed = token.tokenSeed(2);
        vm.expectEmit(address(token));
        emit ISurface.Burned(2);
        vm.prank(stranger);
        token.burn(2);
        assertEq(token.tokenSeed(2), secondSeed);
        assertEq(token.totalSupply(), 6);
        (,,,,, uint256 mintedEver) = token.config();
        assertEq(mintedEver, 8, "burn does not free mint capacity");
    }

    function _secondSaleAndCap() internal {
        vm.startPrank(artist);
        token.setSupplyCap(8);
        sale.setMaxMints(8);
        vm.stopPrank();
        vm.prank(fourth);
        vm.expectRevert(abi.encodeWithSelector(ISurface.ExceedsCap.selector, 8, 9));
        sale.mint{value: PRICE}(1);
        vm.prank(artist);
        token.setSupplyCap(9);

        vm.expectEmit(address(sale));
        emit FixedPriceSale.Closed();
        vm.prank(artist);
        sale.close();
        assertTrue(sale.closed());
        vm.prank(outsider);
        vm.expectRevert(IMinter.SaleClosed.selector);
        sale.mint{value: PRICE}(1);

        address predicted = deployedSaleFactory.predictCreate(artist);
        bytes memory init = abi.encodeCall(
            FixedPriceSale.initialize,
            (address(token), PRICE, 0, 0, 0, 0, artist, address(0), address(0))
        );
        vm.startPrank(artist);
        token.setMinter(predicted);
        address created = deployedSaleFactory.create(init);
        vm.stopPrank();
        nextSale = FixedPriceSale(created);
        assertEq(created, predicted);
        assertTrue(deployedSaleFactory.isInstance(created));
        assertEq(token.minter(), created);
        assertEq(nextSale.collection(), address(token));
        assertEq(nextSale.payoutRecipient(), artist);

        vm.prank(collector);
        nextSale.mintWithReferral{value: PRICE}(fourth, 1, address(0), "");
        assertEq(token.ownerOf(9), fourth);
        assertEq(token.totalSupply(), 7);
        assertEq(nextSale.pendingWithdrawal(artist), PRICE);
        vm.prank(collector);
        vm.expectRevert(abi.encodeWithSelector(ISurface.ExceedsCap.selector, 9, 10));
        nextSale.mint{value: PRICE}(1);
    }

    function _renounceAndWithdraw() internal {
        vm.prank(artist);
        token.renounceOwnership();
        assertEq(token.owner(), address(0));
        bytes memory noOwner = abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, artist);
        vm.startPrank(artist);
        vm.expectRevert(noOwner);
        token.setRenderer(address(renderer));
        vm.expectRevert(noOwner);
        token.setMinter(artist);
        vm.expectRevert(noOwner);
        token.setSupplyCap(10);
        vm.expectRevert(noOwner);
        token.setRoyalty(500, artist);
        vm.expectRevert(noOwner);
        token.setName("No", "NO");
        vm.expectRevert(noOwner);
        token.transferOwnership(artist);
        vm.expectRevert(noOwner);
        token.renounceOwnership();
        vm.expectRevert(ISurface.NotAuthorized.selector);
        token.notifyMetadataUpdate(1, 9);

        vm.expectRevert(FixedPriceSale.NotAuthorized.selector);
        sale.setPrice(1);
        vm.expectRevert(FixedPriceSale.NotAuthorized.selector);
        sale.setMintWindow(1, 2);
        vm.expectRevert(FixedPriceSale.NotAuthorized.selector);
        sale.setMaxMints(10);
        vm.expectRevert(FixedPriceSale.NotAuthorized.selector);
        sale.setWalletCap(3);
        vm.expectRevert(FixedPriceSale.NotAuthorized.selector);
        sale.setPayoutRecipient(artist);
        vm.expectRevert(FixedPriceSale.NotAuthorized.selector);
        sale.setGate(address(0));
        vm.expectRevert(FixedPriceSale.NotAuthorized.selector);
        sale.close();
        vm.expectRevert(FixedPriceSale.NotAuthorized.selector);
        nextSale.setPrice(1);
        vm.expectRevert(FixedPriceSale.NotAuthorized.selector);
        nextSale.close();
        vm.expectRevert(AllowlistGate.NotAuthorized.selector);
        deployedGate.setRoot(address(token), bytes32(0));
        vm.stopPrank();

        vm.expectEmit(address(token));
        emit ISurface.BatchMetadataUpdate(2, 9);
        vm.prank(address(nextRenderer));
        token.notifyMetadataUpdate(2, 9);

        uint256 pndOwed = 4 * PRICE / 20;
        uint256 siteOwed = 2 * PRICE / 20;
        uint256 artistOwed = 7 * PRICE - pndOwed - siteOwed;
        uint256 pndBefore = pnd.balance;
        vm.expectEmit(address(sale));
        emit FixedPriceSale.Withdrawn(pnd, pnd, pndOwed);
        vm.prank(outsider);
        sale.withdraw(pnd);
        assertEq(pnd.balance - pndBefore, pndOwed);

        vm.expectEmit(address(sale));
        emit FixedPriceSale.Withdrawn(siteReferrer, siteDestination, siteOwed);
        vm.prank(siteReferrer);
        sale.withdrawTo(siteDestination);
        assertEq(siteDestination.balance, siteOwed);

        vm.expectEmit(address(sale));
        emit FixedPriceSale.Withdrawn(artist, artistDestination, artistOwed);
        vm.prank(artist);
        sale.withdrawTo(artistDestination);
        assertEq(artistDestination.balance, artistOwed);

        uint256 artistBefore = artist.balance;
        vm.expectEmit(address(nextSale));
        emit FixedPriceSale.Withdrawn(artist, artist, PRICE);
        vm.prank(outsider);
        nextSale.withdraw(artist);
        assertEq(artist.balance - artistBefore, PRICE);
        assertEq(sale.pendingWithdrawal(pnd), 0);
        assertEq(sale.pendingWithdrawal(siteReferrer), 0);
        assertEq(sale.pendingWithdrawal(artist), 0);
        assertEq(nextSale.pendingWithdrawal(artist), 0);
        assertEq(address(sale).balance, 0);
        assertEq(address(nextSale).balance, 0);
    }

    function test_FullLifecycleFromDeployScript() public {
        _launchGatedCollection();
        _allowlistPhase();
        _publicPhaseAndAirdrop();
        _metadataBurnAndClose();
        _secondSaleAndCap();
        _renounceAndWithdraw();
    }

    function test_BespokeFactoryPathWithoutLauncher() public {
        _deploy(true);
        vm.prank(signer);
        deployedTokenFactory.setPaused(false);
        E2EBespokeMinter minter = new E2EBespokeMinter();
        vm.prank(artist);
        address collection = deployedTokenFactory.create(
            abi.encodeCall(
                Surface.initialize, ("Bespoke", "BSP", artist, address(renderer), 3, 0, artist, address(minter))
            )
        );
        Surface bespoke = Surface(collection);
        assertTrue(deployedTokenFactory.isInstance(collection));
        assertEq(bespoke.owner(), artist);
        assertEq(bespoke.minter(), address(minter));
        assertEq(bespoke.supplyCap(), 3);
        assertEq(deployedLauncher.nonce(), 0, "launcher unused");
        assertTrue(deployedSaleFactory.paused(), "no sale was created");

        vm.prank(collector);
        vm.expectRevert(ISurface.NotMinter.selector);
        bespoke.mintTo(collector, 1);
        uint256 first = minter.mint(bespoke, collector, 2);
        assertEq(first, 1);
        assertEq(bespoke.ownerOf(1), collector);
        assertEq(bespoke.ownerOf(2), collector);
        bytes32 seed = bespoke.tokenSeed(1);
        vm.prank(collector);
        bespoke.burn(1);
        assertEq(bespoke.tokenSeed(1), seed);
        assertEq(bespoke.totalSupply(), 1);
        vm.prank(artist);
        bespoke.renounceOwnership();
        assertEq(minter.mint(bespoke, stranger, 1), 3);
        assertEq(bespoke.ownerOf(3), stranger);
        vm.expectRevert(abi.encodeWithSelector(ISurface.ExceedsCap.selector, 3, 4));
        minter.mint(bespoke, stranger, 1);
        assertEq(bespoke.totalSupply(), 2);
    }
}

/// @dev A custom minter exercises the direct factory path without a sale.
contract E2EBespokeMinter {
    function mint(Surface token, address to, uint256 quantity) external returns (uint256) {
        return token.mintTo(to, quantity);
    }
}
