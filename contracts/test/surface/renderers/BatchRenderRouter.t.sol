// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "solady/auth/Ownable.sol";

import {BatchRenderRouter} from "../../../src/surface/renderers/BatchRenderRouter.sol";
import {IBatchRenderRouter} from "../../../src/surface/interfaces/IBatchRenderRouter.sol";
import {IRenderer} from "../../../src/surface/interfaces/IRenderer.sol";

/// @dev Deterministic vendor renderer: returns a string derived from the
///      collection + tokenId, so a test can assert the router dispatched to
///      the right vendor without depending on a real onchain renderer.
contract MockVendor is IRenderer {
    string public label;

    constructor(string memory label_) {
        label = label_;
    }

    function tokenURI(address, uint256 tokenId) external view override returns (string memory) {
        return string.concat("vendor:", label, ":", _toString(tokenId));
    }

    function contractURI(address) external view override returns (string memory) {
        return string.concat("vendor-contract:", label);
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
    MockVendor internal vendorA;
    MockVendor internal vendorB;
    MockCollection internal collection;

    address internal deployer = makeAddr("deployer");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        vm.prank(deployer);
        router = new BatchRenderRouter();
        vendorA = new MockVendor("A");
        vendorB = new MockVendor("B");
        collection = new MockCollection();
    }

    // ── addBatch: authority ─────────────────────────────────────────────────

    function test_addBatch_ownerCanAdd() public {
        vm.prank(deployer);
        router.addBatch(1, 20, address(vendorA), "batch 1");
        assertEq(router.batchCount(), 1);
    }

    function test_addBatch_strangerReverts() public {
        vm.expectRevert(Ownable.Unauthorized.selector);
        vm.prank(stranger);
        router.addBatch(1, 20, address(vendorA), "batch 1");
    }

    // ── addBatch: validation ─────────────────────────────────────────────────

    function test_addBatch_zeroVendorReverts() public {
        vm.expectRevert(IBatchRenderRouter.ZeroVendor.selector);
        vm.prank(deployer);
        router.addBatch(1, 20, address(0), "batch 1");
    }

    function test_addBatch_invertedRangeReverts() public {
        vm.expectRevert(abi.encodeWithSelector(IBatchRenderRouter.InvalidRange.selector, 20, 1));
        vm.prank(deployer);
        router.addBatch(20, 1, address(vendorA), "batch 1");
    }

    function test_addBatch_overlapReverts() public {
        vm.startPrank(deployer);
        router.addBatch(1, 20, address(vendorA), "batch 1");
        vm.expectRevert(abi.encodeWithSelector(IBatchRenderRouter.OverlappingRange.selector, 15, 30, 0));
        router.addBatch(15, 30, address(vendorB), "batch 2");
        vm.stopPrank();
    }

    function test_addBatch_adjacentRangesDoNotOverlap() public {
        vm.startPrank(deployer);
        router.addBatch(1, 20, address(vendorA), "batch 1");
        router.addBatch(21, 40, address(vendorB), "batch 2"); // does not revert
        vm.stopPrank();
        assertEq(router.batchCount(), 2);
    }

    function test_addBatch_singleTokenRangeAllowed() public {
        vm.prank(deployer);
        router.addBatch(5, 5, address(vendorA), "single");
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
        router.addBatch(1, 20, address(vendorA), "batch 1");
        router.addBatch(21, 40, address(vendorB), "batch 2");
        vm.stopPrank();

        assertEq(router.batchOf(1).vendor, address(vendorA));
        assertEq(router.batchOf(20).vendor, address(vendorA)); // last id of batch 1
        assertEq(router.batchOf(21).vendor, address(vendorB)); // first id of batch 2
        assertEq(router.batchOf(40).vendor, address(vendorB));
    }

    function test_batchOf_noBatchReverts() public {
        vm.prank(deployer);
        router.addBatch(1, 20, address(vendorA), "batch 1");
        vm.expectRevert(abi.encodeWithSelector(IBatchRenderRouter.NoBatchForToken.selector, 21));
        router.batchOf(21);
    }

    // ── tokenURI routing ─────────────────────────────────────────────────────

    function test_tokenURI_routesToCorrectVendor() public {
        vm.startPrank(deployer);
        router.addBatch(1, 20, address(vendorA), "batch 1");
        router.addBatch(21, 40, address(vendorB), "batch 2");
        vm.stopPrank();

        assertEq(router.tokenURI(address(collection), 10), "vendor:A:10");
        assertEq(router.tokenURI(address(collection), 30), "vendor:B:30");
    }

    function test_tokenURI_noBatchReverts() public {
        vm.expectRevert(abi.encodeWithSelector(IBatchRenderRouter.NoBatchForToken.selector, 1));
        router.tokenURI(address(collection), 1);
    }

    function test_contractURI_delegatesToFirstBatchVendor() public {
        vm.startPrank(deployer);
        router.addBatch(1, 20, address(vendorA), "batch 1");
        router.addBatch(21, 40, address(vendorB), "batch 2");
        vm.stopPrank();

        assertEq(router.contractURI(address(collection)), "vendor-contract:A");
    }

    // ── requestRefresh: authority ────────────────────────────────────────────

    function test_requestRefresh_registeredVendorSucceeds() public {
        vm.startPrank(deployer);
        router.addBatch(1, 20, address(vendorA), "batch 1");
        router.bindCollection(address(collection));
        vm.stopPrank();

        vm.prank(address(vendorA));
        router.requestRefresh(7);

        assertEq(collection.callCount(), 1);
        assertEq(collection.lastFrom(), 7);
        assertEq(collection.lastTo(), 7);
    }

    function test_requestRefresh_strangerReverts() public {
        vm.startPrank(deployer);
        router.addBatch(1, 20, address(vendorA), "batch 1");
        router.bindCollection(address(collection));
        vm.stopPrank();

        vm.expectRevert(IBatchRenderRouter.NotAuthorized.selector);
        vm.prank(stranger);
        router.requestRefresh(7);

        assertEq(collection.callCount(), 0);
    }

    function test_requestRefresh_unregisteredVendorReverts() public {
        vm.startPrank(deployer);
        router.addBatch(1, 20, address(vendorA), "batch 1");
        router.bindCollection(address(collection));
        vm.stopPrank();

        // vendorB has never been added to a batch, so it is not a registered vendor
        vm.expectRevert(IBatchRenderRouter.NotAuthorized.selector);
        vm.prank(address(vendorB));
        router.requestRefresh(7);
    }

    function test_requestRefresh_collectionNotSetReverts() public {
        vm.prank(deployer);
        router.addBatch(1, 20, address(vendorA), "batch 1");

        vm.expectRevert(IBatchRenderRouter.CollectionNotSet.selector);
        vm.prank(address(vendorA));
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
}
