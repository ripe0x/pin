// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";

import {SurfaceV2} from "../../../../src/surface/v2/SurfaceV2.sol";
import {FixedPriceMinterV2} from "../../../../src/surface/v2/minters/FixedPriceMinterV2.sol";

/// @title FixedPriceMinterV2Handler
/// @notice Bounded random-walk handler driving ONE FixedPriceMinterV2 clone
///         through mint, withdraw, and its own config setters, maintaining
///         ghost-truth state the invariant test asserts against. Ported from
///         v1's FixedPriceMinterHandler with the priceStrategy branch
///         dropped (v2 is exact-payment fixed price only) and
///         setReferralShareBps added as a fuzzed config-mutation action, so
///         the referral-cap invariant is exercised under a moving share.
contract FixedPriceMinterV2Handler is StdInvariant, Test {
    SurfaceV2 public immutable collection;
    FixedPriceMinterV2 public immutable minter;
    address public immutable artistPayout;

    uint256 public immutable price;
    uint256 public immutable maxMints;

    uint16 internal constant BPS = 10_000;

    uint256 public constant NUM_ACTORS = 6;

    // Ghost truth
    uint256 public ghostTotalPaidIn;
    uint256 public ghostTotalWithdrawn;
    uint256 public ghostTotalReferralPaid;
    mapping(address => uint256) public ghostPending;
    mapping(address => uint256) public ghostAccruedEver;
    mapping(address => uint256) public ghostWithdrawnEver;
    address[] public ghostPayeesEver;
    mapping(address => bool) public ghostIsKnownPayee;
    uint256 public ghostMints;

    // Call counters
    uint256 public callsMint;
    uint256 public callsWithdraw;
    uint256 public callsConfigChange;

    /// @dev setMaxMints has no floor against the current totalMinted: lowering
    ///      it below what is already minted only blocks FUTURE mints, it does
    ///      not undo the past. Once this has happened, "totalMinted <= live
    ///      maxMints" is no longer a standing invariant, so the invariant
    ///      test skips that specific check for the rest of the run once this
    ///      flag trips.
    bool public ghostMaxMintsEverLoweredBelowMinted;

    constructor(
        SurfaceV2 collection_,
        FixedPriceMinterV2 minter_,
        address artistPayout_,
        uint256 price_,
        uint256 maxMints_
    ) {
        collection = collection_;
        minter = minter_;
        artistPayout = artistPayout_;
        price = price_;
        maxMints = maxMints_;
    }

    function _actor(uint256 seed) internal pure returns (address payable) {
        uint256 idx = seed % NUM_ACTORS;
        return payable(address(uint160(uint256(keccak256(abi.encode("minter-v2-invariant-actor", idx))))));
    }

    function _referrer(uint256 seed) internal pure returns (address) {
        uint256 idx = seed % (NUM_ACTORS + 1);
        if (idx == NUM_ACTORS) return address(0);
        return address(uint160(uint256(keccak256(abi.encode("minter-v2-invariant-referrer", idx)))));
    }

    function _trackPayee(address payee) internal {
        if (!ghostIsKnownPayee[payee]) {
            ghostIsKnownPayee[payee] = true;
            ghostPayeesEver.push(payee);
        }
    }

    function ghostPayeeCount() external view returns (uint256) {
        return ghostPayeesEver.length;
    }

    function _mirrorSettle(uint256 total, address referrer) internal {
        if (total == 0) return;
        ghostTotalPaidIn += total;
        uint256 referralCut = referrer == address(0) ? 0 : (total * minter.referralShareBps()) / BPS;
        if (referralCut > 0) {
            ghostPending[referrer] += referralCut;
            ghostAccruedEver[referrer] += referralCut;
            ghostTotalReferralPaid += referralCut;
            _trackPayee(referrer);
        }
        uint256 artistCut = total - referralCut;
        if (artistCut > 0) {
            ghostPending[artistPayout] += artistCut;
            ghostAccruedEver[artistPayout] += artistCut;
            _trackPayee(artistPayout);
        }
    }

    /// @dev Reads the LIVE config (price, window, maxMints, walletCap)
    ///      before minting, since any of it may have been mutated by a
    ///      config-change action since the last mint. Quantity and the
    ///      recipient are shrunk/skipped to stay within whatever the current
    ///      config allows, so a successful call always pays exactly the
    ///      currently required amount and never spuriously reverts on config
    ///      the handler itself just changed.
    function mint(uint256 actorSeed, uint256 referrerSeed, uint256 qtySeed) external {
        address payable buyer = _actor(actorSeed);
        address referrer = _referrer(referrerSeed);
        uint256 quantity = bound(qtySeed, 1, 4);

        uint64 start = minter.mintStart();
        uint64 end = minter.mintEnd();
        if (start != 0 && block.timestamp < start) return;
        if (end != 0 && block.timestamp >= end) return;

        uint256 currentMax = minter.maxMints();
        uint256 mintedSoFar = minter.totalMinted();
        if (currentMax != 0) {
            if (mintedSoFar >= currentMax) return;
            if (mintedSoFar + quantity > currentMax) {
                quantity = currentMax - mintedSoFar;
            }
        }
        if (quantity == 0) return;

        uint256 cap = minter.walletCap();
        uint256 mintedByBuyer = minter.mintedBy(buyer);
        if (cap != 0) {
            if (mintedByBuyer >= cap) return;
            if (mintedByBuyer + quantity > cap) {
                quantity = cap - mintedByBuyer;
            }
        }
        if (quantity == 0) return;

        uint256 required = minter.price() * quantity;

        vm.deal(buyer, required);
        vm.prank(buyer);
        try minter.mint{value: required}(buyer, quantity, referrer, "") {
            callsMint++;
            ghostMints += quantity;
            _mirrorSettle(required, referrer);
        } catch {
            revert("handler: authorized mint unexpectedly reverted");
        }
    }

    function withdraw(uint256 payeeSeed) external {
        if (ghostPayeesEver.length == 0) return;
        address payee = ghostPayeesEver[payeeSeed % ghostPayeesEver.length];
        uint256 owed = minter.pendingWithdrawal(payee);
        if (owed == 0) return;
        minter.withdraw(payee); // permissionless trigger
        callsWithdraw++;
        ghostPending[payee] -= owed;
        ghostWithdrawnEver[payee] += owed;
        ghostTotalWithdrawn += owed;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Config-mutation actions: the sale config changes mid-run, exactly as an
    // artist/admin may adjust it between mints. mint() above always reads
    // the live config, so these never desync the ghost accounting; they only
    // change which mints later succeed or get skipped.
    // ─────────────────────────────────────────────────────────────────────────

    function setPrice(uint256 newPriceSeed) external {
        uint256 newPrice = bound(newPriceSeed, 0, 1 ether);
        vm.prank(artistPayout);
        minter.setPrice(newPrice);
        callsConfigChange++;
    }

    /// @dev Cycles the window between wide-open, not-yet-started, and
    ///      already-ended, so mint() above exercises both gate branches
    ///      under a moving config. The already-ended branch is only taken
    ///      when block.timestamp >= 2 (this handler never warps time, so
    ///      block.timestamp is whatever the caller's fork/genesis started
    ///      at; the guard avoids an underflow on a degenerate timestamp).
    function setMintWindow(uint256 modeSeed, uint256 offsetSeed) external {
        uint256 mode = modeSeed % 3;
        uint64 start;
        uint64 end;
        if (mode == 1) {
            start = uint64(block.timestamp + 1 + bound(offsetSeed, 0, 30 days));
            end = 0;
        } else if (mode == 2 && block.timestamp >= 2) {
            end = uint64(bound(offsetSeed, 1, block.timestamp));
            start = end - 1;
        } else {
            start = 0;
            end = 0;
        }
        vm.prank(artistPayout);
        minter.setMintWindow(start, end);
        callsConfigChange++;
    }

    function setWalletCap(uint256 capSeed) external {
        uint256 cap = bound(capSeed, 0, 20);
        vm.prank(artistPayout);
        minter.setWalletCap(cap);
        callsConfigChange++;
    }

    function setMaxMints(uint256 maxSeed) external {
        uint256 ceiling = maxMints == 0 ? 200 : maxMints * 2;
        uint256 newMax = bound(maxSeed, 0, ceiling);
        if (newMax != 0 && newMax < minter.totalMinted()) {
            ghostMaxMintsEverLoweredBelowMinted = true;
        }
        vm.prank(artistPayout);
        minter.setMaxMints(newMax);
        callsConfigChange++;
    }

    /// @dev Bounded at the contract's own MAX_REFERRAL_SHARE_BPS so this
    ///      action never spuriously reverts; the cap itself is asserted by
    ///      the invariant test, not enforced here.
    function setReferralShareBps(uint256 bpsSeed) external {
        uint16 cap = minter.MAX_REFERRAL_SHARE_BPS();
        uint16 bps = uint16(bound(bpsSeed, 0, cap));
        vm.prank(artistPayout);
        minter.setReferralShareBps(bps);
        callsConfigChange++;
    }
}
