// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC721} from "openzeppelin-contracts/contracts/token/ERC721/IERC721.sol";
import {LibString} from "solady/utils/LibString.sol";

import {SovereignCollection} from "../../../src/collection/SovereignCollection.sol";
import {SovereignCollectionFactory} from "../../../src/collection/SovereignCollectionFactory.sol";
import {IRenderer, ICollectionView} from "../../../src/collection/interfaces/IRenderer.sol";
import {IPriceStrategy} from "../../../src/collection/interfaces/IPriceStrategy.sol";
import {
    CollectionConfig,
    IdMode,
    MintMark,
    WorkConfig
} from "../../../src/collection/CollectionTypes.sol";
import {MockRenderer} from "../mocks/CollectionMocks.sol";

// ─────────────────────────────────────────────────────────────────────────────
// Reference fixture: a minimal To Be A Machine rebuilt on the collection
// system. Encodes the design claims from docs/pnd-collection-system.md:
//   1. holder-participation mechanics (lock-a-frame) live in a companion
//      contract with ZERO core support — the companion authorizes against
//      plain ownerOf and reads mint provenance from Mint Marks;
//   2. the price strategy slot expresses dynamic pricing as a pure view of
//      basefee x collective lock state (TBAM's curve shape, linear weight
//      here — the exponent is arithmetic, not architecture);
//   3. per-block liveness and lock-to-freeze are renderer concerns: an
//      onchain view serves flux for unlocked tokens and the frozen frame
//      for locked ones;
//   4. no mint hooks are needed anywhere — participation is post-mint.
// ─────────────────────────────────────────────────────────────────────────────

/// @dev The companion: lock a recent block's frame for a token you own.
contract FrameLock {
    struct Lock {
        bool locked;
        uint64 lockBlock;
        bytes32 lockHash;
    }

    mapping(address => mapping(uint256 => Lock)) public locks;
    mapping(address => uint256) public effectiveLocks; // age-weighted, per collection

    error NotTokenOwner();
    error AlreadyLocked();
    error FrameUnavailable();

    function lockFrame(address collection, uint256 tokenId, uint256 blockNumber) external {
        if (IERC721(collection).ownerOf(tokenId) != msg.sender) revert NotTokenOwner();
        Lock storage l = locks[collection][tokenId];
        if (l.locked) revert AlreadyLocked();

        if (blockNumber == 0) blockNumber = block.number - 1;
        bytes32 bh = blockhash(blockNumber);
        if (bh == bytes32(0)) revert FrameUnavailable(); // > 256 blocks old, or future

        MintMark memory m = ICollectionView(collection).mintMarkOf(tokenId);
        if (blockNumber < m.mintBlock) revert FrameUnavailable();

        l.locked = true;
        l.lockBlock = uint64(blockNumber);
        l.lockHash = bh;
        // Age-weighted lock: ~1 weight + 1 per day of token age (7200 blocks).
        effectiveLocks[collection] += 1 + (block.number - m.mintBlock) / 7200;
    }

    function frameOf(address collection, uint256 tokenId) external view returns (bool, bytes32) {
        Lock storage l = locks[collection][tokenId];
        return (l.locked, l.lockHash);
    }
}

/// @dev The price slot module: basefee x unit gas x (1 + effectiveLocks).
contract LockCurvePriceStrategy is IPriceStrategy {
    FrameLock public immutable frameLock;
    uint256 public constant UNIT_GAS = 60_000;

    constructor(FrameLock frameLock_) {
        frameLock = frameLock_;
    }

    function priceOf(address collection, address, uint256 quantity, bytes calldata)
        external
        view
        override
        returns (uint256)
    {
        return block.basefee * UNIT_GAS * (1 + frameLock.effectiveLocks(collection)) * quantity;
    }
}

/// @dev The renderer slot module: live per-block frames until locked.
contract FrameRenderer is IRenderer {
    using LibString for uint256;

    FrameLock public immutable frameLock;

    constructor(FrameLock frameLock_) {
        frameLock = frameLock_;
    }

    function tokenURI(address collection, uint256 tokenId)
        external
        view
        override
        returns (string memory)
    {
        (bool locked, bytes32 lockHash) = frameLock.frameOf(collection, tokenId);
        bytes32 frame = locked ? lockHash : blockhash(block.number - 1);
        bytes32 seed = ICollectionView(collection).tokenSeed(tokenId);
        return string(
            abi.encodePacked(
                "frame:", uint256(frame).toHexString(32), ":seed:", uint256(seed).toHexString(32)
            )
        );
    }

    function contractURI(address) external pure override returns (string memory) {
        return "mini-tbam";
    }
}

