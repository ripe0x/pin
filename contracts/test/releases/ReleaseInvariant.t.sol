// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {Release} from "../../src/releases/Release.sol";
import {ReleaseFactory} from "../../src/releases/ReleaseFactory.sol";
import {GateMode, ReleaseParams} from "../../src/releases/IRelease.sol";

/// @notice Drives a priced, capped release with random mints, withdrawals,
///         fee claims, closes, and clock moves, while ghost-tracking every
///         wei that left the contract.
contract ReleaseHandler is Test {
    Release public immutable release;
    uint256 public immutable price;
    uint256 public immutable fee;

    address[] public minters;
    address[] public surfaces; // [0] is address(0) = unserved

    // Ghosts.
    uint256 public ghostWithdrawn; // total ever sent to payout
    uint256 public ghostFeesClaimed; // total ever sent to surfaces
    uint256 public ghostSurfacedQty; // tokens minted with a surface named

    constructor(Release release_) {
        release = release_;
        price = release_.price();
        fee = release_.surfaceFee();

        minters.push(makeAddr("m1"));
        minters.push(makeAddr("m2"));
        minters.push(makeAddr("m3"));
        surfaces.push(address(0));
        surfaces.push(makeAddr("s1"));
        surfaces.push(makeAddr("s2"));
    }

    function mint(uint256 actorSeed, uint256 qtySeed, uint256 surfaceSeed)
        external
    {
        if (release.closed()) return;
        uint256 quantity = bound(qtySeed, 1, 10);
        if (
            release.maxSupply() != 0 &&
            release.totalMinted() + quantity > release.maxSupply()
        ) return;
        address minter = minters[actorSeed % minters.length];
        address surface_ = surfaces[surfaceSeed % surfaces.length];

        uint256 cost = price * quantity +
            (surface_ == address(0) ? 0 : fee * quantity);
        vm.deal(minter, cost);
        vm.prank(minter);
        release.mint{value: cost}(minter, quantity, surface_);
        if (surface_ != address(0)) ghostSurfacedQty += quantity;
    }

    function withdraw() external {
        uint256 amount = release.artistBalance();
        if (amount == 0) return;
        release.withdraw();
        ghostWithdrawn += amount;
    }

    function claimFees(uint256 surfaceSeed) external {
        address surface_ = surfaces[surfaceSeed % surfaces.length];
        uint256 amount = release.owed(surface_);
        if (amount == 0) return;
        release.claimSurfaceFees(surface_);
        ghostFeesClaimed += amount;
    }

    function close(uint256 seed) external {
        if (seed % 37 != 0 || release.closed()) return;
        vm.prank(release.owner());
        release.close();
    }

    function warp(uint256 seed) external {
        vm.warp(block.timestamp + bound(seed, 1, 6 hours));
    }

    function surfaceCount() external view returns (uint256) {
        return surfaces.length;
    }
}

contract ReleaseInvariantTest is Test {
    uint256 internal constant PRICE = 0.01 ether;
    uint256 internal constant FEE = 0.0005 ether;
    uint64 internal constant CAP = 2_000;

    Release internal release;
    ReleaseHandler internal handler;
    address internal artist = makeAddr("artist");

    function setUp() public {
        vm.warp(1_780_000_000);
        ReleaseFactory factory =
            new ReleaseFactory(makeAddr("pnd"), 0.002 ether, FEE);

        ReleaseParams memory p = ReleaseParams({
            name: "Invariant Release",
            symbol: "INV",
            price: PRICE,
            startTime: uint64(block.timestamp),
            endTime: 0, // open-ended so clock moves never starve the run
            maxSupply: CAP,
            gateToken: address(0),
            gateMode: GateMode.NONE,
            payout: address(0),
            royaltyReceiver: address(0),
            royaltyBps: 500,
            uri: "ipfs://meta.json",
            uriPerToken: false,
            renderer: address(0),
            contractURI: ""
        });
        vm.prank(artist);
        release = Release(factory.createRelease(p));

        handler = new ReleaseHandler(release);
        targetContract(address(handler));
    }

    /// @notice Every wei in the contract is spoken for: the artist's
    ///         accrual plus the sum owed to surfaces, exactly.
    function invariant_balanceFullyAccounted() public view {
        uint256 owedSum;
        for (uint256 i = 0; i < handler.surfaceCount(); i++) {
            owedSum += release.owed(handler.surfaces(i));
        }
        assertEq(
            address(release).balance,
            release.artistBalance() + owedSum,
            "balance != artist + owed"
        );
    }

    /// @notice The artist gets everything they priced: accrued + already
    ///         withdrawn == price * everything ever minted.
    function invariant_artistGetsEverythingPriced() public view {
        assertEq(
            release.artistBalance() + handler.ghostWithdrawn(),
            PRICE * release.totalMinted(),
            "artist leg drifted"
        );
    }

    /// @notice The surface leg is exactly fee * surfaced mints — never a
    ///         wei from the artist's side, never a wei more.
    function invariant_surfaceLegExact() public view {
        uint256 owedSum;
        for (uint256 i = 0; i < handler.surfaceCount(); i++) {
            owedSum += release.owed(handler.surfaces(i));
        }
        assertEq(
            owedSum + handler.ghostFeesClaimed(),
            FEE * handler.ghostSurfacedQty(),
            "surface leg drifted"
        );
    }

    /// @notice Supply never passes the cap, and the unserved pseudo-surface
    ///         address(0) is never owed anything.
    function invariant_capAndZeroSurface() public view {
        assertLe(release.totalMinted(), CAP, "cap exceeded");
        assertEq(release.owed(address(0)), 0, "address(0) accrued fees");
    }
}
