// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {Surface} from "../../src/surface/Surface.sol";
import {PooledSurface} from "../../src/surface/PooledSurface.sol";
import {SurfaceFactory} from "../../src/surface/SurfaceFactory.sol";
import {SurfaceConfig} from "../../src/surface/SurfaceTypes.sol";
import {ISurfaceCore} from "../../src/surface/interfaces/ISurfaceCore.sol";

import {MockRenderer} from "./mocks/SurfaceMocks.sol";

/// @dev The factory may deploy with NO default renderer (defaultRenderer == 0),
///      which is what the lean platform deploy does (DeploySurfaceSystem.s.sol).
///      Then every collection must bring its own renderer via cfg.renderer, and
///      one that names none reverts RendererRequired at creation. The #148
///      hardening still applies to a nonzero default.
contract SurfaceFactoryNoDefaultTest is Test {
    Surface internal impl;
    PooledSurface internal pooledImpl;
    MockRenderer internal renderer;
    SurfaceFactory internal factory;

    address internal artist = makeAddr("artist");

    function setUp() public {
        impl = new Surface();
        pooledImpl = new PooledSurface();
        renderer = new MockRenderer();
        // The lean deploy: no default renderer, no catalog.
        factory = new SurfaceFactory(address(impl), address(pooledImpl), address(0), address(0));
    }

    function _empty() internal pure returns (address[] memory a) {
        a = new address[](0);
    }

    function test_factory_constructsWithZeroDefaultRenderer() public view {
        assertEq(factory.defaultRenderer(), address(0), "no default renderer");
    }

    function test_createSurface_withOwnRenderer_succeeds() public {
        SurfaceConfig memory cfg;
        cfg.renderer = address(renderer);
        Surface c = Surface(factory.createSurface("N", "S", artist, cfg, _empty(), _empty()));
        assertEq(c.renderer(), address(renderer), "collection uses its own renderer");
    }

    function test_createSurface_withoutRenderer_revertsRendererRequired() public {
        SurfaceConfig memory cfg; // cfg.renderer == 0, and no factory default
        vm.expectRevert(ISurfaceCore.RendererRequired.selector);
        factory.createSurface("N", "S", artist, cfg, _empty(), _empty());
    }

    function test_createPooled_withoutRenderer_revertsRendererRequired() public {
        SurfaceConfig memory cfg;
        vm.expectRevert(ISurfaceCore.RendererRequired.selector);
        factory.createPooledSurface("N", "S", artist, cfg, _empty(), _empty());
    }

    function test_constructor_stillRejectsNonContractDefaultRenderer() public {
        // #148 hardening survives: a NONZERO default renderer must be a real
        // contract; an EOA/typo is refused.
        address eoa = makeAddr("eoa");
        vm.expectRevert(abi.encodeWithSelector(SurfaceFactory.NotAContract.selector, eoa));
        new SurfaceFactory(address(impl), address(pooledImpl), eoa, address(0));
    }
}