contract MiniTBAMTest is Test {
    SovereignCollection collection;
    FrameLock frameLock;
    LockCurvePriceStrategy strategy;
    FrameRenderer renderer;

    address artist = makeAddr("artist");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        SovereignCollection impl = new SovereignCollection();
        SovereignCollectionFactory factory =
            new SovereignCollectionFactory(address(impl), address(new MockRenderer()), address(0));

        frameLock = new FrameLock();
        strategy = new LockCurvePriceStrategy(frameLock);
        renderer = new FrameRenderer(frameLock);

        CollectionConfig memory cfg;
        cfg.supplyCap = 100;
        cfg.idMode = IdMode.Sequential;
        cfg.priceStrategy = address(strategy);
        cfg.renderer = address(renderer);
        WorkConfig memory work; // renderer-native: the renderer IS the work

        collection = SovereignCollection(
            factory.createCollection(
                "Mini TBAM", "MTBAM", artist, cfg, work, new address[](0), new address[](0)
            )
        );

        // Walk past genesis so blockhash(block.number - 1) exists, and give
        // every recent block a knowable hash.
        vm.roll(1000);
        _hashBlocks(900, 1000);
        vm.fee(10 gwei);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
    }

    function _hashBlocks(uint256 from, uint256 to) internal {
        for (uint256 b = from; b <= to; b++) {
            vm.setBlockhash(b, keccak256(abi.encode("frame", b)));
        }
    }

    /// @dev Roll forward and give the new blocks knowable hashes, mirroring
    ///      real chain progression after a mint.
    function _advanceBlocks(uint256 n) internal {
        uint256 from = block.number;
        vm.roll(from + n);
        _hashBlocks(from, from + n);
    }

    function _mint(address who) internal returns (uint256 id) {
        uint256 price = collection.currentPrice(who, 1, "");
        vm.prank(who);
        collection.mintWithRewards{value: price}(1, address(0), "");
        (,, uint256 minted) = collection.config();
        return minted; // sequential ids start at 1
    }

    // ── claim 2: the price slot expresses basefee x lock-state pricing ──────

    function test_priceTracksBasefee() public {
        vm.fee(10 gwei);
        uint256 p1 = collection.currentPrice(alice, 1, "");
        assertEq(p1, 10 gwei * 60_000);

        vm.fee(30 gwei);
        assertEq(collection.currentPrice(alice, 1, ""), 3 * p1);
    }

    function test_priceClimbsWithCollectiveLocks() public {
        uint256 t1 = _mint(alice);
        uint256 t2 = _mint(bob);
        _advanceBlocks(5); // frames can only be locked at/after the mint block
        uint256 before = collection.currentPrice(alice, 1, "");

        vm.prank(alice);
        frameLock.lockFrame(address(collection), t1, 0);
        uint256 afterOne = collection.currentPrice(alice, 1, "");
        assertEq(afterOne, 2 * before, "one lock doubles the linear curve");

        vm.prank(bob);
        frameLock.lockFrame(address(collection), t2, 0);
        assertEq(collection.currentPrice(alice, 1, ""), 3 * before);
    }

    function test_dynamicPricePullRefundsExcess() public {
        uint256 quote = collection.currentPrice(alice, 1, "");
        vm.prank(alice);
        collection.mintWithRewards{value: quote + 0.5 ether}(1, address(0), "");
        assertEq(collection.pendingWithdrawal(alice), 0.5 ether, "excess accrues as pull-refund");
    }

    // ── claims 1 + 3: companion locks, renderer serves flux vs frozen ────────

    function test_unlockedFrameRerollsPerBlock() public {
        uint256 t1 = _mint(alice);
        string memory frameA = collection.tokenURI(t1);

        vm.roll(block.number + 1);
        vm.setBlockhash(block.number - 1, keccak256("a new frame"));
        string memory frameB = collection.tokenURI(t1);

        assertTrue(
            keccak256(bytes(frameA)) != keccak256(bytes(frameB)),
            "unlocked token re-renders every block"
        );
    }

    function test_lockFreezesChosenFrame() public {
        uint256 t1 = _mint(alice);
        uint256 t2 = _mint(bob);
        _advanceBlocks(5);
        uint256 chosen = block.number - 3; // >= mint block after the advance

        vm.prank(alice);
        frameLock.lockFrame(address(collection), t1, chosen);
        string memory lockedFrame = collection.tokenURI(t1);
        string memory liveBefore = collection.tokenURI(t2);

        vm.roll(block.number + 10);
        _hashBlocks(block.number - 10, block.number);

        assertEq(collection.tokenURI(t1), lockedFrame, "locked frame is frozen forever");
        assertTrue(
            keccak256(bytes(collection.tokenURI(t2))) != keccak256(bytes(liveBefore)),
            "unlocked sibling keeps churning"
        );
    }

    function test_lockAuthAndRace() public {
        uint256 t1 = _mint(alice);
        _advanceBlocks(5);

        vm.prank(bob);
        vm.expectRevert(FrameLock.NotTokenOwner.selector);
        frameLock.lockFrame(address(collection), t1, 0);

        // The 256-block blockhash window is inherent and carries over.
        vm.roll(block.number + 300);
        vm.prank(alice);
        vm.expectRevert(FrameLock.FrameUnavailable.selector);
        frameLock.lockFrame(address(collection), t1, block.number - 299);
    }

    // ── claim 4: zero hooks, zero core knowledge ─────────────────────────────

    function test_coreNeverLearnedAnyOfThisExists() public view {
        assertEq(collection.mintHook(), address(0), "no hook needed");
        // The companion, strategy, and renderer are all reads/slots; the
        // core's only awareness is the two slot addresses the artist set.
        assertEq(collection.priceStrategy(), address(strategy));
        assertEq(collection.renderer(), address(renderer));
    }
}
