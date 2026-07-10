// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";

import {Collection} from "../../../src/collection/Collection.sol";
import {ICollection} from "../../../src/collection/interfaces/ICollection.sol";
import {CollectionFactory} from "../../../src/collection/CollectionFactory.sol";
import {
    CollectionConfig,
    CollectionStatus,
    IdMode
} from "../../../src/collection/CollectionTypes.sol";
import {MockRenderer} from "../mocks/CollectionMocks.sol";

// ─────────────────────────────────────────────────────────────────────────────
// Reference fixture: the Homage form (ERC20-backed, pooled-id, redeemable)
// driven end to end on the v1 core BEFORE the real BackedMinter exists.
// Encodes the design claims:
//   1. pooled id mode supports the full draw → mint-with-escrow → redeem →
//      burn → id-returns → re-mint-same-id cycle, with the re-minted id a
//      fresh instance (new seed, new mark, new escrow);
//   2. ALL economics (coin custody, escrow, redemption) live in the minter;
//      the core's involvement is exactly mintToId + approval-gated burn;
//   3. the pooled supply cap bounds LIVE supply, so redemption reopens room;
//   4. Mint Marks stay truthful on the extension path: a re-mint after the
//      sale window records statusAtMint == Closed.
// ─────────────────────────────────────────────────────────────────────────────

