// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {SurfaceV2Base} from "./SurfaceV2Base.sol";
import {MockRenderer} from "../mocks/SurfaceMocks.sol";
import {MockMinterV2, MockCatalogV2} from "./mocks/SurfaceV2Mocks.sol";

import {SurfaceV2} from "../../../src/surface/v2/SurfaceV2.sol";
import {SurfaceFactoryV2} from "../../../src/surface/v2/SurfaceFactoryV2.sol";
import {ISurfaceV2, InitParamsV2} from "../../../src/surface/v2/interfaces/ISurfaceV2.sol";
import {SurfaceConfig} from "../../../src/surface/SurfaceTypes.sol";

/// @dev Core SurfaceV2 coverage ported from v1's Surface.t.sol +
///      SurfaceAdmin.t.sol + SurfaceSecurity.t.sol + CreatorAttribution.t.sol,
///      with every pooled-mode case dropped (v2 has one id mode). Royalty
///      locking and seal() live in SurfaceV2Seal.t.sol; seed derivation and
///      seedSource live in SurfaceV2Seed.t.sol; self-custody rejection lives
///      in SurfaceV2Transfer.t.sol.
contract SurfaceV2Test is SurfaceV2Base {
    // ── init validation ──────────────────────────────────────────────────────

    function test_init_rejectsZeroOwner() public {
        InitParamsV2 memory p = _rawInitParams(_freeConfig());
        p.owner = address(0);
        SurfaceV2 clone = _freshClone();
        vm.expectRevert(ISurfaceV2.OwnerRequired.selector);
        clone.initialize(p);
    }

    function test_init_rejectsZeroDefaultRenderer() public {
        InitParamsV2 memory p = _rawInitParams(_freeConfig());
        p.defaultRenderer = address(0);
        SurfaceV2 clone = _freshClone();
        vm.expectRevert(ISurfaceV2.RendererRequired.selector);
        clone.initialize(p);
    }

    /// @dev A renderer with no code would brick tokenURI, fatally so when
    ///      the collection is born rendererLocked. Refused at the door.
    function test_init_rejectsNonContractRenderer() public {
        address eoa = makeAddr("eoaRenderer");
        SurfaceConfig memory cfg = _freeConfig();
        cfg.renderer = eoa;
        InitParamsV2 memory p = _rawInitParams(cfg);
        SurfaceV2 clone = _freshClone();
        vm.expectRevert(abi.encodeWithSelector(ISurfaceV2.RendererNotContract.selector, eoa));
        clone.initialize(p);

        // The born-locked variant is the one the guard exists for: without it
        // this collection could never render and never be fixed.
        cfg.rendererLocked = true;
        p = _rawInitParams(cfg);
        clone = _freshClone();
        vm.expectRevert(abi.encodeWithSelector(ISurfaceV2.RendererNotContract.selector, eoa));
        clone.initialize(p);
    }

    function test_setRenderer_rejectsNonContract() public {
        SurfaceV2 c = _collection(_freeConfig());
        address eoa = makeAddr("eoaRenderer");
        vm.expectRevert(abi.encodeWithSelector(ISurfaceV2.RendererNotContract.selector, eoa));
        vm.prank(artist);
        c.setRenderer(eoa);
    }

    function test_init_rejectsRoyaltyTooHigh() public {
        SurfaceConfig memory cfg = _freeConfig();
        cfg.royaltyBps = 5001; // > 50% cap
        InitParamsV2 memory p = _rawInitParams(cfg);
        SurfaceV2 clone = _freshClone();
        vm.expectRevert(ISurfaceV2.RoyaltyTooHigh.selector);
        clone.initialize(p);
    }

    function test_init_allowsRoyaltyAtCap() public {
        SurfaceConfig memory cfg = _freeConfig();
        cfg.royaltyBps = 5000; // exactly 50%, allowed
        SurfaceV2 c = _collection(cfg);
        (address receiver, uint256 amount) = c.royaltyInfo(1, 1 ether);
        assertEq(receiver, artist); // defaults to owner when royaltyReceiver unset
        assertEq(amount, 0.5 ether);
    }

    function test_init_rejectsZeroInitialMinter() public {
        SurfaceConfig memory cfg = _freeConfig();
        address[] memory minters = new address[](1);
        minters[0] = address(0);
        vm.expectRevert(ISurfaceV2.ZeroMinter.selector);
        _collectionWithMinters(cfg, minters);
    }

    function test_init_grantsInitialMinters() public {
        SurfaceConfig memory cfg = _freeConfig();
        address m = makeAddr("initialMinter");
        address[] memory minters = new address[](1);
        minters[0] = m;
        SurfaceV2 c = _collectionWithMinters(cfg, minters);
        assertTrue(c.isMinter(m));
    }

    // ── config views ─────────────────────────────────────────────────────────

    function test_configReadable() public {
        SurfaceConfig memory cfg = _freeConfig();
        cfg.supplyCap = 10;
        SurfaceV2 c = _collection(cfg);
        (SurfaceConfig memory readCfg, uint256 minted) = c.config();
        assertEq(readCfg.supplyCap, 10);
        assertEq(minted, 0);
    }

    function test_factory_deploysOwnedClone() public {
        SurfaceV2 c = _collection(_freeConfig());
        assertEq(c.owner(), artist);
        assertEq(c.name(), "Artist Surface");
        assertEq(c.symbol(), "ACOL");
        assertTrue(factory.isSurface(address(c)));
        assertEq(factory.totalSurfaces(), 1);
        assertFalse(c.isRendererLocked());
        assertFalse(c.isSupplyLocked());
    }

    function test_startTokenIdIsOne() public {
        SurfaceV2 c = _collection(_freeConfig());
        _mintTo(c, collector, 1);
        assertEq(c.ownerOf(1), collector);
        assertEq(c.totalSupply(), 1);
    }

    function test_version() public {
        SurfaceV2 c = _collection(_freeConfig());
        assertEq(c.version(), 2);
    }

    // ── mint: minter-gated, non-payable, batch-native ────────────────────────

    function test_mintTo_batch_succeeds() public {
        SurfaceV2 c = _collection(_freeConfig());
        uint256 firstTokenId = _mintTo(c, collector, 3);
        assertEq(firstTokenId, 1);
        assertEq(c.balanceOf(collector), 3);
        assertEq(c.ownerOf(3), collector);
        assertEq(c.totalSupply(), 3);
    }

    /// @dev A batch continues the same counter a prior mint left off: ids run
    ///      mintedEver+1 .. mintedEver+quantity every call, not just the first.
    function test_mintTo_batchIdsContinueFromMintedEver() public {
        SurfaceV2 c = _collection(_freeConfig());
        vm.prank(artist);
        c.setMinter(address(this), true);

        c.mintTo(collector, 2); // ids 1,2
        uint256 firstTokenId = c.mintTo(collector, 3); // ids 3,4,5
        assertEq(firstTokenId, 3);
        assertEq(c.ownerOf(5), collector);
        (, uint256 minted) = c.config();
        assertEq(minted, 5);
    }

    function test_mintTo_zeroQuantityReverts() public {
        SurfaceV2 c = _collection(_freeConfig());
        vm.prank(artist);
        c.setMinter(address(this), true);
        vm.expectRevert(ISurfaceV2.ZeroQuantity.selector);
        c.mintTo(collector, 0);
    }

    /// @dev The token has no payable function at all: sending value to
    ///      mintTo reverts in the dispatcher, not in a check.
    function test_mintTo_rejectsValue() public {
        SurfaceV2 c = _collection(_freeConfig());
        vm.prank(artist);
        c.setMinter(address(this), true);
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(c).call{value: 1 wei}(abi.encodeWithSignature("mintTo(address,uint256)", collector, 1));
        assertFalse(ok, "mintTo must not accept value");
    }

    /// @dev The token never gains a value-facing mint entrypoint, the
    ///      minter's ergonomic mint(uint256) overload, or a payable
    ///      "purchase" path. Every selector below either does not exist on
    ///      the token or, where it exists (mintTo/mintToSeeded), is
    ///      non-payable and minter-gated.
    function test_noValueFacingMintEntrypointExists() public {
        SurfaceV2 c = _collection(_freeConfig());
        vm.deal(address(this), 1 ether);

        (bool okMintQty,) = address(c).call{value: 0}(abi.encodeWithSignature("mint(uint256)", uint256(1)));
        assertFalse(okMintQty, "must not expose mint(uint256)");

        (bool okMint4,) =
            address(c).call(abi.encodeWithSignature("mint(address,uint256,address,bytes)", collector, 1, address(0), ""));
        assertFalse(okMint4, "must not expose the minter's mint ABI");

        (bool okPurchase,) = address(c).call{value: 1 wei}(abi.encodeWithSignature("purchase(uint256)", uint256(1)));
        assertFalse(okPurchase, "must not expose purchase");

        (bool okValue,) =
            address(c).call{value: 1 wei}(abi.encodeWithSignature("mintTo(address,uint256)", collector, uint256(1)));
        assertFalse(okValue, "the one existing mint entrypoint must reject value");
    }

    function test_Minted_eventShape() public {
        SurfaceV2 c = _collection(_freeConfig());
        vm.prank(artist);
        c.setMinter(address(this), true);
        vm.expectEmit(true, true, false, true, address(c));
        emit ISurfaceV2.Minted(address(this), collector, 1, 2, 1);
        c.mintTo(collector, 2);
    }

    // ── burn ──────────────────────────────────────────────────────────────────

    function test_burn_ownerOrApproved() public {
        SurfaceV2 c = _collection(_freeConfig());
        _mintTo(c, collector, 1);

        vm.expectRevert(ISurfaceV2.NotAuthorized.selector);
        vm.prank(stranger);
        c.burn(1);

        vm.prank(collector);
        c.approve(stranger, 1);
        vm.prank(stranger);
        c.burn(1);
        assertEq(c.balanceOf(collector), 0);
    }

    function test_burn_requiresExistingToken() public {
        SurfaceV2 c = _collection(_freeConfig());
        vm.expectRevert(abi.encodeWithSignature("ERC721NonexistentToken(uint256)", 1));
        c.burn(1);
    }

    function test_burn_emitsBurned() public {
        SurfaceV2 c = _collection(_freeConfig());
        _mintTo(c, collector, 1);
        vm.expectEmit(true, false, false, false, address(c));
        emit ISurfaceV2.Burned(1);
        vm.prank(collector);
        c.burn(1);
    }

    // ── supply cap: mints-ever, burn frees nothing ───────────────────────────

    function test_mint_capEnforced() public {
        SurfaceConfig memory cfg = _freeConfig();
        cfg.supplyCap = 3;
        SurfaceV2 c = _collection(cfg);
        vm.prank(artist);
        c.setMinter(address(this), true);

        c.mintTo(collector, 2);
        vm.expectRevert(abi.encodeWithSelector(ISurfaceV2.ExceedsCap.selector, 3, 4));
        c.mintTo(collector, 2);
        c.mintTo(collector, 1);

        (, uint256 minted) = c.config();
        assertEq(minted, 3);
    }

    /// @dev The cap tracks mints-ever, not live supply: burning a token never
    ///      reopens the capacity it used.
    function test_cap_burnDoesNotFreeCapacity() public {
        SurfaceConfig memory cfg = _freeConfig();
        cfg.supplyCap = 2;
        SurfaceV2 c = _collection(cfg);
        vm.prank(artist);
        c.setMinter(address(this), true);

        c.mintTo(collector, 2);
        vm.prank(collector);
        c.burn(1);
        assertEq(c.totalSupply(), 1, "live supply drops");

        vm.expectRevert(abi.encodeWithSelector(ISurfaceV2.ExceedsCap.selector, 2, 3));
        c.mintTo(collector, 1);
    }

    function test_setSupplyCap_updatesAndFloors() public {
        SurfaceConfig memory cfg = _freeConfig();
        cfg.supplyCap = 5;
        SurfaceV2 c = _collection(cfg);
        _mintTo(c, collector, 3);

        // cannot set below mints-ever (ids are never reused)
        vm.expectRevert(abi.encodeWithSelector(ISurfaceV2.BadSupplyCap.selector, 3, 2));
        vm.prank(artist);
        c.setSupplyCap(2);

        // shrink to exactly minted: collection closes
        vm.expectEmit(false, false, false, true, address(c));
        emit ISurfaceV2.SupplyCapSet(3);
        vm.prank(artist);
        c.setSupplyCap(3);
        vm.expectRevert(abi.encodeWithSelector(ISurfaceV2.ExceedsCap.selector, 3, 4));
        c.mintTo(collector, 1);

        // grow re-opens; 0 = open supply
        vm.prank(artist);
        c.setSupplyCap(0);
        c.mintTo(collector, 10);
        assertEq(c.totalSupply(), 13);
    }

    function test_lockSupply_freezesCapForever() public {
        SurfaceConfig memory cfg = _freeConfig();
        cfg.supplyCap = 100;
        SurfaceV2 c = _collection(cfg);
        assertFalse(c.isSupplyLocked());

        vm.expectEmit(false, false, false, false, address(c));
        emit ISurfaceV2.SupplyLocked();
        vm.prank(artist);
        c.lockSupply();
        assertTrue(c.isSupplyLocked());

        vm.expectRevert(ISurfaceV2.SupplyIsLocked.selector);
        vm.prank(artist);
        c.setSupplyCap(200);

        // one-way: locking twice reverts rather than silently re-emitting
        vm.expectRevert(ISurfaceV2.SupplyIsLocked.selector);
        vm.prank(artist);
        c.lockSupply();
    }

    function test_supplyCapAndLock_onlyOwnerOrAdmin() public {
        SurfaceV2 c = _collection(_freeConfig());
        vm.startPrank(stranger);
        vm.expectRevert(ISurfaceV2.NotAuthorized.selector);
        c.setSupplyCap(1);
        vm.expectRevert(ISurfaceV2.NotAuthorized.selector);
        c.lockSupply();
        vm.stopPrank();
    }

    /// @dev The cap binds every mint path, so a locked cap is a hard ceiling
    ///      regardless of which minter calls it.
    function test_lockedCap_bindsExtensionMinters() public {
        SurfaceConfig memory cfg = _freeConfig();
        cfg.supplyCap = 1;
        SurfaceV2 c = _collection(cfg);
        address minter = makeAddr("minter");
        vm.startPrank(artist);
        c.setMinter(minter, true);
        c.lockSupply();
        vm.stopPrank();

        vm.prank(minter);
        c.mintTo(collector, 1);
        vm.expectRevert(abi.encodeWithSelector(ISurfaceV2.ExceedsCap.selector, 1, 2));
        vm.prank(minter);
        c.mintTo(collector, 1);
    }

    // ── ERC-4906 refresh signals ─────────────────────────────────────────────

    function test_erc4906_interfaceAndSetterSignals() public {
        SurfaceV2 c = _collection(_freeConfig());
        assertTrue(c.supportsInterface(0x49064906));

        // renderer swap refreshes every token AND the contract-level page
        address newRenderer = address(new MockRenderer());
        vm.expectEmit(false, false, false, true, address(c));
        emit ISurfaceV2.BatchMetadataUpdate(0, type(uint256).max);
        vm.expectEmit(false, false, false, true, address(c));
        emit ISurfaceV2.ContractURIUpdated();
        vm.prank(artist);
        c.setRenderer(newRenderer);
    }

    /// @dev The renderer (or owner/admin) can signal refreshes the core
    ///      cannot see, including after lockRenderer, since the lock pins the
    ///      pointer, not a live work's output.
    function test_notifyMetadataUpdate_rendererAndAdminOnly() public {
        SurfaceV2 c = _collection(_freeConfig());

        vm.expectEmit(false, false, false, true, address(c));
        emit ISurfaceV2.BatchMetadataUpdate(1, 10);
        vm.prank(address(renderer));
        c.notifyMetadataUpdate(1, 10);

        vm.prank(artist);
        c.lockRenderer();
        vm.expectEmit(false, false, false, true, address(c));
        emit ISurfaceV2.BatchMetadataUpdate(0, type(uint256).max);
        vm.prank(artist);
        c.notifyMetadataUpdate(0, type(uint256).max);

        vm.expectRevert(ISurfaceV2.NotAuthorized.selector);
        vm.prank(stranger);
        c.notifyMetadataUpdate(1, 1);
    }

    // ── royalty (setter + reads; lockRoyalty lives in SurfaceV2Seal.t.sol) ───

    function test_setRoyalty_updatesAndCaps() public {
        SurfaceV2 c = _collection(_freeConfig());
        address newReceiver = makeAddr("newRoyalty");
        vm.expectEmit(true, false, false, true, address(c));
        emit ISurfaceV2.RoyaltySet(750, newReceiver);
        vm.prank(artist);
        c.setRoyalty(750, newReceiver);
        (address receiver, uint256 amount) = c.royaltyInfo(1, 1 ether);
        assertEq(receiver, newReceiver);
        assertEq(amount, 0.075 ether);

        vm.expectRevert(ISurfaceV2.RoyaltyTooHigh.selector);
        vm.prank(artist);
        c.setRoyalty(5001, newReceiver);

        // receiver 0 falls back to owner()
        vm.prank(artist);
        c.setRoyalty(100, address(0));
        (receiver,) = c.royaltyInfo(1, 1 ether);
        assertEq(receiver, artist);
    }

    function test_setRoyalty_onlyOwnerOrAdmin() public {
        SurfaceV2 c = _collection(_freeConfig());
        vm.expectRevert(ISurfaceV2.NotAuthorized.selector);
        vm.prank(stranger);
        c.setRoyalty(100, address(0));
    }

    function test_royaltyInfo() public {
        SurfaceConfig memory cfg = _freeConfig();
        cfg.royaltyBps = 500;
        cfg.royaltyReceiver = makeAddr("royalty");
        SurfaceV2 c = _collection(cfg);
        _mintTo(c, collector, 1);
        (address receiver, uint256 amount) = c.royaltyInfo(1, 1 ether);
        assertEq(receiver, cfg.royaltyReceiver);
        assertEq(amount, 0.05 ether);
        assertTrue(c.supportsInterface(0x2a55205a));
    }

    function test_royaltyInfo_defaultsToOwner() public {
        SurfaceConfig memory cfg = _freeConfig();
        cfg.royaltyBps = 250;
        SurfaceV2 c = _collection(cfg);
        (address receiver,) = c.royaltyInfo(1, 1 ether);
        assertEq(receiver, artist);
    }

    /// @dev A renounced collection with no explicit royaltyReceiver resolves
    ///      owner() to address(0); a marketplace must not route royalties
    ///      there, so the amount zeroes out alongside the zero receiver.
    function test_royaltyInfo_renouncedCollection_noReceiver_zeroesAmount() public {
        SurfaceConfig memory cfg = _freeConfig();
        cfg.royaltyBps = 250;
        SurfaceV2 c = _collection(cfg);
        vm.prank(artist);
        c.renounceOwnership();

        (address receiver, uint256 amount) = c.royaltyInfo(1, 1 ether);
        assertEq(receiver, address(0));
        assertEq(amount, 0, "no amount is routed to the zero address");
    }

    /// @dev An explicit royaltyReceiver is unaffected by a renounced owner.
    function test_royaltyInfo_renouncedCollection_explicitReceiver_unaffected() public {
        SurfaceConfig memory cfg = _freeConfig();
        cfg.royaltyBps = 500;
        cfg.royaltyReceiver = makeAddr("royalty");
        SurfaceV2 c = _collection(cfg);
        vm.prank(artist);
        c.renounceOwnership();

        (address receiver, uint256 amount) = c.royaltyInfo(1, 1 ether);
        assertEq(receiver, cfg.royaltyReceiver);
        assertEq(amount, 0.05 ether);
    }

    // ── rescueStrayETH ───────────────────────────────────────────────────────

    function test_rescueStrayETH_sweepsWholeBalance() public {
        SurfaceV2 c = _collection(_freeConfig());
        vm.deal(address(c), 1.5 ether);

        address dest = makeAddr("rescueDest");
        vm.prank(artist);
        c.rescueStrayETH(dest);
        assertEq(dest.balance, 1.5 ether);
        assertEq(address(c).balance, 0);

        vm.expectRevert(ISurfaceV2.NoStrayETH.selector);
        vm.prank(artist);
        c.rescueStrayETH(dest);
    }

    function test_rescueStrayETH_onlyOwnerOrAdmin() public {
        SurfaceV2 c = _collection(_freeConfig());
        vm.deal(address(c), 1 ether);
        vm.expectRevert(ISurfaceV2.NotAuthorized.selector);
        vm.prank(stranger);
        c.rescueStrayETH(stranger);
    }

    function test_rescueStrayETH_rejectsZeroAccount() public {
        SurfaceV2 c = _collection(_freeConfig());
        vm.deal(address(c), 1 ether);
        vm.expectRevert(ISurfaceV2.ZeroAccount.selector);
        vm.prank(artist);
        c.rescueStrayETH(address(0));
    }

    // ── tokenURI delegation + contractURI ────────────────────────────────────

    function test_tokenURI_delegatesToRenderer() public {
        SurfaceV2 c = _collection(_freeConfig());
        _mintTo(c, collector, 1);
        assertEq(c.tokenURI(1), renderer.tokenURI(address(c), 1));
    }

    function test_tokenURI_nonexistentReverts() public {
        SurfaceV2 c = _collection(_freeConfig());
        vm.expectRevert(abi.encodeWithSignature("ERC721NonexistentToken(uint256)", 1));
        c.tokenURI(1);
    }

    function test_tokenURI_customRendererOverride() public {
        SurfaceV2 c = _collection(_freeConfig());
        _mintTo(c, collector, 1);
        MockRenderer custom = new MockRenderer();
        vm.prank(artist);
        c.setRenderer(address(custom));
        assertEq(c.tokenURI(1), custom.tokenURI(address(c), 1));
        assertEq(c.renderer(), address(custom));
    }

    function test_contractURI_delegatesToRenderer() public {
        SurfaceV2 c = _collection(_freeConfig());
        assertEq(c.contractURI(), renderer.contractURI(address(c)));
    }

    function test_setRenderer_blockedWhenLocked() public {
        SurfaceV2 c = _collection(_freeConfig());
        vm.prank(artist);
        c.lockRenderer();
        vm.expectRevert(ISurfaceV2.RendererIsLocked.selector);
        vm.prank(artist);
        c.setRenderer(makeAddr("newRenderer"));
    }

    function test_setRenderer_onlyOwnerOrAdmin() public {
        SurfaceV2 c = _collection(_freeConfig());
        vm.expectRevert(ISurfaceV2.NotAuthorized.selector);
        vm.prank(stranger);
        c.setRenderer(makeAddr("newRenderer"));
    }

    function test_setRenderer_rejectsZeroAddress() public {
        SurfaceV2 c = _collection(_freeConfig());
        vm.expectRevert(ISurfaceV2.RendererRequired.selector);
        vm.prank(artist);
        c.setRenderer(address(0));
    }

    function test_init_resolvesRendererSlot() public {
        // No choice made: the factory default fills the slot.
        SurfaceV2 c = _collection(_freeConfig());
        assertEq(c.renderer(), address(renderer));
        (SurfaceConfig memory cfg,) = c.config();
        assertEq(cfg.renderer, address(renderer));

        // An explicit choice at init wins over the default.
        MockRenderer custom = new MockRenderer();
        SurfaceConfig memory cfg2 = _freeConfig();
        cfg2.renderer = address(custom);
        SurfaceV2 c2 = _collection(cfg2);
        assertEq(c2.renderer(), address(custom));
    }

    /// @dev Locks passed true in the config take effect at init: the
    ///      collection is born locked, no second transaction to remember.
    function test_init_bornLocked() public {
        SurfaceConfig memory cfg = _freeConfig();
        cfg.supplyCap = 5;
        cfg.rendererLocked = true;
        cfg.supplyLocked = true;
        SurfaceV2 c = _collection(cfg);

        assertTrue(c.isRendererLocked());
        assertTrue(c.isSupplyLocked());
        vm.expectRevert(ISurfaceV2.RendererIsLocked.selector);
        vm.prank(artist);
        c.setRenderer(makeAddr("newRenderer"));
        vm.expectRevert(ISurfaceV2.SupplyIsLocked.selector);
        vm.prank(artist);
        c.setSupplyCap(10);
    }

    // ── lockRenderer (one-way, optional) ─────────────────────────────────────

    function test_lockRenderer_isOneWayAndOptional() public {
        SurfaceV2 c = _collection(_freeConfig());
        assertFalse(c.isRendererLocked(), "not locked by default");

        address beforeLock = address(new MockRenderer());
        vm.prank(artist);
        c.setRenderer(beforeLock);

        vm.expectEmit(false, false, false, false, address(c));
        emit ISurfaceV2.RendererLocked();
        vm.prank(artist);
        c.lockRenderer();
        assertTrue(c.isRendererLocked());

        vm.expectRevert(ISurfaceV2.RendererIsLocked.selector);
        vm.prank(artist);
        c.lockRenderer();
    }

    // ── factory deprecation / pause ───────────────────────────────────────────

    function test_factory_deprecate_stopsNewDeploysOnly() public {
        SurfaceV2 existing = _collection(_freeConfig());

        address successor = makeAddr("factoryV2");
        vm.expectEmit(true, false, false, false, address(factory));
        emit SurfaceFactoryV2.Deprecated(successor);
        factory.deprecate(successor);
        assertTrue(factory.deprecated());
        assertEq(factory.successor(), successor);

        address[] memory none = new address[](0);
        vm.expectRevert(SurfaceFactoryV2.FactoryDeprecated.selector);
        factory.createSurfaceCustom("After", "AFT", artist, _freeConfig(), none, address(0), none, address(0));

        _mintTo(existing, collector, 1);
        assertEq(existing.ownerOf(1), collector);

        vm.expectRevert(SurfaceFactoryV2.AlreadyDeprecated.selector);
        factory.deprecate(address(0));
        vm.expectRevert(SurfaceFactoryV2.NotDeployer.selector);
        vm.prank(stranger);
        factory.deprecate(address(0));
    }

    function test_factory_pause_isReversibleAndDeployerOnly() public {
        _collection(_freeConfig());
        assertFalse(factory.paused());

        vm.expectEmit(false, false, false, true, address(factory));
        emit SurfaceFactoryV2.PausedSet(true);
        factory.setPaused(true);
        assertTrue(factory.paused());
        address[] memory none = new address[](0);
        vm.expectRevert(SurfaceFactoryV2.FactoryPaused.selector);
        factory.createSurfaceCustom("Paused", "PAU", artist, _freeConfig(), none, address(0), none, address(0));

        factory.setPaused(false);
        assertFalse(factory.paused());
        _collection(_freeConfig()); // no revert

        vm.expectRevert(SurfaceFactoryV2.NotDeployer.selector);
        vm.prank(stranger);
        factory.setPaused(true);
    }

    // ── renounceOwnership / Ownable2Step ──────────────────────────────────────

    function test_renounceOwnership_setsOwnerToZero() public {
        SurfaceV2 c = _collection(_freeConfig());
        vm.prank(artist);
        c.renounceOwnership();
        assertEq(c.owner(), address(0));
    }

    function test_renounceOwnership_onlyOwner() public {
        SurfaceV2 c = _collection(_freeConfig());
        vm.prank(stranger);
        vm.expectRevert();
        c.renounceOwnership();
        assertEq(c.owner(), artist);
    }

    function test_renounceOwnership_freezesManagement() public {
        SurfaceV2 c = _collection(_freeConfig());
        vm.prank(artist);
        c.renounceOwnership();
        vm.prank(artist);
        vm.expectRevert();
        c.setRoyalty(100, address(0));
    }

    function test_ownable2Step_transferRequiresAcceptance() public {
        SurfaceV2 c = _collection(_freeConfig());
        address newOwner = makeAddr("newOwner");

        vm.prank(artist);
        c.transferOwnership(newOwner);
        assertEq(c.owner(), artist); // not transferred until accepted
        assertEq(c.pendingOwner(), newOwner);

        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", stranger));
        vm.prank(stranger);
        c.acceptOwnership();

        vm.prank(newOwner);
        c.acceptOwnership();
        assertEq(c.owner(), newOwner);
    }

    // ── fuzz: batch mint id assignment is exact ──────────────────────────────

    function testFuzz_mintTo_batchIdsAreContiguous(uint8 qtyRaw) public {
        uint256 qty = bound(qtyRaw, 1, 50);
        SurfaceV2 c = _collection(_freeConfig());
        uint256 firstTokenId = _mintTo(c, collector, qty);
        assertEq(firstTokenId, 1);
        assertEq(c.balanceOf(collector), qty);
        for (uint256 i = 0; i < qty; i++) {
            assertEq(c.ownerOf(firstTokenId + i), collector);
        }
    }

    // ════════════════════════════════════════════════════════════════════
    // Admins: the owner may grant flat, full-access admin keys. An admin can
    // call every management function the owner can EXCEPT managing the admin
    // set (addAdmin/removeAdmin) and transferring ownership, which stay
    // owner-only. v2 has no pooled/sequential split, so the minter set is
    // admin-manageable unconditionally (v1's pooled owner-only carve-out is
    // gone with pooled mode).
    // ════════════════════════════════════════════════════════════════════

    address internal admin = makeAddr("admin");
    bytes internal ownableUnauthAdmin = abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", admin);
    bytes internal ownableUnauthStranger = abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", stranger);

    function test_isAdmin_countsOwner() public {
        SurfaceV2 c = _collection(_freeConfig());
        assertTrue(c.isAdmin(artist), "the owner is an admin");
        assertFalse(c.isAdmin(stranger), "a stranger is not");

        address heir = makeAddr("heir");
        vm.prank(artist);
        c.transferOwnership(heir);
        vm.prank(heir);
        c.acceptOwnership();
        assertTrue(c.isAdmin(heir), "the new owner is an admin");
        assertFalse(c.isAdmin(artist), "the old owner is not");
    }

    function test_owner_grantsAndRevokesAdmin() public {
        SurfaceV2 c = _collection(_freeConfig());
        assertFalse(c.isAdmin(admin));

        vm.expectEmit(true, false, false, true, address(c));
        emit ISurfaceV2.AdminSet(admin, true);
        vm.prank(artist);
        c.addAdmin(admin);
        assertTrue(c.isAdmin(admin));

        vm.expectEmit(true, false, false, true, address(c));
        emit ISurfaceV2.AdminSet(admin, false);
        vm.prank(artist);
        c.removeAdmin(admin);
        assertFalse(c.isAdmin(admin));
    }

    function test_addAdmin_rejectsZeroAccount() public {
        SurfaceV2 c = _collection(_freeConfig());
        vm.expectRevert(ISurfaceV2.ZeroAccount.selector);
        vm.prank(artist);
        c.addAdmin(address(0));
    }

    function test_addAdmin_rejectsAlreadyAdmin() public {
        SurfaceV2 c = _collection(_freeConfig());
        vm.startPrank(artist);
        c.addAdmin(admin);
        vm.expectRevert(ISurfaceV2.AlreadyAdmin.selector);
        c.addAdmin(admin);
        vm.stopPrank();
    }

    /// @dev The owner is already an admin (isAdmin reads it live), so a
    ///      self-grant is refused.
    function test_addAdmin_rejectsOwner() public {
        SurfaceV2 c = _collection(_freeConfig());
        vm.expectRevert(ISurfaceV2.AlreadyAdmin.selector);
        vm.prank(artist);
        c.addAdmin(artist);
        assertFalse(c.isAdmin(stranger));
    }

    function test_addAdmin_onlyOwner_notStranger() public {
        SurfaceV2 c = _collection(_freeConfig());
        vm.expectRevert(ownableUnauthStranger);
        vm.prank(stranger);
        c.addAdmin(stranger);
    }

    function test_removeAdmin_rejectsNotAnAdmin() public {
        SurfaceV2 c = _collection(_freeConfig());
        vm.expectRevert(ISurfaceV2.NotAnAdmin.selector);
        vm.prank(artist);
        c.removeAdmin(admin);
    }

    function test_removeAdmin_rejectsDoubleRemove() public {
        SurfaceV2 c = _collection(_freeConfig());
        vm.startPrank(artist);
        c.addAdmin(admin);
        c.removeAdmin(admin);
        vm.expectRevert(ISurfaceV2.NotAnAdmin.selector);
        c.removeAdmin(admin);
        vm.stopPrank();
    }

    function test_removeAdmin_rejectsUnrelatedCaller() public {
        SurfaceV2 c = _collection(_freeConfig());
        vm.prank(artist);
        c.addAdmin(admin);

        vm.expectRevert(ISurfaceV2.NotAuthorized.selector);
        vm.prank(stranger);
        c.removeAdmin(admin);
    }

    function test_admin_canRenounceSelf() public {
        SurfaceV2 c = _collection(_freeConfig());
        vm.prank(artist);
        c.addAdmin(admin);
        assertTrue(c.isAdmin(admin));

        vm.expectEmit(true, false, false, true, address(c));
        emit ISurfaceV2.AdminSet(admin, false);
        vm.prank(admin);
        c.removeAdmin(admin);
        assertFalse(c.isAdmin(admin));

        vm.expectRevert(ISurfaceV2.NotAuthorized.selector);
        vm.prank(admin);
        c.setSupplyCap(0);
    }

    /// @dev A grant made by one owner must not survive an ownership transfer.
    function test_adminGrant_expiresOnOwnershipTransfer() public {
        SurfaceV2 c = _collection(_freeConfig());
        address newOwner = makeAddr("newOwner");
        vm.prank(artist);
        c.addAdmin(admin);
        assertTrue(c.isAdmin(admin), "granted under the original owner");

        vm.prank(artist);
        c.transferOwnership(newOwner);
        vm.prank(newOwner);
        c.acceptOwnership();

        assertFalse(c.isAdmin(admin), "stale admin invalidated by the transfer");
        vm.prank(admin);
        vm.expectRevert(ISurfaceV2.NotAuthorized.selector);
        c.setSupplyCap(0);

        assertTrue(c.isAdmin(newOwner), "new owner is an admin");
        vm.prank(newOwner);
        c.addAdmin(admin);
        assertTrue(c.isAdmin(admin), "re-granted under the new owner");
        vm.prank(admin);
        c.setSupplyCap(0); // now allowed
    }

    /// @dev v2 has no pooled/sequential split: admins keep minter authority
    ///      unconditionally (v1's pooled owner-only carve-out does not exist).
    function test_setMinter_allowsAdmin() public {
        SurfaceV2 c = _collection(_freeConfig());
        vm.prank(artist);
        c.addAdmin(admin);
        address m = makeAddr("minter");
        vm.prank(admin);
        c.setMinter(m, true);
        assertTrue(c.isMinter(m), "admin set a minter");
    }

    function test_admin_canRunEveryManagementFunction() public {
        SurfaceV2 c = _collection(_freeConfig());
        vm.prank(artist);
        c.addAdmin(admin);

        _mintTo(c, collector, 1);

        address newRenderer = address(new MockRenderer());
        vm.startPrank(admin);
        c.setRoyalty(250, makeAddr("royalty"));
        c.setSupplyCap(100);
        c.setRenderer(newRenderer);
        c.setMinter(makeAddr("minter"), true);
        c.notifyMetadataUpdate(1, 1);
        c.lockSupply();
        c.lockRenderer();
        vm.stopPrank();

        assertTrue(c.isMinter(makeAddr("minter")));
        assertTrue(c.isSupplyLocked());
        assertTrue(c.isRendererLocked());
    }

    function test_admin_cannotAddOrRemovePeers() public {
        SurfaceV2 c = _collection(_freeConfig());
        address admin2 = makeAddr("admin2");
        vm.startPrank(artist);
        c.addAdmin(admin);
        c.addAdmin(admin2);
        vm.stopPrank();

        vm.expectRevert(ownableUnauthAdmin);
        vm.prank(admin);
        c.addAdmin(makeAddr("other"));

        vm.expectRevert(ISurfaceV2.NotAuthorized.selector);
        vm.prank(admin);
        c.removeAdmin(admin2);
    }

    function test_admin_cannotTransferOwnership() public {
        SurfaceV2 c = _collection(_freeConfig());
        vm.prank(artist);
        c.addAdmin(admin);

        vm.expectRevert(ownableUnauthAdmin);
        vm.prank(admin);
        c.transferOwnership(admin);
    }

    function test_revokedAdmin_losesAccess() public {
        SurfaceV2 c = _collection(_freeConfig());
        vm.startPrank(artist);
        c.addAdmin(admin);
        c.removeAdmin(admin);
        vm.stopPrank();

        vm.expectRevert(ISurfaceV2.NotAuthorized.selector);
        vm.prank(admin);
        c.setSupplyCap(0);
    }

    function test_nonAdmin_cannotManage() public {
        SurfaceV2 c = _collection(_freeConfig());
        vm.expectRevert(ISurfaceV2.NotAuthorized.selector);
        vm.prank(stranger);
        c.setSupplyCap(0);
    }

    function test_owner_remainsAuthorizedAlongsideAdmins() public {
        SurfaceV2 c = _collection(_freeConfig());
        vm.prank(artist);
        c.addAdmin(admin);

        vm.prank(artist);
        c.setSupplyCap(10);
        (, uint256 minted) = c.config();
        assertEq(minted, 0);
    }

    function test_lockRenderer_blocksAdminSwap() public {
        SurfaceV2 c = _collection(_freeConfig());
        vm.prank(artist);
        c.addAdmin(admin);

        vm.prank(admin);
        c.lockRenderer();

        vm.expectRevert(ISurfaceV2.RendererIsLocked.selector);
        vm.prank(admin);
        c.setRenderer(makeAddr("nope"));
    }

    // ════════════════════════════════════════════════════════════════════
    // Access control matrix + double-init guarantees (from
    // SurfaceSecurity.t.sol). Reentrancy and payment-conservation coverage
    // lives with the minter suite: the token's mint path makes no external
    // calls.
    // ════════════════════════════════════════════════════════════════════

    function test_accessControl_onlyOwnerOrAdminFunctions() public {
        SurfaceV2 c = _collection(_freeConfig());
        bytes memory unauth = abi.encodeWithSelector(ISurfaceV2.NotAuthorized.selector);

        vm.startPrank(stranger);

        vm.expectRevert(unauth);
        c.setRenderer(makeAddr("r"));

        vm.expectRevert(unauth);
        c.setMinter(makeAddr("m"), true);

        vm.expectRevert(unauth);
        c.setRoyalty(100, stranger);

        vm.expectRevert(unauth);
        c.setSupplyCap(1);

        vm.expectRevert(unauth);
        c.lockSupply();

        vm.expectRevert(unauth);
        c.notifyMetadataUpdate(1, 1);

        vm.expectRevert(unauth);
        c.lockRenderer();

        vm.expectRevert(unauth);
        c.rescueStrayETH(stranger);

        vm.stopPrank();
    }

    function test_accessControl_minterGatedFunctions() public {
        SurfaceV2 c = _collection(_freeConfig());

        vm.expectRevert(ISurfaceV2.NotMinter.selector);
        vm.prank(stranger);
        c.mintTo(stranger, 1);

        bytes32[] memory seeds = new bytes32[](1);
        vm.expectRevert(ISurfaceV2.NotMinter.selector);
        vm.prank(stranger);
        c.mintToSeeded(stranger, seeds);
    }

    function test_accessControl_burnRequiresOwnerOrApproved() public {
        SurfaceV2 c = _collection(_freeConfig());
        _mintTo(c, collector, 1);

        vm.expectRevert(ISurfaceV2.NotAuthorized.selector);
        vm.prank(stranger);
        c.burn(1);

        vm.prank(collector);
        c.approve(stranger, 1);
        vm.prank(stranger);
        c.burn(1);
        assertEq(c.balanceOf(collector), 0);
    }

    function test_accessControl_burnRequiresExistingToken() public {
        SurfaceV2 c = _collection(_freeConfig());
        vm.expectRevert(abi.encodeWithSignature("ERC721NonexistentToken(uint256)", 1));
        c.burn(1);
    }

    function test_unauthorizedMinter_cannotMintTo() public {
        SurfaceV2 c = _collection(_freeConfig());
        vm.expectRevert(ISurfaceV2.NotMinter.selector);
        vm.prank(stranger);
        c.mintTo(stranger, 1);
    }

    function test_revokedMinter_losesAccess() public {
        SurfaceV2 c = _collection(_freeConfig());
        MockMinterV2 minter = new MockMinterV2();
        vm.prank(artist);
        c.setMinter(address(minter), true);
        assertTrue(c.isMinter(address(minter)));

        vm.prank(artist);
        c.setMinter(address(minter), false);
        assertFalse(c.isMinter(address(minter)));

        vm.expectRevert(ISurfaceV2.NotMinter.selector);
        minter.callMintTo(ISurfaceV2(address(c)), collector, 1);
    }

    function test_setMinter_rejectsZeroAddress() public {
        SurfaceV2 c = _collection(_freeConfig());
        vm.expectRevert(ISurfaceV2.ZeroMinter.selector);
        vm.prank(artist);
        c.setMinter(address(0), true);
    }

    function test_confirm_doubleInitReverts() public {
        SurfaceV2 c = _collection(_freeConfig());
        InitParamsV2 memory p = _rawInitParams(_freeConfig());
        vm.expectRevert(abi.encodeWithSignature("InvalidInitialization()"));
        c.initialize(p);
    }

    function test_confirm_implCannotBeInitialized() public {
        InitParamsV2 memory p = _rawInitParams(_freeConfig());
        vm.expectRevert(abi.encodeWithSignature("InvalidInitialization()"));
        impl.initialize(p);
    }

    // ════════════════════════════════════════════════════════════════════
    // Creator attribution: setCreators / isListedCreator / isConfirmedCreator
    // against a mock catalog. The real Catalog handshake is covered end to
    // end in v1's CreatorAttribution.t.sol; this isolates SurfaceV2's read
    // side (setCreators, isListedCreator, isConfirmedCreator, catalog()).
    // ════════════════════════════════════════════════════════════════════

    function test_creators_listedButUnconfirmedByDefault() public {
        MockCatalogV2 catalog = new MockCatalogV2();
        address collabB = makeAddr("collabB");
        address[] memory creators = new address[](1);
        creators[0] = collabB;

        SurfaceV2 c = SurfaceV2(
            factory.createSurfaceCustom(
                "Collab", "CLB", artist, _freeConfig(), new address[](0), address(0), creators, address(0)
            )
        );
        // no catalog wired on this factory: listing works, confirmation is
        // always false regardless of the mock's state.
        assertTrue(c.isListedCreator(collabB));
        assertFalse(c.isConfirmedCreator(collabB));
        assertEq(c.catalog(), address(0));
        catalog.setRegistered(collabB, address(c), true);
        assertFalse(c.isConfirmedCreator(collabB), "no catalog wired => never confirmed");
    }

    function test_creators_confirmedRequiresListedAndCatalogClaim() public {
        MockCatalogV2 catalog = new MockCatalogV2();
        SurfaceFactoryV2 f2 = new SurfaceFactoryV2(address(impl), address(minterImpl), address(renderer), address(catalog));

        address collabB = makeAddr("collabB");
        address[] memory creators = new address[](1);
        creators[0] = collabB;
        SurfaceV2 c = SurfaceV2(
            f2.createSurfaceCustom(
                "Collab", "CLB", artist, _freeConfig(), new address[](0), address(0), creators, address(0)
            )
        );

        assertTrue(c.isListedCreator(collabB), "listed at init");
        assertFalse(c.isConfirmedCreator(collabB), "listing alone is not confirmation");

        catalog.setRegistered(collabB, address(c), true);
        assertTrue(c.isConfirmedCreator(collabB), "listed + claimed = confirmed");

        catalog.setRegistered(collabB, address(c), false);
        assertFalse(c.isConfirmedCreator(collabB), "un-claim revokes confirmation live");
    }

    function test_creators_impostorCannotConfirm_notListed() public {
        MockCatalogV2 catalog = new MockCatalogV2();
        SurfaceFactoryV2 f2 = new SurfaceFactoryV2(address(impl), address(minterImpl), address(renderer), address(catalog));
        SurfaceV2 c = SurfaceV2(
            f2.createSurfaceCustom(
                "Solo", "SOLO", artist, _freeConfig(), new address[](0), address(0), new address[](0), address(0)
            )
        );

        address impostor = makeAddr("impostor");
        catalog.setRegistered(impostor, address(c), true);
        assertFalse(c.isListedCreator(impostor));
        assertFalse(c.isConfirmedCreator(impostor));
    }

    function test_setCreators_ownerCanAddAndRemoveListings() public {
        MockCatalogV2 catalog = new MockCatalogV2();
        SurfaceFactoryV2 f2 = new SurfaceFactoryV2(address(impl), address(minterImpl), address(renderer), address(catalog));
        SurfaceV2 c = SurfaceV2(
            f2.createSurfaceCustom(
                "Solo", "SOLO", artist, _freeConfig(), new address[](0), address(0), new address[](0), address(0)
            )
        );

        address collabD = makeAddr("collabD");
        assertFalse(c.isListedCreator(collabD));

        address[] memory add = new address[](1);
        add[0] = collabD;
        vm.expectEmit(true, false, false, true, address(c));
        emit ISurfaceV2.CreatorListed(collabD, true);
        vm.prank(artist);
        c.setCreators(add, true);
        assertTrue(c.isListedCreator(collabD));

        catalog.setRegistered(collabD, address(c), true);
        assertTrue(c.isConfirmedCreator(collabD));
        vm.prank(artist);
        c.setCreators(add, false);
        assertFalse(c.isConfirmedCreator(collabD), "unlisting revokes confirmation");
    }

    function test_setCreators_onlyOwnerOrAdmin() public {
        SurfaceV2 c = _collection(_freeConfig());
        address[] memory add = new address[](1);
        add[0] = stranger;
        vm.expectRevert(ISurfaceV2.NotAuthorized.selector);
        vm.prank(stranger);
        c.setCreators(add, true);
    }

    function test_catalog_addressExposed() public {
        MockCatalogV2 catalog = new MockCatalogV2();
        SurfaceFactoryV2 f2 = new SurfaceFactoryV2(address(impl), address(minterImpl), address(renderer), address(catalog));
        SurfaceV2 c = SurfaceV2(
            f2.createSurfaceCustom(
                "Solo", "SOLO", artist, _freeConfig(), new address[](0), address(0), new address[](0), address(0)
            )
        );
        assertEq(c.catalog(), address(catalog));
    }
}
