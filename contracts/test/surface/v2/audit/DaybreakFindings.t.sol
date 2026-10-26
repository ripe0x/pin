// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {IERC721Receiver} from "openzeppelin-contracts/contracts/token/ERC721/IERC721Receiver.sol";
import {
    ReentrancyGuardUpgradeable
} from "openzeppelin-contracts-upgradeable/contracts/utils/ReentrancyGuardUpgradeable.sol";

import {SurfaceV2Base} from "../SurfaceV2Base.sol";
import {Surface} from "../../../../src/surface/v2/Surface.sol";
import {FixedPriceSale} from "../../../../src/surface/v2/FixedPriceSale.sol";
import {CloneFactory} from "../../../../src/surface/v2/CloneFactory.sol";

/// @notice Regression tests for the 2026-10-26 Codex Daybreak audit of the
///         Surface v2 primitives (findings 1, 2 and 5, plus the receiver
///         reentrancy question).
contract DaybreakFindingsTest is SurfaceV2Base {
    Surface internal token;
    FixedPriceSale internal sale;
    address internal attacker = makeAddr("attacker");

    function setUp() public override {
        super.setUp();
        (token, sale) = _launch();
        vm.deal(attacker, 10 ether);
    }

    function _saleInit(address payout, uint256 price) internal view returns (bytes memory) {
        return
            abi.encodeCall(
                FixedPriceSale.initialize, (address(token), price, 0, 0, 0, 0, payout, address(0), address(0))
            );
    }

    // ─── Finding 1: a preauthorized sale address cannot be taken ───────────

    /// @dev The owner authorizes the address its own `create` will land at.
    ///      An attacker who creates first lands somewhere else, so the owner's
    ///      authorization never covers the attacker's sale.
    function test_finding1_createAddressIsCallerNamespaced() public {
        address ownersNext = saleFactory.predictCreate(artist);
        vm.prank(artist);
        token.setMinter(ownersNext);

        vm.prank(attacker);
        vm.expectRevert(FixedPriceSale.NotAuthorized.selector);
        saleFactory.create(_saleInit(attacker, 0));

        // The owner's address is unaffected by the attacker's attempt.
        assertEq(saleFactory.predictCreate(artist), ownersNext);
        vm.prank(artist);
        address created = saleFactory.create(_saleInit(artist, PRICE));
        assertEq(created, ownersNext);
        assertEq(FixedPriceSale(created).payoutRecipient(), artist);
    }

    function test_finding1_createNonceIsPerCaller() public {
        address first = saleFactory.predictCreate(artist);
        address attackersNext = saleFactory.predictCreate(attacker);
        vm.prank(attacker);
        address attackersToken = tokenFactory.create(
            abi.encodeCall(Surface.initialize, ("N", "S", attacker, address(renderer), 0, 0, attacker, attacker))
        );
        vm.prank(attacker);
        Surface(attackersToken).setMinter(attackersNext);
        vm.prank(attacker);
        address attackersSale = saleFactory.create(
            abi.encodeCall(
                FixedPriceSale.initialize,
                (attackersToken, PRICE, 0, 0, 0, 0, attacker, address(0), address(0))
            )
        );
        assertEq(attackersSale, attackersNext);
        assertEq(saleFactory.createNonce(attacker), 1);
        assertEq(saleFactory.createNonce(artist), 0);
        assertEq(saleFactory.predictCreate(artist), first, "another caller's create does not move it");
        assertTrue(saleFactory.predictCreate(attacker) != first);
    }

    function test_finding1_createAndDeterministicAddressesDifferForZeroSalt() public view {
        // The two entrypoints use different salt encodings for this input.
        bytes32 salt = bytes32(uint256(0));
        assertTrue(saleFactory.predict(salt, artist) != saleFactory.predictCreate(artist));
    }

    // ─── Finding 2: only the initializer is accepted ───────────────────────

    function test_finding2_nonInitializerCallRejected() public {
        vm.expectRevert(abi.encodeWithSelector(CloneFactory.NotInitializer.selector, bytes4(keccak256("version()"))));
        saleFactory.create(abi.encodeWithSignature("version()"));
        vm.expectRevert(abi.encodeWithSelector(CloneFactory.NotInitializer.selector, bytes4(0)));
        saleFactory.create("");
        vm.expectRevert(abi.encodeWithSelector(CloneFactory.NotInitializer.selector, bytes4(0)));
        saleFactory.create(hex"01");
    }

    function test_finding2_initSelectorPinned() public view {
        assertEq(tokenFactory.initSelector(), Surface.initialize.selector);
        assertEq(saleFactory.initSelector(), FixedPriceSale.initialize.selector);
    }

    function test_finding2_constructorRejectsZeroSelector() public {
        vm.expectRevert(abi.encodeWithSelector(CloneFactory.NotInitializer.selector, bytes4(0)));
        new CloneFactory(address(surfaceImpl), bytes4(0));
    }

    // ─── Finding 5: royaltyInfo at extreme sale prices ─────────────────────

    function test_finding5_royaltyInfoMaxSalePrice() public {
        vm.prank(artist);
        token.setRoyalty(5000, artist);
        (, uint256 amount) = token.royaltyInfo(1, type(uint256).max);
        assertEq(amount, type(uint256).max / 2);
    }

    // ─── Receiver callback reentrancy (audit question 1) ───────────────────

    function test_receiverCallbackCannotReenter() public {
        ReentrantReceiver r = new ReentrantReceiver(sale);
        vm.deal(address(r), 1 ether);
        vm.prank(collector);
        sale.mintWithReferral{value: PRICE}(address(r), 1, address(0), "");
        assertEq(token.balanceOf(address(r)), 1, "exactly one mint");
        assertTrue(r.mintBlocked(), "reentrant mint was refused");
        assertTrue(r.withdrawBlocked(), "reentrant withdraw was refused");
        assertEq(sale.totalMinted(), 1);
    }
}

/// @dev Tries to mint again and withdraw from inside the sale's receiver check.
contract ReentrantReceiver is IERC721Receiver {
    FixedPriceSale internal immutable sale;
    bool public mintBlocked;
    bool public withdrawBlocked;

    constructor(FixedPriceSale sale_) {
        sale = sale_;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        if (msg.sender == address(sale)) {
            uint256 price = sale.price();
            try sale.mint{value: price}(1) {}
            catch (bytes memory err) {
                mintBlocked = bytes4(err) == ReentrancyGuardUpgradeable.ReentrancyGuardReentrantCall.selector;
            }
            try sale.withdraw(address(this)) {}
            catch (bytes memory err) {
                withdrawBlocked = bytes4(err) == ReentrancyGuardUpgradeable.ReentrancyGuardReentrantCall.selector;
            }
        }
        return IERC721Receiver.onERC721Received.selector;
    }
}
