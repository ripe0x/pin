// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC721} from "openzeppelin-contracts/contracts/token/ERC721/IERC721.sol";
import {LibString} from "solady/utils/LibString.sol";

import {PooledSurface} from "../../../src/surface/PooledSurface.sol";
import {Surface} from "../../../src/surface/Surface.sol";
import {SurfaceFactory} from "../../../src/surface/SurfaceFactory.sol";
import {IRenderer, ISurfaceView} from "../../../src/surface/interfaces/IRenderer.sol";
import {IPriceStrategy} from "../../../src/surface/interfaces/IPriceStrategy.sol";
import {IMintHook} from "../../../src/surface/interfaces/IMintHook.sol";
import {SurfaceConfig, IdMode} from "../../../src/surface/SurfaceTypes.sol";
import {MockRenderer} from "../mocks/SurfaceMocks.sol";

// ─────────────────────────────────────────────────────────────────────────────
// Reference fixture: a minimal To Be A Machine rebuilt on the collection
// system. Encodes the design claims from docs/pnd-surface-system.md:
//   1. holder-participation mechanics (lock-a-frame) live in a companion
//      contract with ZERO core support — the companion authorizes against
//      plain ownerOf;
//   2. the price strategy slot expresses dynamic pricing as a pure view of
//      basefee x collective lock state (TBAM's curve shape, linear weight
//      here — the exponent is arithmetic, not architecture);
//   3. per-block liveness and lock-to-freeze are renderer concerns: an
//      onchain view serves flux for unlocked tokens and the frozen frame
//      for locked ones;
//   4. mint-time provenance the WORK needs is the work's own concern: the
//      core stores only the seed, so a work whose mechanics depend on the
//      mint block records it itself with a one-line hook (MintClock below).
//      This is the bring-your-own-provenance pattern: the cost lands only on
//      works that opt in, not on every mint of every collection.
// ─────────────────────────────────────────────────────────────────────────────

/// @dev The recording hook: stamps each token's mint block to the work's own
///      storage. msg.sender is the collection (hooks are called by the core
///      on every mint path), so one MintClock instance serves any number of
///      collections. Wired at init, so every token ever minted is recorded.
contract MintClock is IMintHook {
    mapping(address => mapping(uint256 => uint64)) public mintBlockOf;

    function beforeMint(address, uint256, uint256, address, bytes calldata) external pure override returns (bytes4) {
        return IMintHook.beforeMint.selector;
    }

    function afterMint(address, uint256 quantity, uint256 firstTokenId, address, bytes calldata) external override {
        for (uint256 k = 0; k < quantity; k++) {
            mintBlockOf[msg.sender][firstTokenId + k] = uint64(block.number);
        }
    }
}

/// @dev The companion: lock a recent block's frame for a token you own.
contract FrameLock {
    struct Lock {
        bool locked;
        uint64 lockBlock;
        bytes32 lockHash;
    }

    MintClock public immutable mintClock;

    mapping(address => mapping(uint256 => Lock)) public locks;
    mapping(address => uint256) public effectiveLocks; // age-weighted, per collection

    error NotTokenOwner();
    error AlreadyLocked();
    error FrameUnavailable();

    constructor(MintClock mintClock_) {
        mintClock = mintClock_;
    }

    function lockFrame(address collection, uint256 tokenId, uint256 blockNumber) external {
        if (IERC721(collection).ownerOf(tokenId) != msg.sender) revert NotTokenOwner();
        Lock storage l = locks[collection][tokenId];
        if (l.locked) revert AlreadyLocked();

        if (blockNumber == 0) blockNumber = block.number - 1;
        bytes32 bh = blockhash(blockNumber);
        if (bh == bytes32(0)) revert FrameUnavailable(); // > 256 blocks old, or future

        // Mint-time provenance from the work's own hook, not the core.
        uint64 mintBlock = mintClock.mintBlockOf(collection, tokenId);
        if (mintBlock == 0 || blockNumber < mintBlock) revert FrameUnavailable();

        l.locked = true;
        l.lockBlock = uint64(blockNumber);
        l.lockHash = bh;
        // Age-weighted lock: ~1 weight + 1 per day of token age (7200 blocks).
        effectiveLocks[collection] += 1 + (block.number - mintBlock) / 7200;
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

    function tokenURI(address collection, uint256 tokenId) external view override returns (string memory) {
        (bool locked, bytes32 lockHash) = frameLock.frameOf(collection, tokenId);
        bytes32 frame = locked ? lockHash : blockhash(block.number - 1);
        bytes32 seed = ISurfaceView(collection).tokenSeed(tokenId);
        return
            string(abi.encodePacked("frame:", uint256(frame).toHexString(32), ":seed:", uint256(seed).toHexString(32)));
    }

    function contractURI(address) external pure override returns (string memory) {
        return "mini-tbam";
    }
}

contract MiniTBAMTest is Test {
    Surface collection;
    MintClock mintClock;
    FrameLock frameLock;
    LockCurvePriceStrategy strategy;
    FrameRenderer renderer;

    address artist = makeAddr("artist");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        Surface impl = new Surface();
        SurfaceFactory factory = new SurfaceFactory(
            address(impl), address(new PooledSurface()), address(new MockRenderer()), address(0)
        );

        mintClock = new MintClock();
        frameLock = new FrameLock(mintClock);
        strategy = new LockCurvePriceStrategy(frameLock);
        renderer = new FrameRenderer(frameLock);

        SurfaceConfig memory cfg;
        cfg.supplyCap = 100;
        cfg.priceStrategy = address(strategy);
        cfg.renderer = address(renderer);
        cfg.mintHook = address(mintClock); // bring-your-own mint-time provenance

        collection =
            Surface(factory.createSurface("Mini TBAM", "MTBAM", artist, cfg, new address[](0), new address[](0)));

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
        collection.mintWithReferral{value: price}(1, address(0), "");
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
        collection.mintWithReferral{value: quote + 0.5 ether}(1, address(0), "");
        assertEq(collection.pendingWithdrawal(alice), 0.5 ether, "excess accrues as pull-refund");
    }

    // ── claims 1 + 3: companion locks, renderer serves flux vs frozen ────────

    function test_unlockedFrameRerollsPerBlock() public {
        uint256 t1 = _mint(alice);
        string memory frameA = collection.tokenURI(t1);

        vm.roll(block.number + 1);
        vm.setBlockhash(block.number - 1, keccak256("a new frame"));
        string memory frameB = collection.tokenURI(t1);

        assertTrue(keccak256(bytes(frameA)) != keccak256(bytes(frameB)), "unlocked token re-renders every block");
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
            keccak256(bytes(collection.tokenURI(t2))) != keccak256(bytes(liveBefore)), "unlocked sibling keeps churning"
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

    // ── claim 4: the work records its own mint-time provenance ──────────────

    function test_workRecordsItsOwnMintProvenance() public {
        uint256 t1 = _mint(alice);
        assertEq(
            mintClock.mintBlockOf(address(collection), t1),
            uint64(block.number),
            "the hook stamped the mint block to the work's own storage"
        );
        // The core stored only the seed; every other slot the work uses is
        // the artist's own choice, visible as the three slot addresses.
        assertEq(collection.mintHook(), address(mintClock));
        assertEq(collection.priceStrategy(), address(strategy));
        assertEq(collection.renderer(), address(renderer));
    }
}