contract MockCoin is ERC20 {
    constructor() ERC20("Mock111", "M111") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev The whole Homage-shaped economy in one test-grade minter: an id pool
///      with a pseudo-random draw, per-token coin escrow, and burn-to-redeem.
contract BackedPoolMinter {
    Collection public immutable collection;
    MockCoin public immutable coin;
    uint256 public immutable escrowPerToken;

    uint256[] public pool;
    mapping(uint256 => uint256) public escrowOf;

    error PoolEmpty();
    error NotHolder();

    constructor(address collection_, MockCoin coin_, uint256 escrowPerToken_, uint256 poolSize_) {
        collection = Collection(collection_);
        coin = coin_;
        escrowPerToken = escrowPerToken_;
        for (uint256 i = 0; i < poolSize_; i++) {
            pool.push(i); // id 0 is a legal pooled id, deliberately included
        }
    }

    function poolSize() external view returns (uint256) {
        return pool.length;
    }

    function mint() external returns (uint256 tokenId) {
        if (pool.length == 0) revert PoolEmpty();
        uint256 at =
            uint256(keccak256(abi.encode(block.prevrandao, pool.length, msg.sender))) % pool.length;
        tokenId = pool[at];
        pool[at] = pool[pool.length - 1];
        pool.pop();

        coin.transferFrom(msg.sender, address(this), escrowPerToken);
        escrowOf[tokenId] = escrowPerToken;
        collection.mintToId(msg.sender, tokenId, address(0), "");
    }

    /// @dev Holder redeems: burn (via approval) + principal back + id to pool.
    function redeem(uint256 tokenId) external {
        if (collection.ownerOf(tokenId) != msg.sender) revert NotHolder();
        collection.burn(tokenId);
        uint256 amount = escrowOf[tokenId];
        escrowOf[tokenId] = 0;
        coin.transfer(msg.sender, amount);
        pool.push(tokenId);
    }
}

contract PooledBackedTest is Test {
    uint256 constant POOL_SIZE = 3;
    uint256 constant ESCROW = 50_000 ether;

    Collection collection;
    BackedPoolMinter minter;
    MockCoin coin;

    address artist = makeAddr("artist");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        Collection impl = new Collection();
        CollectionFactory factory =
            new CollectionFactory(address(impl), address(new MockRenderer()), address(0));
        coin = new MockCoin();

        CollectionConfig memory cfg;
        cfg.idMode = IdMode.Pooled;
        cfg.supplyCap = POOL_SIZE; // pooled cap bounds LIVE supply
        cfg.mintEnd = uint64(block.timestamp + 1 days);

        // Predict the minter address so the collection deploys fully wired
        // in one factory tx (initialMinters), the studio one-click property.
        // createCollection does not consume this contract's nonce (the clone
        // is CREATEd by the factory), so the minter is our very next deploy.
        uint256 nonce = vm.getNonce(address(this));
        address predictedMinter = vm.computeCreateAddress(address(this), nonce);
        address[] memory minters = new address[](1);
        minters[0] = predictedMinter;

        collection = Collection(
            factory.createCollection(
                "Pooled Backed", "PB", artist, cfg, minters, new address[](0)
            )
        );
        minter = new BackedPoolMinter(address(collection), coin, ESCROW, POOL_SIZE);
        assertEq(address(minter), predictedMinter, "wiring prediction held");

        for (uint256 i = 0; i < 2; i++) {
            address who = i == 0 ? alice : bob;
            coin.mint(who, 10 * ESCROW);
            vm.startPrank(who);
            coin.approve(address(minter), type(uint256).max);
            collection.setApprovalForAll(address(minter), true);
            vm.stopPrank();
        }
    }

    function _mintAs(address who) internal returns (uint256 id) {
        vm.prank(who);
        return minter.mint();
    }

    // ── claim 1: the full cycle, with re-mint as a fresh instance ───────────

    function test_fullCycle_drawEscrowRedeemRemint() public {
        // Drain the pool so the next draw is deterministic.
        uint256 a = _mintAs(alice);
        uint256 b = _mintAs(alice);
        uint256 c = _mintAs(bob);
        assertEq(minter.poolSize(), 0);
        assertEq(collection.totalSupply(), POOL_SIZE);

        bytes32 seedBefore = collection.tokenSeed(b);
        uint256 aliceCoinBefore = coin.balanceOf(alice);

        // Redeem: burn, principal back, id returns to the pool.
        vm.prank(alice);
        minter.redeem(b);
        assertEq(coin.balanceOf(alice), aliceCoinBefore + ESCROW, "principal returned in full");
        assertEq(collection.totalSupply(), POOL_SIZE - 1);
        assertEq(minter.poolSize(), 1);
        vm.expectRevert();
        collection.ownerOf(b); // burned

        // The seed of the dead instance stays readable (history).
        assertEq(collection.tokenSeed(b), seedBefore);

        // Re-mint: pool has exactly one id, so bob must draw `b` again.
        vm.roll(block.number + 5); // fresh prevrandao context
        vm.prevrandao(keccak256("new randomness"));
        uint256 again = _mintAs(bob);
        assertEq(again, b, "the returned id is re-issued");
        assertEq(collection.ownerOf(b), bob);

        // Fresh instance: new seed, new escrow. (The advancing mint order is
        // stamped in the Minted event; see _lastMintedStatus for decoding.)
        assertTrue(collection.tokenSeed(b) != seedBefore, "re-mint re-rolls entropy");
        assertEq(minter.escrowOf(b), ESCROW);

        // Silence unused-var lints for the ids we only minted for pool math.
        a;
        c;
    }

    // ── claim 2: vault accounting is entirely the minter's ──────────────────

    function test_vaultAccountingHolds() public {
        uint256 a = _mintAs(alice);
        _mintAs(bob);
        assertEq(coin.balanceOf(address(minter)), 2 * ESCROW, "escrow in == coin held");

        vm.prank(alice);
        minter.redeem(a);
        assertEq(coin.balanceOf(address(minter)), ESCROW, "escrow out on redeem");
        // The core never touched a single coin.
        assertEq(coin.balanceOf(address(collection)), 0);
    }

    // ── claim 3: pooled cap bounds live supply; redemption reopens room ─────

    function test_capBoundsLiveSupplyNotMintsEver() public {
        _mintAs(alice);
        _mintAs(alice);
        uint256 c = _mintAs(bob);
        assertEq(collection.totalSupply(), POOL_SIZE);

        vm.prank(bob);
        minter.redeem(c);
        // 4th mint EVER succeeds because live supply dropped below cap.
        uint256 again = _mintAs(alice);
        assertEq(again, c);
        (,, uint256 mintedEver) = collection.config();
        assertEq(mintedEver, 4, "mints-ever exceeds cap; live supply never does");
        assertEq(collection.totalSupply(), POOL_SIZE);
    }

    // ── claim 4: Minted events stay truthful after the window ────────────────

    /// @dev Lifecycle status is derived at mint time and stamped into the
    ///      Minted event (never stored per token): an in-window mint says Open;
    ///      a post-window pooled re-mint (a redeem cycle) truthfully says
    ///      Closed. Indexers read the event; nothing onchain re-reads it.
    function test_remintAfterWindowEmitsClosedStatus() public {
        vm.recordLogs();
        uint256 a = _mintAs(alice);
        assertEq(
            uint8(_lastMintedStatus()), uint8(CollectionStatus.Open), "in-window mint stamped Open"
        );

        vm.prank(alice);
        minter.redeem(a);

        vm.warp(block.timestamp + 2 days); // sale window over
        vm.recordLogs();
        uint256 again = _mintAs(bob);
        assertEq(again, a);
        assertEq(
            uint8(_lastMintedStatus()),
            uint8(CollectionStatus.Closed),
            "post-window re-mint stamped Closed, truthfully"
        );
    }

    /// @dev Decode statusAtMint from the most recent Minted event in the
    ///      recorded logs (the last non-indexed field in the event data).
    function _lastMintedStatus() internal returns (CollectionStatus status) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("Minted(address,address,uint256,uint256,uint256,uint8)");
        for (uint256 i = logs.length; i > 0; i--) {
            if (logs[i - 1].topics[0] == sig) {
                (,,, uint8 s) =
                    abi.decode(logs[i - 1].data, (uint256, uint256, uint256, uint8));
                return CollectionStatus(s);
            }
        }
        revert("no Minted event recorded");
    }

    // ── guardrail: the paid path is structurally closed in pooled mode ──────

    function test_paidPathBlockedInPooledMode() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(ICollection.PooledSellsViaMinter.selector);
        collection.mint{value: 0}(1);
    }
}
