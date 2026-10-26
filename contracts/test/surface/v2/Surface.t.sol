// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {IERC721Errors} from "openzeppelin-contracts/contracts/interfaces/draft-IERC6093.sol";
import {Initializable} from "openzeppelin-contracts-upgradeable/contracts/proxy/utils/Initializable.sol";
import {OwnableUpgradeable} from "openzeppelin-contracts-upgradeable/contracts/access/OwnableUpgradeable.sol";

import {SurfaceV2Base} from "./SurfaceV2Base.sol";
import {Surface} from "../../../src/surface/v2/Surface.sol";
import {ISurface} from "../../../src/surface/v2/interfaces/ISurface.sol";
import {MockRenderer} from "../mocks/SurfaceMocks.sol";

contract SurfaceV2Test is SurfaceV2Base {
    Surface internal token;
    address internal minter = makeAddr("minter");

    function setUp() public override {
        super.setUp();
        token = _token(minter);
    }

    function _init(address owner_, address renderer_, uint16 bps, address receiver, address minter_)
        internal
        returns (Surface)
    {
        return Surface(
            tokenFactory.create(
                abi.encodeCall(Surface.initialize, ("N", "S", owner_, renderer_, 0, bps, receiver, minter_))
            )
        );
    }

    // ─── initialize ─────────────────────────────────────────────────────────

    function test_initialize_setsState() public view {
        assertEq(token.name(), "Surface");
        assertEq(token.symbol(), "SRF");
        assertEq(token.owner(), artist);
        assertEq(token.renderer(), address(renderer));
        assertEq(token.minter(), minter);
        assertEq(token.supplyCap(), 0);
        assertEq(token.royaltyBps(), 500);
        assertEq(token.royaltyReceiver(), artist);
        assertEq(token.version(), 2);
        assertEq(token.totalSupply(), 0);
    }

    function test_initialize_emitsInitialStateEvents() public {
        vm.recordLogs();
        _init(artist, address(renderer), 250, stranger, minter);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32[4] memory expected = [
            ISurface.RendererSet.selector,
            ISurface.RoyaltySet.selector,
            ISurface.SupplyCapSet.selector,
            ISurface.MinterSet.selector
        ];
        uint256 found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (found < 4 && logs[i].topics[0] == expected[found]) found++;
        }
        assertEq(found, 4, "RendererSet, RoyaltySet, SupplyCapSet, MinterSet in order");
    }

    function test_initialize_rejectsZeroOwner() public {
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableInvalidOwner.selector, address(0)));
        _init(address(0), address(renderer), 0, artist, minter);
    }

    function test_initialize_rejectsZeroRenderer() public {
        vm.expectRevert(ISurface.RendererRequired.selector);
        _init(artist, address(0), 0, artist, minter);
    }

    function test_initialize_rejectsCodelessRenderer() public {
        vm.expectRevert(abi.encodeWithSelector(ISurface.RendererNotContract.selector, stranger));
        _init(artist, stranger, 0, artist, minter);
    }

    function test_initialize_rejectsZeroReceiver() public {
        vm.expectRevert(ISurface.RoyaltyReceiverRequired.selector);
        _init(artist, address(renderer), 0, address(0), minter);
    }

    function test_initialize_rejectsRoyaltyAboveCap() public {
        vm.expectRevert(abi.encodeWithSelector(ISurface.RoyaltyTooHigh.selector, uint16(5001)));
        _init(artist, address(renderer), 5001, artist, minter);
    }

    function test_initialize_acceptsRoyaltyAtCap() public {
        assertEq(_init(artist, address(renderer), 5000, artist, minter).royaltyBps(), 5000);
    }

    function test_initialize_rejectsZeroMinter() public {
        vm.expectRevert(ISurface.MinterRequired.selector);
        _init(artist, address(renderer), 0, artist, address(0));
    }

    function test_initialize_acceptsCodelessMinter() public view {
        assertEq(token.minter().code.length, 0);
    }

    function test_initialize_onlyOnce() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        token.initialize("N", "S", stranger, address(renderer), 0, 0, stranger, stranger);
    }

    function test_implementation_cannotBeInitialized() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        surfaceImpl.initialize("N", "S", stranger, address(renderer), 0, 0, stranger, stranger);
    }

    // ─── mint ───────────────────────────────────────────────────────────────

    function test_mintTo_onlyMinter() public {
        vm.prank(artist);
        vm.expectRevert(ISurface.NotMinter.selector);
        token.mintTo(artist, 1);
    }

    function test_mintTo_rejectsZeroQuantity() public {
        vm.prank(minter);
        vm.expectRevert(ISurface.ZeroQuantity.selector);
        token.mintTo(collector, 0);
    }

    function test_mintTo_sequentialIdsAndEvent() public {
        vm.expectEmit(address(token));
        emit ISurface.Minted(minter, collector, 1, 3);
        vm.prank(minter);
        assertEq(token.mintTo(collector, 3), 1);
        vm.prank(minter);
        assertEq(token.mintTo(stranger, 2), 4);
        assertEq(token.ownerOf(3), collector);
        assertEq(token.ownerOf(5), stranger);
        assertEq(token.totalSupply(), 5);
    }

    function test_mintTo_storesSeed() public {
        vm.prevrandao(bytes32(uint256(42)));
        vm.prank(minter);
        token.mintTo(collector, 2);
        assertEq(token.tokenSeed(2), keccak256(abi.encode(uint256(42), address(token), uint256(2))));
        assertTrue(token.tokenSeed(1) != token.tokenSeed(2));
    }

    function test_mintTo_capEnforcedExactly() public {
        vm.prank(artist);
        token.setSupplyCap(3);
        vm.startPrank(minter);
        token.mintTo(collector, 2);
        vm.expectRevert(abi.encodeWithSelector(ISurface.ExceedsCap.selector, 3, 4));
        token.mintTo(collector, 2);
        token.mintTo(collector, 1);
        vm.stopPrank();
        assertEq(token.totalSupply(), 3);
    }

    function test_mintTo_rejectsZeroAddress() public {
        vm.prank(minter);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InvalidReceiver.selector, address(0)));
        token.mintTo(address(0), 1);
    }

    function test_mintTo_rejectsSelfCustody() public {
        vm.prank(minter);
        vm.expectRevert(ISurface.SelfCustodyRejected.selector);
        token.mintTo(address(token), 1);
    }

    function test_mintTo_toContractWithoutReceiverSucceeds() public {
        // The token never calls out; the receiver check is the sale's job.
        vm.prank(minter);
        token.mintTo(address(renderer), 1);
        assertEq(token.ownerOf(1), address(renderer));
    }

    // ─── burn ───────────────────────────────────────────────────────────────

    function _mintOne(address to) internal returns (uint256) {
        vm.prank(minter);
        return token.mintTo(to, 1);
    }

    function test_burn_byHolder() public {
        uint256 id = _mintOne(collector);
        bytes32 seed = token.tokenSeed(id);
        vm.expectEmit(address(token));
        emit ISurface.Burned(id);
        vm.prank(collector);
        token.burn(id);
        assertEq(token.totalSupply(), 0);
        assertEq(token.tokenSeed(id), seed, "seed readable after burn");
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, id));
        token.ownerOf(id);
    }

    function test_burn_byApproved() public {
        uint256 id = _mintOne(collector);
        vm.prank(collector);
        token.approve(stranger, id);
        vm.prank(stranger);
        token.burn(id);
        assertEq(token.balanceOf(collector), 0);
    }

    function test_burn_byOperator() public {
        uint256 id = _mintOne(collector);
        vm.prank(collector);
        token.setApprovalForAll(stranger, true);
        vm.prank(stranger);
        token.burn(id);
        assertEq(token.balanceOf(collector), 0);
    }

    function test_burn_rejectsStranger() public {
        uint256 id = _mintOne(collector);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InsufficientApproval.selector, stranger, id));
        token.burn(id);
    }

    function test_burn_rejectsOwnerOfCollection() public {
        uint256 id = _mintOne(collector);
        vm.prank(artist);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InsufficientApproval.selector, artist, id));
        token.burn(id);
    }

    function test_burn_nonexistent() public {
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 7));
        token.burn(7);
    }

    function test_burn_neverFreesCapOrReusesIds() public {
        vm.prank(artist);
        token.setSupplyCap(2);
        _mintOne(collector);
        _mintOne(collector);
        vm.prank(collector);
        token.burn(1);
        vm.prank(minter);
        vm.expectRevert(abi.encodeWithSelector(ISurface.ExceedsCap.selector, 2, 3));
        token.mintTo(collector, 1);
        vm.prank(artist);
        token.setSupplyCap(0);
        assertEq(_mintOne(collector), 3, "id 1 is never reused");
    }

    function test_tokenSeed_neverMinted() public {
        _mintOne(collector);
        vm.expectRevert(abi.encodeWithSelector(ISurface.NeverMinted.selector, 0));
        token.tokenSeed(0);
        vm.expectRevert(abi.encodeWithSelector(ISurface.NeverMinted.selector, 2));
        token.tokenSeed(2);
    }

    // ─── setters ────────────────────────────────────────────────────────────

    function _expectUnauthorized(address caller) internal {
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, caller));
    }

    function test_setters_ownerOnly() public {
        vm.startPrank(stranger);
        _expectUnauthorized(stranger);
        token.setRenderer(address(renderer));
        _expectUnauthorized(stranger);
        token.setMinter(stranger);
        _expectUnauthorized(stranger);
        token.setSupplyCap(1);
        _expectUnauthorized(stranger);
        token.setRoyalty(1, stranger);
        _expectUnauthorized(stranger);
        token.setName("x", "y");
        vm.stopPrank();
        // The minter has no owner authority either.
        vm.prank(minter);
        _expectUnauthorized(minter);
        token.setMinter(minter);
    }

    function test_setRenderer() public {
        MockRenderer next = new MockRenderer();
        vm.expectEmit(address(token));
        emit ISurface.RendererSet(address(next));
        vm.expectEmit(address(token));
        emit ISurface.BatchMetadataUpdate(0, type(uint256).max);
        vm.expectEmit(address(token));
        emit ISurface.ContractURIUpdated();
        vm.prank(artist);
        token.setRenderer(address(next));
        assertEq(token.renderer(), address(next));
    }

    function test_setRenderer_validates() public {
        vm.startPrank(artist);
        vm.expectRevert(ISurface.RendererRequired.selector);
        token.setRenderer(address(0));
        vm.expectRevert(abi.encodeWithSelector(ISurface.RendererNotContract.selector, stranger));
        token.setRenderer(stranger);
        vm.stopPrank();
    }

    function test_setMinter_andZero() public {
        vm.expectEmit(address(token));
        emit ISurface.MinterSet(stranger);
        vm.prank(artist);
        token.setMinter(stranger);
        assertEq(token.minter(), stranger);
        vm.prank(minter);
        vm.expectRevert(ISurface.NotMinter.selector);
        token.mintTo(collector, 1);

        vm.prank(artist);
        token.setMinter(address(0));
        vm.prank(stranger);
        vm.expectRevert(ISurface.NotMinter.selector);
        token.mintTo(collector, 1);
    }

    function test_airdropPattern() public {
        // setMinter(ownerWallet), mintTo, setMinter(sale): spec section 4.
        vm.startPrank(artist);
        token.setMinter(artist);
        token.mintTo(artist, 2);
        token.setMinter(minter);
        vm.stopPrank();
        assertEq(token.balanceOf(artist), 2);
        assertEq(_mintOne(collector), 3);
    }

    function test_setSupplyCap() public {
        _mintOne(collector);
        _mintOne(collector);
        vm.startPrank(artist);
        vm.expectRevert(abi.encodeWithSelector(ISurface.BadSupplyCap.selector, 2, 1));
        token.setSupplyCap(1);
        vm.expectEmit(address(token));
        emit ISurface.SupplyCapSet(2);
        token.setSupplyCap(2);
        token.setSupplyCap(0);
        vm.stopPrank();
        assertEq(token.supplyCap(), 0);
    }

    function test_setRoyalty() public {
        vm.startPrank(artist);
        vm.expectRevert(ISurface.RoyaltyReceiverRequired.selector);
        token.setRoyalty(100, address(0));
        vm.expectRevert(abi.encodeWithSelector(ISurface.RoyaltyTooHigh.selector, uint16(5001)));
        token.setRoyalty(5001, stranger);
        vm.expectEmit(address(token));
        emit ISurface.RoyaltySet(1000, stranger);
        token.setRoyalty(1000, stranger);
        vm.stopPrank();
        (address receiver, uint256 amount) = token.royaltyInfo(1, 1 ether);
        assertEq(receiver, stranger);
        assertEq(amount, 0.1 ether);
    }

    function test_royaltyInfo_math() public view {
        (address receiver, uint256 amount) = token.royaltyInfo(99, 12_345);
        assertEq(receiver, artist);
        assertEq(amount, 617); // 12345 * 500 / 10000, rounded down
    }

    function test_setName() public {
        vm.expectEmit(address(token));
        emit ISurface.NameSet("Renamed", "RN");
        vm.expectEmit(address(token));
        emit ISurface.BatchMetadataUpdate(0, type(uint256).max);
        vm.expectEmit(address(token));
        emit ISurface.ContractURIUpdated();
        vm.prank(artist);
        token.setName("Renamed", "RN");
        assertEq(token.name(), "Renamed");
        assertEq(token.symbol(), "RN");
    }

    // ─── renounce: the only lock ────────────────────────────────────────────

    function test_renounce_freezesEverySetter() public {
        vm.prank(artist);
        token.renounceOwnership();
        assertEq(token.owner(), address(0));

        vm.startPrank(artist);
        _expectUnauthorized(artist);
        token.setRenderer(address(renderer));
        _expectUnauthorized(artist);
        token.setMinter(artist);
        _expectUnauthorized(artist);
        token.setSupplyCap(1);
        _expectUnauthorized(artist);
        token.setRoyalty(1, artist);
        _expectUnauthorized(artist);
        token.setName("x", "y");
        _expectUnauthorized(artist);
        token.transferOwnership(artist);
        vm.stopPrank();

        // The minter keeps minting; the renderer can still signal refreshes.
        assertEq(_mintOne(collector), 1);
        vm.prank(address(renderer));
        token.notifyMetadataUpdate(1, 1);
    }

    function test_transferOwnershipToZero_reverts() public {
        vm.prank(artist);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableInvalidOwner.selector, address(0)));
        token.transferOwnership(address(0));
    }

    function test_transferOwnership_singleStep() public {
        vm.prank(artist);
        token.transferOwnership(stranger);
        assertEq(token.owner(), stranger);
        vm.prank(stranger);
        token.setMinter(stranger);
    }

    // ─── metadata ───────────────────────────────────────────────────────────

    function test_tokenURI_delegatesToRenderer() public {
        uint256 id = _mintOne(collector);
        assertEq(token.tokenURI(id), renderer.tokenURI(address(token), id));
        assertEq(token.contractURI(), renderer.contractURI(address(token)));
    }

    function test_tokenURI_nonexistentReverts() public {
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 1));
        token.tokenURI(1);
    }

    function test_notifyMetadataUpdate_authority() public {
        vm.expectEmit(address(token));
        emit ISurface.BatchMetadataUpdate(1, 5);
        vm.prank(address(renderer));
        token.notifyMetadataUpdate(1, 5);
        vm.prank(artist);
        token.notifyMetadataUpdate(1, 5);
        vm.prank(stranger);
        vm.expectRevert(ISurface.NotAuthorized.selector);
        token.notifyMetadataUpdate(1, 5);
        vm.prank(minter);
        vm.expectRevert(ISurface.NotAuthorized.selector);
        token.notifyMetadataUpdate(1, 5);
    }

    function test_config() public {
        _mintOne(collector);
        (address r, address m, uint256 cap, uint16 bps, address recv, uint256 minted) = token.config();
        assertEq(r, address(renderer));
        assertEq(m, minter);
        assertEq(cap, 0);
        assertEq(bps, 500);
        assertEq(recv, artist);
        assertEq(minted, 1);
    }

    function test_supportsInterface() public view {
        assertTrue(token.supportsInterface(0x01ffc9a7), "ERC-165");
        assertTrue(token.supportsInterface(0x80ac58cd), "ERC-721");
        assertTrue(token.supportsInterface(0x5b5e139f), "ERC-721 Metadata");
        assertTrue(token.supportsInterface(0x2a55205a), "ERC-2981");
        assertTrue(token.supportsInterface(0x49064906), "ERC-4906");
        assertFalse(token.supportsInterface(0xffffffff));
        assertFalse(token.supportsInterface(0x780e9d63), "not Enumerable");
    }

    // ─── custody and value ──────────────────────────────────────────────────

    function test_transferToSelf_rejected() public {
        uint256 id = _mintOne(collector);
        vm.prank(collector);
        vm.expectRevert(ISurface.SelfCustodyRejected.selector);
        token.transferFrom(collector, address(token), id);
    }

    function test_rejectsETH() public {
        vm.prank(collector);
        (bool ok,) = address(token).call{value: 1}("");
        assertFalse(ok, "no function of the token is payable");
    }
}
