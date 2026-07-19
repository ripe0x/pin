// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";

import {Surface} from "../../../../src/surface/Surface.sol";
import {FixedPriceMinter} from "../../../../src/surface/minters/FixedPriceMinter.sol";

/// @title FixedPriceMinterHandler
/// @notice Bounded random-walk handler driving ONE FixedPriceMinter clone
///         through mint and withdraw, maintaining ghost-truth state the
///         invariant test asserts against. Ported approach from the deleted
///         fat-token SurfaceHandler's funds-accounting section (git
///         251d6a2 contracts/test/surface/invariants/SurfaceHandler.sol);
///         allowlist/wallet-cap/window correctness are covered by
///         FixedPriceMinter.t.sol's unit tests, so this handler focuses on
///         what only a long random walk finds: value conservation and
///         pull-payment accounting across many interleaved mints and
///         withdrawals.
contract FixedPriceMinterHandler is StdInvariant, Test {
    Surface public immutable collection;
    FixedPriceMinter public immutable minter;
    address public immutable artistPayout;

    uint256 public immutable price;
    uint256 public immutable maxMints;

    uint16 internal constant BPS = 10_000;

    uint256 public constant NUM_ACTORS = 6;

    // Ghost truth
    uint256 public ghostTotalPaidIn;
    uint256 public ghostTotalWithdrawn;
    mapping(address => uint256) public ghostPending;
    address[] public ghostPayeesEver;
    mapping(address => bool) public ghostIsKnownPayee;
    uint256 public ghostMints;

    // Call counters
    uint256 public callsMint;
    uint256 public callsWithdraw;

    constructor(Surface collection_, FixedPriceMinter minter_, address artistPayout_, uint256 price_, uint256 maxMints_) {
        collection = collection_;
        minter = minter_;
        artistPayout = artistPayout_;
        price = price_;
        maxMints = maxMints_;
    }

    function _actor(uint256 seed) internal pure returns (address payable) {
        uint256 idx = seed % NUM_ACTORS;
        return payable(address(uint160(uint256(keccak256(abi.encode("minter-invariant-actor", idx))))));
    }

    function _referrer(uint256 seed) internal pure returns (address) {
        uint256 idx = seed % (NUM_ACTORS + 1);
        if (idx == NUM_ACTORS) return address(0);
        return address(uint160(uint256(keccak256(abi.encode("minter-invariant-referrer", idx)))));
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
        uint256 referralCut = referrer == address(0) ? 0 : (total * minter.REFERRAL_SHARE_BPS()) / BPS;
        if (referralCut > 0) {
            ghostPending[referrer] += referralCut;
            _trackPayee(referrer);
        }
        uint256 artistCut = total - referralCut;
        if (artistCut > 0) {
            ghostPending[artistPayout] += artistCut;
            _trackPayee(artistPayout);
        }
    }

    /// @dev Always pays exactly price * quantity (fixed-price branch): the
    ///      wrong-payment reverts are covered by unit tests, this handler
    ///      focuses on funds conservation across successful mints.
    function mint(uint256 actorSeed, uint256 referrerSeed, uint256 qtySeed) external {
        address payable buyer = _actor(actorSeed);
        address referrer = _referrer(referrerSeed);
        uint256 quantity = bound(qtySeed, 1, 4);

        if (maxMints != 0 && ghostMints >= maxMints) return;
        if (maxMints != 0 && ghostMints + quantity > maxMints) {
            quantity = maxMints - ghostMints;
        }
        if (quantity == 0) return;

        uint256 value = price * quantity;
        vm.deal(buyer, value);
        vm.prank(buyer);
        try minter.mint{value: value}(buyer, quantity, referrer, "") {
            callsMint++;
            ghostMints += quantity;
            // Excess is always 0 on the fixed-price exact-match branch, so
            // the payer accrues nothing beyond the settle split.
            _mirrorSettle(value, referrer);
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
        ghostTotalWithdrawn += owed;
    }
}
