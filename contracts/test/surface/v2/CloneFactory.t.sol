// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {SurfaceV2Base} from "./SurfaceV2Base.sol";
import {Surface} from "../../../src/surface/v2/Surface.sol";
import {CloneFactory} from "../../../src/surface/v2/CloneFactory.sol";
import {ISurface} from "../../../src/surface/v2/interfaces/ISurface.sol";

contract CloneFactoryTest is SurfaceV2Base {
    address internal minter = makeAddr("minter");

    function _init() internal view returns (bytes memory) {
        return abi.encodeCall(Surface.initialize, ("N", "S", artist, address(renderer), 0, 0, artist, minter));
    }

    function test_constructor() public {
        assertEq(tokenFactory.implementation(), address(surfaceImpl));
        assertEq(tokenFactory.deployer(), address(this));
        assertFalse(tokenFactory.paused());
        assertFalse(tokenFactory.deprecated());
        vm.expectRevert(abi.encodeWithSelector(CloneFactory.NotAContract.selector, stranger));
        new CloneFactory(stranger);
    }

    function test_create() public {
        vm.expectEmit(true, false, true, false, address(tokenFactory));
        emit CloneFactory.Created(address(surfaceImpl), address(0), stranger);
        vm.prank(stranger);
        address instance = tokenFactory.create(_init());
        assertTrue(tokenFactory.isInstance(instance));
        assertEq(Surface(instance).owner(), artist);
        assertEq(Surface(instance).minter(), minter);
    }

    function test_create_bubblesInitRevert() public {
        bytes memory bad =
            abi.encodeCall(Surface.initialize, ("N", "S", artist, address(renderer), 0, 0, artist, address(0)));
        vm.expectRevert(ISurface.MinterRequired.selector);
        tokenFactory.create(bad);
    }

    function test_create_emptyInitDataReverts() public {
        vm.expectRevert();
        tokenFactory.create("");
    }

    function test_createDeterministic_matchesPredict() public {
        bytes32 salt = keccak256("s");
        address predicted = tokenFactory.predict(salt, stranger);
        vm.expectEmit(address(tokenFactory));
        emit CloneFactory.Created(address(surfaceImpl), predicted, stranger);
        vm.prank(stranger);
        address instance = tokenFactory.createDeterministic(salt, _init());
        assertEq(instance, predicted);
        assertTrue(tokenFactory.isInstance(instance));
    }

    function test_predict_namespacedByCaller() public {
        bytes32 salt = keccak256("s");
        assertTrue(tokenFactory.predict(salt, stranger) != tokenFactory.predict(salt, artist));
        // The same salt from a different caller lands at its own address.
        vm.prank(artist);
        address a = tokenFactory.createDeterministic(salt, _init());
        vm.prank(stranger);
        address b = tokenFactory.createDeterministic(salt, _init());
        assertEq(a, tokenFactory.predict(salt, artist));
        assertEq(b, tokenFactory.predict(salt, stranger));
        // Reusing a salt as the same caller collides.
        vm.prank(stranger);
        vm.expectRevert();
        tokenFactory.createDeterministic(salt, _init());
    }

    function test_isInstance_falseForOthers() public view {
        assertFalse(tokenFactory.isInstance(address(surfaceImpl)));
        assertFalse(tokenFactory.isInstance(stranger));
    }

    function test_pause() public {
        vm.prank(stranger);
        vm.expectRevert(CloneFactory.NotDeployer.selector);
        tokenFactory.setPaused(true);

        address existing = tokenFactory.create(_init());
        vm.expectEmit(address(tokenFactory));
        emit CloneFactory.PausedSet(true);
        tokenFactory.setPaused(true);
        vm.expectRevert(CloneFactory.FactoryPaused.selector);
        tokenFactory.create(_init());
        vm.expectRevert(CloneFactory.FactoryPaused.selector);
        tokenFactory.createDeterministic(bytes32(0), _init());

        // Existing instances are untouched.
        vm.prank(minter);
        Surface(existing).mintTo(collector, 1);

        tokenFactory.setPaused(false);
        tokenFactory.create(_init());
    }

    function test_deprecate() public {
        address next = makeAddr("next");
        vm.prank(stranger);
        vm.expectRevert(CloneFactory.NotDeployer.selector);
        tokenFactory.deprecate(next);

        address existing = tokenFactory.create(_init());
        vm.expectEmit(address(tokenFactory));
        emit CloneFactory.Deprecated(next);
        tokenFactory.deprecate(next);
        assertTrue(tokenFactory.deprecated());
        assertEq(tokenFactory.successor(), next);

        vm.expectRevert(CloneFactory.FactoryDeprecated.selector);
        tokenFactory.create(_init());
        vm.expectRevert(CloneFactory.AlreadyDeprecated.selector);
        tokenFactory.deprecate(stranger);
        // One-way: unpausing does not revive it.
        tokenFactory.setPaused(false);
        vm.expectRevert(CloneFactory.FactoryDeprecated.selector);
        tokenFactory.create(_init());

        assertTrue(tokenFactory.isInstance(existing));
        vm.prank(minter);
        Surface(existing).mintTo(collector, 1);
    }
}
