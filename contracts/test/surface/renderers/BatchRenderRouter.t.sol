// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "solady/auth/Ownable.sol";

import {BatchRenderRouter} from "../../../src/surface/renderers/BatchRenderRouter.sol";
import {IBatchRenderRouter} from "../../../src/surface/interfaces/IBatchRenderRouter.sol";
import {IRenderer} from "../../../src/surface/interfaces/IRenderer.sol";

/// @dev Deterministic renderer renderer: returns a string derived from the
///      collection + tokenId, so a test can assert the router dispatched to
///      the right renderer without depending on a real onchain renderer.
contract MockRenderer is IRenderer {
    string public label;

    constructor(string memory label_) {
        label = label_;
    }

    function tokenURI(address, uint256 tokenId) external view override returns (string memory) {
        return string.concat("renderer:", label, ":", _toString(tokenId));
    }

    function contractURI(address) external view override returns (string memory) {
        return string.concat("renderer-contract:", label);
    }

    function _toString(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 j = v;
        uint256 len;
        while (j != 0) {
            len++;
            j /= 10;
        }
        bytes memory b = new bytes(len);
        while (v != 0) {
            len -= 1;
            b[len] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
        return string(b);
    }
}

/// @dev Stands in for a Surface collection: records notifyMetadataUpdate
///      calls so a test can assert the relay reached it, with the exact
///      ISurfaceCore.notifyMetadataUpdate selector so a low-level dispatch
///      from the router lands here without implementing the full interface.
contract MockCollection {
    uint256 public lastFrom;
    uint256 public lastTo;
    uint256 public callCount;

    function notifyMetadataUpdate(uint256 fromTokenId, uint256 toTokenId) external {
        lastFrom = fromTokenId;
        lastTo = toTokenId;
        callCount += 1;
    }
}

contract BatchRenderRouterTest is Test {
    BatchRenderRouter internal router;
    MockRenderer internal rendererA;
    MockRenderer internal rendererB;
    MockCollection internal collection;

    address internal deployer = makeAddr("deployer");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        vm.prank(deployer);
        router = new BatchRenderRouter();
        rendererA = new MockRenderer("A");
        rendererB = new MockRenderer("B");
        collection = new MockCollection();
    }

    // ── addBatch: authority ─────────────────────────────────────────────────

    function test_addBatch_ownerCanAdd() public {
        vm.prank(deployer);
        router.addBatch(1, 20, address(rendererA), "batch 1");
        assertEq(router.batchCount(), 1);
    }

    function test_addBatch_strangerReverts() public {
        vm.expectRevert(Ownable.Unauthorized.selector);
        vm.prank(stranger);
        router.addBatch(1, 20, address(rendererA), "batch 1");
    }

    // ── addBatch: validation ─────────────────────────────────────────────────

    function test_addBatch_zeroRendererReverts() public {
        vm.expectRevert(IBatchRenderRouter.ZeroRenderer.selector);
        vm.prank(deployer);
        router.addBatch(1, 20, address(0), "batch 1");
    }

    function test_addBatch_invertedRangeReverts() public {
        vm.expectRevert(abi.encodeWithSelector(IBatchRenderRouter.InvalidRange.selector, 20, 1));
        vm.prank(deployer);
        router.addBatch(20, 1, address(rendererA), "batch 1");
    }

    function test_addBatch_overlapReverts() public {
        vm.startPrank(deployer);
        router.addBatch(1, 20, address(rendererA), "batch 1");
        vm.expectRevert(abi.encodeWithSelector(IBatchRenderRouter.OverlappingRange.selector, 15, 30, 0));
        router.addBatch(15, 30, address(rendererB), "batch 2");
        vm.stopPrank();
    }

    function test_addBatch_adjacentRangesDoNotOverlap() public {
        vm.startPrank(deployer);
        router.addBatch(1, 20, address(rendererA), "batch 1");
        router.addBatch(21, 40, address(rendererB), "batch 2"); // does not revert
        vm.stopPrank();
        assertEq(router.batchCount(), 2);
    }

    function test_addBatch_singleTokenRangeAllowed() public {
        vm.prank(deployer);
        router.addBatch(5, 5, address(rendererA), "single");
        IBatchRenderRouter.Batch memory b = router.batchOf(5);
        assertEq(b.startId, 5);
        assertEq(b.endId, 5);
    }

    // ── batchAt / batchOf ────────────────────────────────────────────────────

    function test_batchAt_outOfBoundsReverts() public {
        vm.expectRevert(abi.encodeWithSelector(IBatchRenderRouter.IndexOutOfBounds.selector, 0));
        router.batchAt(0);
    }

    function test_batchOf_dispatchAcrossBoundaries() public {
        vm.startPrank(deployer);
        router.addBatch(1, 20, address(rendererA), "batch 1");
        router.addBatch(21, 40, address(rendererB), "batch 2");
        vm.stopPrank();

        assertEq(router.batchOf(1).renderer, address(rendererA));
        assertEq(router.batchOf(20).renderer, address(rendererA)); // last id of batch 1
        assertEq(router.batchOf(21).renderer, address(rendererB)); // first id of batch 2
        assertEq(router.batchOf(40).renderer, address(rendererB));
    }

    function test_batchOf_noBatchReverts() public {
        vm.prank(deployer);
        router.addBatch(1, 20, address(rendererA), "batch 1");
        vm.expectRevert(abi.encodeWithSelector(IBatchRenderRouter.NoBatchForToken.selector, 21));
        router.batchOf(21);
    }

    // ── tokenURI routing ─────────────────────────────────────────────────────

    function test_tokenURI_routesToCorrectRenderer() public {
        vm.startPrank(deployer);
        router.addBatch(1, 20, address(rendererA), "batch 1");
        router.addBatch(21, 40, address(rendererB), "batch 2");
        vm.stopPrank();

        assertEq(router.tokenURI(address(collection), 10), "renderer:A:10");
        assertEq(router.tokenURI(address(collection), 30), "renderer:B:30");
    }

    function test_tokenURI_noBatchReverts() public {
        vm.expectRevert(abi.encodeWithSelector(IBatchRenderRouter.NoBatchForToken.selector, 1));
        router.tokenURI(address(collection), 1);
    }

    function test_contractURI_delegatesToFirstBatchRenderer() public {
        vm.startPrank(deployer);
        router.addBatch(1, 20, address(rendererA), "batch 1");
        router.addBatch(21, 40, address(rendererB), "batch 2");
        vm.stopPrank();

        assertEq(router.contractURI(address(collection)), "renderer-contract:A");
    }

    // ── requestRefresh: authority ────────────────────────────────────────────

    function test_requestRefresh_registeredRendererSucceeds() public {
        vm.startPrank(deployer);
        router.addBatch(1, 20, address(rendererA), "batch 1");
        router.bindCollection(address(collection));
        vm.stopPrank();

        vm.prank(address(rendererA));
        router.requestRefresh(7);

        assertEq(collection.callCount(), 1);
        assertEq(collection.lastFrom(), 7);
        assertEq(collection.lastTo(), 7);
    }

    function test_requestRefresh_strangerReverts() public {
        vm.startPrank(deployer);
        router.addBatch(1, 20, address(rendererA), "batch 1");
        router.bindCollection(address(collection));
        vm.stopPrank();

        vm.expectRevert(IBatchRenderRouter.NotAuthorized.selector);
        vm.prank(stranger);
        router.requestRefresh(7);

        assertEq(collection.callCount(), 0);
    }

    function test_requestRefresh_unregisteredRendererReverts() public {
        vm.startPrank(deployer);
        router.addBatch(1, 20, address(rendererA), "batch 1");
        router.bindCollection(address(collection));
        vm.stopPrank();

        // rendererB has never been added to a batch, so it is not a registered renderer
        vm.expectRevert(IBatchRenderRouter.NotAuthorized.selector);
        vm.prank(address(rendererB));
        router.requestRefresh(7);
    }

    function test_requestRefresh_collectionNotSetReverts() public {
        vm.prank(deployer);
        router.addBatch(1, 20, address(rendererA), "batch 1");

        vm.expectRevert(IBatchRenderRouter.CollectionNotSet.selector);
        vm.prank(address(rendererA));
        router.requestRefresh(7);
    }

    // ── bindCollection ───────────────────────────────────────────────────────

    function test_bindCollection_onlyOwner() public {
        vm.expectRevert(Ownable.Unauthorized.selector);
        vm.prank(stranger);
        router.bindCollection(address(collection));
    }

    function test_bindCollection_oneWay() public {
        vm.startPrank(deployer);
        router.bindCollection(address(collection));
        vm.expectRevert(IBatchRenderRouter.CollectionAlreadySet.selector);
        router.bindCollection(address(collection));
        vm.stopPrank();
    }

    function test_bindCollection_zeroAddressReverts() public {
        vm.expectRevert(IBatchRenderRouter.ZeroCollection.selector);
        vm.prank(deployer);
        router.bindCollection(address(0));
    }

    // ── ERC-165 ──────────────────────────────────────────────────────────────

    function test_supportsInterface() public view {
        assertTrue(router.supportsInterface(type(IBatchRenderRouter).interfaceId));
        assertTrue(router.supportsInterface(type(IRenderer).interfaceId));
        assertTrue(router.supportsInterface(0x01ffc9a7)); // ERC-165 itself
        assertFalse(router.supportsInterface(0xdeadbeef));
        // Pin the literal id the frontend hardcodes (packages/abi
        // BATCH_RENDER_ROUTER_INTERFACE_ID). type().interfaceId excludes the
        // inherited IRenderer selectors, so a change to the interface's own
        // function set moves this and must be re-synced on both sides.
        assertEq(type(IBatchRenderRouter).interfaceId, bytes4(0xee4ae0b4));
        assertTrue(router.supportsInterface(0xee4ae0b4));
    }

    // ── setRenderer ──────────────────────────────────────────────────────────

    function test_setRenderer_ownerRepoints() public {
        vm.startPrank(deployer);
        router.addBatch(1, 20, address(rendererA), "batch 1");
        router.setRenderer(0, address(rendererB));
        vm.stopPrank();
        assertEq(router.batchOf(5).renderer, address(rendererB));
        assertEq(router.tokenURI(address(collection), 5), "renderer:B:5");
        // range and label survive the swap
        assertEq(router.batchAt(0).startId, 1);
        assertEq(router.batchAt(0).endId, 20);
        assertEq(router.batchAt(0).label, "batch 1");
    }

    function test_setRenderer_strangerReverts() public {
        vm.prank(deployer);
        router.addBatch(1, 20, address(rendererA), "batch 1");
        vm.expectRevert(Ownable.Unauthorized.selector);
        vm.prank(stranger);
        router.setRenderer(0, address(rendererB));
    }

    function test_setRenderer_zeroAndOutOfBoundsRevert() public {
        vm.startPrank(deployer);
        router.addBatch(1, 20, address(rendererA), "batch 1");
        vm.expectRevert(IBatchRenderRouter.ZeroRenderer.selector);
        router.setRenderer(0, address(0));
        vm.expectRevert(abi.encodeWithSelector(IBatchRenderRouter.IndexOutOfBounds.selector, 1));
        router.setRenderer(1, address(rendererB));
        vm.stopPrank();
    }

}
