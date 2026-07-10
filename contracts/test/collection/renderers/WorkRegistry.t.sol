// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {Collection} from "../../../src/collection/Collection.sol";
import {CollectionFactory} from "../../../src/collection/CollectionFactory.sol";
import {GenerativeRenderer} from "../../../src/collection/renderers/GenerativeRenderer.sol";
import {RenderAssets} from "../../../src/collection/renderers/RenderAssets.sol";
import {CodeKind, CodeRef, WorkConfig} from "../../../src/collection/renderers/WorkTypes.sol";
import {CollectionConfig, IdMode} from "../../../src/collection/CollectionTypes.sol";
import {MockRenderer} from "../mocks/CollectionMocks.sol";

/// @notice The GenerativeRenderer work registry: per-collection WorkConfig
///         stored in renderer-land, written under the collection's own
///         owner/admin authority, lockable one-way per collection. Rendering
///         itself is covered by the fork test; this suite covers the
///         registry's auth and permanence semantics with no scripty needed.
contract WorkRegistryTest is Test {
    GenerativeRenderer internal renderer;
    RenderAssets internal assets;
    Collection internal collection;

    address internal artist = makeAddr("artist");
    address internal admin = makeAddr("admin");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        assets = new RenderAssets();
        // Registry functions never touch the builder/gunzip store; dummy
        // nonzero addresses keep the constructor honest without a fork.
        renderer = new GenerativeRenderer(
            makeAddr("scriptyBuilder"), address(assets), makeAddr("gunzipStore"), "gunzip.js"
        );

        Collection impl = new Collection();
        CollectionFactory factory =
            new CollectionFactory(address(impl), address(new MockRenderer()), address(0));
        CollectionConfig memory cfg;
        cfg.idMode = IdMode.Sequential;
        collection = Collection(
            factory.createCollection(
                "Work Registry", "WREG", artist, cfg, new address[](0), new address[](0)
            )
        );
    }

    function _work(bytes32 hash_) internal pure returns (WorkConfig memory w) {
        CodeRef[] memory code = new CodeRef[](1);
        code[0] = CodeRef({store: address(0xC0DE), name: "sketch.js", kind: CodeKind.Script});
        w.code = code;
        w.deps = new CodeRef[](0);
        w.codeHash = hash_;
        w.injectionVersion = 1;
    }

    function test_setWork_ownerAndAdminOnly() public {
        vm.expectRevert(GenerativeRenderer.NotCollectionAdmin.selector);
        vm.prank(stranger);
        renderer.setWork(address(collection), _work("h1"));

        vm.expectEmit(true, false, false, true, address(renderer));
        emit GenerativeRenderer.WorkSet(address(collection), "h1");
        vm.prank(artist);
        renderer.setWork(address(collection), _work("h1"));
        assertEq(renderer.workOf(address(collection)).codeHash, "h1");

        // a collection admin carries the same authority
        vm.prank(artist);
        collection.addAdmin(admin);
        vm.prank(admin);
        renderer.setWork(address(collection), _work("h2"));
        assertEq(renderer.workOf(address(collection)).codeHash, "h2");
        assertEq(renderer.workOf(address(collection)).code.length, 1, "arrays re-copied");
    }

    function test_lockWork_isOneWayPerCollection() public {
        vm.prank(artist);
        renderer.setWork(address(collection), _work("final"));

        vm.expectRevert(GenerativeRenderer.NotCollectionAdmin.selector);
        vm.prank(stranger);
        renderer.lockWork(address(collection));

        vm.expectEmit(true, false, false, false, address(renderer));
        emit GenerativeRenderer.WorkLocked(address(collection));
        vm.prank(artist);
        renderer.lockWork(address(collection));
        assertTrue(renderer.workLockedOf(address(collection)));

        vm.expectRevert(GenerativeRenderer.WorkIsLocked.selector);
        vm.prank(artist);
        renderer.setWork(address(collection), _work("nope"));
        vm.expectRevert(GenerativeRenderer.WorkIsLocked.selector);
        vm.prank(artist);
        renderer.lockWork(address(collection));
        assertEq(renderer.workOf(address(collection)).codeHash, "final", "locked work unchanged");
    }

    /// @dev Full presentation permanence = pointer lock on the collection +
    ///      work lock in the renderer. Each is independently one-way.
    function test_fullPermanence_pointerLockPlusWorkLock() public {
        vm.startPrank(artist);
        collection.setRenderer(address(renderer));
        renderer.setWork(address(collection), _work("final"));
        renderer.lockWork(address(collection));
        collection.lockRenderer();
        vm.stopPrank();

        assertTrue(collection.isRendererLocked());
        assertTrue(renderer.workLockedOf(address(collection)));
        assertEq(collection.renderer(), address(renderer));
    }
}
