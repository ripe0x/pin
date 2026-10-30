// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {Clones} from "openzeppelin-contracts/contracts/proxy/Clones.sol";
import {Initializable} from "openzeppelin-contracts-upgradeable/contracts/proxy/utils/Initializable.sol";

import {SurfaceV2Base, MockGate, GoodReceiver, WrongReceiver, NoReceiver, RejectETH} from "./SurfaceV2Base.sol";
import {Surface} from "../../../src/surface/v2/Surface.sol";
import {FixedPriceSale} from "../../../src/surface/v2/FixedPriceSale.sol";
import {Launcher} from "../../../src/surface/v2/Launcher.sol";
import {IMinter} from "../../../src/surface/v2/interfaces/IMinter.sol";
import {ISurface} from "../../../src/surface/v2/interfaces/ISurface.sol";

contract FixedPriceSaleTest is SurfaceV2Base {
    Surface internal token;
    FixedPriceSale internal sale;

    function setUp() public override {
        super.setUp();
        (token, sale) = _launch();
    }

    /// @dev A sale clone made outside the factory, so the initialize caller
    ///      is whoever the test pranks.
    function _rawSale() internal returns (FixedPriceSale) {
        return FixedPriceSale(payable(Clones.clone(address(saleImpl))));
    }

    function _initRaw(FixedPriceSale s, address collection_) internal {
        s.initialize(collection_, PRICE, 0, 0, 0, 0, artist, address(0), address(0));
    }

    // ─── initialize: authority ──────────────────────────────────────────────

    function test_init_launcherPath_tokenAlreadyNamesSale() public view {
        assertEq(token.minter(), address(sale));
        assertEq(sale.collection(), address(token));
        assertEq(sale.payoutRecipient(), artist);
        assertEq(sale.defaultReferrer(), pnd);
    }

    function test_init_ownerPath() public {
        FixedPriceSale s = _rawSale();
        vm.prank(artist);
        _initRaw(s, address(token));
        assertEq(s.collection(), address(token));
        // The owner then points the token at it.
        vm.prank(artist);
        token.setMinter(address(s));
        _mint(s, collector, 1);
        assertEq(token.ownerOf(1), collector);
    }

    function test_init_rejectsWhenNeitherHolds() public {
        FixedPriceSale s = _rawSale();
        vm.prank(stranger);
        vm.expectRevert(FixedPriceSale.NotAuthorized.selector);
        _initRaw(s, address(token));
    }

    function test_init_viaFactory_requiresMinterGrantFirst() public {
        // Through the factory the initialize caller is the factory, so only
        // the "token already names me" path applies.
        bytes memory init = abi.encodeCall(
            FixedPriceSale.initialize, (address(token), PRICE, 0, 0, 0, 0, artist, address(0), address(0))
        );
        vm.prank(artist);
        vm.expectRevert(FixedPriceSale.NotAuthorized.selector);
        saleFactory.create(init);

        bytes32 salt = keccak256("second sale");
        address predicted = saleFactory.predict(salt, artist);
        vm.startPrank(artist);
        token.setMinter(predicted);
        address created = saleFactory.createDeterministic(salt, init);
        vm.stopPrank();
        assertEq(created, predicted);
    }

    function test_init_noOwnerIsZeroWindow() public {
        // A renounced collection with a different minter accepts no sale.
        vm.prank(artist);
        token.renounceOwnership();
        FixedPriceSale s = _rawSale();
        vm.expectRevert(FixedPriceSale.NotAuthorized.selector);
        _initRaw(s, address(token));
    }

    function test_init_emitsEveryConfigEvent() public {
        FixedPriceSale s = _rawSale();
        MockGate g = new MockGate();
        vm.expectEmit(address(s));
        emit FixedPriceSale.PriceSet(PRICE);
        vm.expectEmit(address(s));
        emit FixedPriceSale.MintWindowSet(10, 20);
        vm.expectEmit(address(s));
        emit FixedPriceSale.MaxMintsSet(7);
        vm.expectEmit(address(s));
        emit FixedPriceSale.WalletCapSet(3);
        vm.expectEmit(address(s));
        emit FixedPriceSale.PayoutRecipientSet(stranger);
        vm.expectEmit(address(s));
        emit FixedPriceSale.GateSet(address(g));
        vm.prank(artist);
        s.initialize(address(token), PRICE, 10, 20, 7, 3, stranger, address(g), pnd);
    }

    function test_init_validation() public {
        FixedPriceSale s = _rawSale();
        vm.startPrank(artist);
        vm.expectRevert(FixedPriceSale.CollectionRequired.selector);
        s.initialize(address(0), PRICE, 0, 0, 0, 0, artist, address(0), address(0));
        vm.expectRevert(abi.encodeWithSelector(FixedPriceSale.NotAContract.selector, stranger));
        s.initialize(stranger, PRICE, 0, 0, 0, 0, artist, address(0), address(0));
        vm.expectRevert(FixedPriceSale.PayoutRecipientRequired.selector);
        s.initialize(address(token), PRICE, 0, 0, 0, 0, address(0), address(0), address(0));
        vm.expectRevert(FixedPriceSale.BadMintWindow.selector);
        s.initialize(address(token), PRICE, 100, 100, 0, 0, artist, address(0), address(0));
        vm.expectRevert(FixedPriceSale.BadMintWindow.selector);
        s.initialize(address(token), PRICE, 100, 50, 0, 0, artist, address(0), address(0));
        vm.expectRevert(abi.encodeWithSelector(FixedPriceSale.NotAContract.selector, stranger));
        s.initialize(address(token), PRICE, 0, 0, 0, 0, artist, stranger, address(0));
        // A start with an open end is fine.
        s.initialize(address(token), PRICE, 100, 0, 0, 0, artist, address(0), address(0));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        _initRaw(s, address(token));
        vm.stopPrank();
    }

    function test_implementation_cannotBeInitialized() public {
        vm.prank(artist);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        saleImpl.initialize(address(token), PRICE, 0, 0, 0, 0, artist, address(0), address(0));
    }

    // ─── the ten checks, in order ───────────────────────────────────────────

    /// @dev Sets up a sale where checks 2..8 all fail at once, then clears
    ///      them one at a time; each revert must be the earliest failing
    ///      check. `simple` drives mint(quantity), else mintWithReferral.
    function _checkOrder(bool simple) internal {
        Surface t = _token(artist); // minter is not the sale: step 8 fails
        FixedPriceSale s = _rawSale();
        vm.prank(artist);
        s.initialize(
            address(t),
            PRICE,
            uint64(block.timestamp + 100),
            uint64(block.timestamp + 200),
            1,
            1,
            artist,
            address(0),
            pnd
        );
        MockGate g = new MockGate();
        g.setAnswer(false);
        vm.prank(artist);
        s.setGate(address(g));

        address payer = address(new NoReceiver()); // fails step 7
        vm.deal(payer, 10 ether);
        uint256 qty = 2; // over maxMints (3) and walletCap (5)
        uint256 wrongValue = PRICE; // step 6

        _expectMint(s, simple, payer, qty, wrongValue, abi.encodeWithSelector(IMinter.MintNotStarted.selector));
        vm.warp(block.timestamp + 300);
        _expectMint(s, simple, payer, qty, wrongValue, abi.encodeWithSelector(IMinter.MintEnded.selector));
        vm.prank(artist);
        s.setMintWindow(0, 0);
        _expectMint(s, simple, payer, qty, wrongValue, abi.encodeWithSelector(IMinter.MaxMintsExceeded.selector, 1, 2));
        vm.prank(artist);
        s.setMaxMints(0);
        _expectMint(s, simple, payer, qty, wrongValue, abi.encodeWithSelector(IMinter.GateRejected.selector));
        g.setAnswer(true);
        _expectMint(s, simple, payer, qty, wrongValue, abi.encodeWithSelector(IMinter.WalletCapExceeded.selector, 1, 2));
        vm.prank(artist);
        s.setWalletCap(0);
        _expectMint(
            s, simple, payer, qty, wrongValue, abi.encodeWithSelector(IMinter.WrongPayment.selector, 2 * PRICE, PRICE)
        );
        _expectMint(s, simple, payer, qty, 2 * PRICE, abi.encodeWithSelector(IMinter.ReceiverRejected.selector, payer));
        vm.etch(payer, address(new GoodReceiver()).code);
        _expectMint(s, simple, payer, qty, 2 * PRICE, abi.encodeWithSelector(ISurface.NotMinter.selector));
        vm.prank(artist);
        t.setMinter(address(s));
        _doMint(s, simple, payer, qty, 2 * PRICE);
        assertEq(t.balanceOf(payer), 2);
        assertEq(s.totalMinted(), 2);
        assertEq(s.mintedBy(payer), 2);

        // Step 1 beats everything.
        vm.prank(artist);
        s.close();
        vm.prank(artist);
        s.setMintWindow(uint64(block.timestamp + 100), 0);
        _expectMint(s, simple, payer, qty, 0, abi.encodeWithSelector(IMinter.SaleClosed.selector));
    }

    function _doMint(FixedPriceSale s, bool simple, address payer, uint256 qty, uint256 value) internal {
        vm.prank(payer);
        if (simple) s.mint{value: value}(qty);
        else s.mintWithReferral{value: value}(payer, qty, address(0), "");
    }

    function _expectMint(FixedPriceSale s, bool simple, address payer, uint256 qty, uint256 value, bytes memory err)
        internal
    {
        vm.expectRevert(err);
        _doMint(s, simple, payer, qty, value);
    }

    function test_checkOrder_mint() public {
        _checkOrder(true);
    }

    function test_checkOrder_mintWithReferral() public {
        _checkOrder(false);
    }

    // ─── exact boundaries (mutation-testing survivors) ──────────────────────

    function test_window_opensExactlyAtStart() public {
        uint64 start = uint64(block.timestamp + 100);
        vm.prank(artist);
        sale.setMintWindow(start, start + 100);
        vm.warp(start - 1);
        vm.prank(collector);
        vm.expectRevert(IMinter.MintNotStarted.selector);
        sale.mint{value: PRICE}(1);
        vm.warp(start);
        _mint(sale, collector, 1);
        assertEq(token.ownerOf(1), collector);
    }

    function test_window_closesExactlyAtEnd() public {
        uint64 end = uint64(block.timestamp + 100);
        vm.prank(artist);
        sale.setMintWindow(0, end);
        vm.warp(end - 1);
        _mint(sale, collector, 1);
        vm.warp(end);
        vm.prank(collector);
        vm.expectRevert(IMinter.MintEnded.selector);
        sale.mint{value: PRICE}(1);
    }

    function test_maxMints_allowsExactlyTheCeiling() public {
        vm.prank(artist);
        sale.setMaxMints(3);
        _mint(sale, collector, 2);
        _mint(sale, collector, 1); // 3 of 3: exactly at the ceiling
        assertEq(sale.totalMinted(), 3);
        vm.prank(collector);
        vm.expectRevert(abi.encodeWithSelector(IMinter.MaxMintsExceeded.selector, 3, 4));
        sale.mint{value: PRICE}(1);
    }

    function test_walletCap_allowsExactlyTheCap() public {
        vm.prank(artist);
        sale.setWalletCap(2);
        _mint(sale, collector, 2);
        assertEq(sale.mintedBy(collector), 2);
    }

    function test_close_isOneWay() public {
        vm.startPrank(artist);
        sale.close();
        sale.close();
        vm.stopPrank();
        assertTrue(sale.closed(), "a second close does not reopen");
        vm.prank(collector);
        vm.expectRevert(IMinter.SaleClosed.selector);
        sale.mint{value: PRICE}(1);
    }

    function test_zeroQuantity_rejectedByCollection() public {
        vm.prank(collector);
        vm.expectRevert(ISurface.ZeroQuantity.selector);
        sale.mint(0);
    }

    function test_collectionCap_bubbles() public {
        vm.prank(artist);
        token.setSupplyCap(1);
        _mint(sale, collector, 1);
        vm.prank(collector);
        vm.expectRevert(abi.encodeWithSelector(ISurface.ExceedsCap.selector, 1, 2));
        sale.mint{value: PRICE}(1);
    }

    // ─── payment ────────────────────────────────────────────────────────────

    function test_exactPayment() public {
        vm.startPrank(collector);
        vm.expectRevert(abi.encodeWithSelector(IMinter.WrongPayment.selector, 3 * PRICE, 3 * PRICE + 1));
        sale.mint{value: 3 * PRICE + 1}(3);
        vm.expectRevert(abi.encodeWithSelector(IMinter.WrongPayment.selector, 3 * PRICE, 3 * PRICE - 1));
        sale.mint{value: 3 * PRICE - 1}(3);
        sale.mint{value: 3 * PRICE}(3);
        vm.stopPrank();
        assertEq(address(sale).balance, 3 * PRICE);
        assertEq(sale.priceOf(collector, 3), 3 * PRICE);
    }

    function test_freeSale() public {
        vm.prank(artist);
        sale.setPrice(0);
        vm.prank(collector);
        sale.mint(2);
        assertEq(token.balanceOf(collector), 2);
        assertEq(sale.pendingWithdrawal(pnd), 0);
        assertEq(sale.pendingWithdrawal(artist), 0);
    }

    // ─── wallet cap ─────────────────────────────────────────────────────────

    function test_walletCap_countsEveryMint() public {
        // Uncapped mints still count (the September audit finding).
        _mint(sale, collector, 3);
        assertEq(sale.mintedBy(collector), 3);
        vm.prank(artist);
        sale.setWalletCap(3);
        vm.prank(collector);
        vm.expectRevert(abi.encodeWithSelector(IMinter.WalletCapExceeded.selector, 3, 4));
        sale.mint{value: PRICE}(1);
        vm.prank(artist);
        sale.setWalletCap(4);
        _mint(sale, collector, 1);
        assertEq(sale.mintedBy(collector), 4);
    }

    function test_walletCap_countsRecipientNotPayer() public {
        vm.prank(artist);
        sale.setWalletCap(2);
        vm.prank(stranger);
        sale.mintWithReferral{value: 2 * PRICE}(collector, 2, address(0), "");
        assertEq(sale.mintedBy(collector), 2);
        assertEq(sale.mintedBy(stranger), 0);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IMinter.WalletCapExceeded.selector, 2, 3));
        sale.mintWithReferral{value: PRICE}(collector, 1, address(0), "");
        _mint(sale, stranger, 2);
    }

    // ─── gate ───────────────────────────────────────────────────────────────

    function test_gate_mockWiring() public {
        MockGate g = new MockGate();
        vm.prank(artist);
        sale.setGate(address(g));
        _mint(sale, collector, 1);
        g.setAnswer(false);
        vm.prank(collector);
        vm.expectRevert(IMinter.GateRejected.selector);
        sale.mint{value: PRICE}(1);
        vm.prank(artist);
        sale.setGate(address(0));
        _mint(sale, collector, 1);
    }

    function test_gate_receivesCallArguments() public {
        ExpectingGate g = new ExpectingGate(address(token), collector, 2, hex"beef");
        vm.prank(artist);
        sale.setGate(address(g));
        vm.startPrank(stranger);
        sale.mintWithReferral{value: 2 * PRICE}(collector, 2, address(0), hex"beef");
        vm.expectRevert(IMinter.GateRejected.selector);
        sale.mintWithReferral{value: PRICE}(collector, 1, address(0), hex"beef");
        vm.expectRevert(IMinter.GateRejected.selector);
        sale.mintWithReferral{value: 2 * PRICE}(stranger, 2, address(0), hex"beef");
        vm.expectRevert(IMinter.GateRejected.selector);
        sale.mintWithReferral{value: 2 * PRICE}(collector, 2, address(0), hex"bee0");
        vm.stopPrank();
    }

    function test_gate_allowlistPhaseThenPublic() public {
        bytes32 a = _leaf(collector);
        bytes32 b = _leaf(stranger);
        vm.startPrank(artist);
        allowlist.setRoot(address(token), _hashPair(a, b));
        sale.setGate(address(allowlist));
        vm.stopPrank();

        bytes32[] memory proof = new bytes32[](1);
        proof[0] = b;
        vm.prank(collector);
        sale.mintWithReferral{value: PRICE}(collector, 1, address(0), abi.encode(proof));

        // The simple path sends no proof, so a gated sale rejects it cleanly.
        vm.prank(collector);
        vm.expectRevert(IMinter.GateRejected.selector);
        sale.mint{value: PRICE}(1);

        address outsider = makeAddr("outsider");
        vm.deal(outsider, 1 ether);
        vm.prank(outsider);
        vm.expectRevert(IMinter.GateRejected.selector);
        sale.mintWithReferral{value: PRICE}(outsider, 1, address(0), abi.encode(proof));

        vm.prank(artist);
        sale.setGate(address(0));
        _mint(sale, outsider, 1);
    }

    // ─── receiver check ─────────────────────────────────────────────────────

    function test_receiver_check() public {
        address good = address(new GoodReceiver());
        address wrong = address(new WrongReceiver());
        address none = address(new NoReceiver());
        vm.startPrank(collector);
        sale.mintWithReferral{value: PRICE}(good, 1, address(0), "");
        vm.expectRevert(abi.encodeWithSelector(IMinter.ReceiverRejected.selector, wrong));
        sale.mintWithReferral{value: PRICE}(wrong, 1, address(0), "");
        vm.expectRevert(abi.encodeWithSelector(IMinter.ReceiverRejected.selector, none));
        sale.mintWithReferral{value: PRICE}(none, 1, address(0), "");
        sale.mintWithReferral{value: PRICE}(stranger, 1, address(0), ""); // EOA: no check
        vm.stopPrank();
        assertEq(token.ownerOf(1), good);
        assertEq(token.ownerOf(2), stranger);
    }

    function test_receiver_askedForEveryIdInABatch() public {
        PickyReceiver picky = new PickyReceiver(2);
        vm.prank(collector);
        vm.expectRevert(abi.encodeWithSelector(IMinter.ReceiverRejected.selector, address(picky)));
        sale.mintWithReferral{value: 2 * PRICE}(address(picky), 2, address(0), "");
        assertEq(token.totalSupply(), 0);

        // A receiver that takes every id is asked once per id, in order.
        PickyReceiver open_ = new PickyReceiver(0);
        vm.prank(collector);
        sale.mintWithReferral{value: 3 * PRICE}(address(open_), 3, address(0), "");
        assertEq(open_.seenCount(), 3);
        for (uint256 i = 0; i < 3; i++) {
            assertEq(open_.seen(i), i + 1);
            assertEq(token.ownerOf(i + 1), address(open_));
        }
    }

    // ─── close ──────────────────────────────────────────────────────────────

    function test_close() public {
        vm.prank(stranger);
        vm.expectRevert(FixedPriceSale.NotAuthorized.selector);
        sale.close();
        vm.expectEmit(address(sale));
        emit FixedPriceSale.Closed();
        vm.prank(artist);
        sale.close();
        assertTrue(sale.closed());
        vm.prank(collector);
        vm.expectRevert(IMinter.SaleClosed.selector);
        sale.mint{value: PRICE}(1);
    }

    // ─── referral math (fixed 5%) ───────────────────────────────────────────

    function _mintRef(address referrer, uint256 value) internal {
        if (sale.price() != value) {
            vm.prank(artist);
            sale.setPrice(value);
        }
        vm.prank(collector);
        sale.mintWithReferral{value: value}(collector, 1, referrer, "");
    }

    function test_referral_zero() public {
        _mintRef(address(0), 1 ether);
        assertEq(sale.pendingWithdrawal(artist), 1 ether);
    }

    function test_referral_self() public {
        _mintRef(collector, 1 ether);
        assertEq(sale.pendingWithdrawal(collector), 0.05 ether);
        assertEq(sale.pendingWithdrawal(artist), 0.95 ether);
    }

    function test_referral_saleOrCollectionCountsAsNone() public {
        address[2] memory sinks = [address(sale), address(token)];
        vm.prank(artist);
        sale.setPrice(1 ether);
        for (uint256 i = 0; i < 2; i++) {
            uint256 before = sale.pendingWithdrawal(artist);
            vm.recordLogs();
            vm.expectEmit(address(sale));
            emit IMinter.Sold(collector, collector, address(0), 1, 1 ether, i + 1);
            _mintRef(sinks[i], 1 ether);
            assertFalse(_hasLog(IMinter.ReferralPaid.selector));
            assertEq(sale.pendingWithdrawal(sinks[i]), 0);
            assertEq(sale.pendingWithdrawal(artist) - before, 1 ether);
        }
        assertEq(address(sale).balance, sale.pendingWithdrawal(artist));
    }

    function test_referral_artistKeepsAll() public {
        _mintRef(artist, 1 ether);
        assertEq(sale.pendingWithdrawal(artist), 1 ether);
    }

    function test_referral_thirdParty() public {
        address host = makeAddr("host");
        vm.prank(artist);
        sale.setPrice(1 ether);
        vm.expectEmit(address(sale));
        emit IMinter.ReferralPaid(host, 0.05 ether);
        vm.expectEmit(address(sale));
        emit IMinter.Sold(collector, collector, host, 1, 1 ether, 1);
        _mintRef(host, 1 ether);
        assertEq(sale.pendingWithdrawal(host), 0.05 ether);
        assertEq(sale.pendingWithdrawal(artist), 0.95 ether);
    }

    function test_referral_roundsDownForReferrer() public {
        address host = makeAddr("host");
        _mintRef(host, 999);
        assertEq(sale.pendingWithdrawal(host), 49);
        assertEq(sale.pendingWithdrawal(artist), 950);
    }

    function test_referral_zeroPriceEmitsNoReferralPaid() public {
        address host = makeAddr("host");
        vm.recordLogs();
        _mintRef(host, 0);
        bytes32 referralPaid = IMinter.ReferralPaid.selector;
        assertFalse(_hasLog(referralPaid));
    }

    function test_mint_paysDefaultReferrer() public {
        vm.expectEmit(address(sale));
        emit IMinter.Sold(collector, collector, pnd, 2, 2 * PRICE, 1);
        _mint(sale, collector, 2);
        assertEq(sale.pendingWithdrawal(pnd), (2 * PRICE * 500) / 10_000);
        assertEq(sale.pendingWithdrawal(artist), 2 * PRICE - (2 * PRICE * 500) / 10_000);
    }

    function test_mint_zeroDefaultReferrer_artistKeepsAll() public {
        FixedPriceSale s = _rawSale();
        vm.startPrank(artist);
        _initRaw(s, address(token)); // defaultReferrer = 0
        token.setMinter(address(s));
        vm.stopPrank();
        _mint(s, collector, 1);
        assertEq(s.pendingWithdrawal(artist), PRICE);
    }

    function test_referralShare_isConstant() public view {
        assertEq(sale.REFERRAL_SHARE_BPS(), 500);
    }

    function test_sold_payerDiffersFromRecipient() public {
        vm.expectEmit(address(sale));
        emit IMinter.Sold(stranger, collector, address(0), 1, PRICE, 1);
        vm.prank(stranger);
        sale.mintWithReferral{value: PRICE}(collector, 1, address(0), "");
    }

    // ─── pull payments ──────────────────────────────────────────────────────

    function test_withdraw_byAnyone_paysAccount() public {
        _mint(sale, collector, 1);
        uint256 owed = sale.pendingWithdrawal(artist);
        uint256 before = artist.balance;
        vm.expectEmit(address(sale));
        emit FixedPriceSale.Withdrawn(artist, artist, owed);
        vm.prank(stranger);
        sale.withdraw(artist);
        assertEq(artist.balance - before, owed);
        assertEq(sale.pendingWithdrawal(artist), 0);
        vm.expectRevert(FixedPriceSale.NothingToWithdraw.selector);
        sale.withdraw(artist);
    }

    function test_withdrawTo_callerBalanceOnly() public {
        _mint(sale, collector, 1);
        uint256 owed = sale.pendingWithdrawal(pnd);
        address dest = makeAddr("dest");
        vm.prank(stranger);
        vm.expectRevert(FixedPriceSale.NothingToWithdraw.selector);
        sale.withdrawTo(dest);
        vm.prank(pnd);
        sale.withdrawTo(dest);
        assertEq(dest.balance, owed);
        vm.prank(pnd);
        vm.expectRevert(FixedPriceSale.ZeroAccount.selector);
        sale.withdrawTo(address(0));
    }

    function test_withdraw_zeroAccount() public {
        vm.expectRevert(FixedPriceSale.ZeroAccount.selector);
        sale.withdraw(address(0));
    }

    function test_withdraw_rejectingRecipientKeepsBalance() public {
        address rejector = address(new RejectETH());
        vm.prank(artist);
        sale.setPayoutRecipient(rejector);
        _mint(sale, collector, 1);
        uint256 owed = sale.pendingWithdrawal(rejector);
        vm.expectRevert(FixedPriceSale.WithdrawFailed.selector);
        sale.withdraw(rejector);
        assertEq(sale.pendingWithdrawal(rejector), owed);
        // A reverting recipient never blocks minting.
        _mint(sale, collector, 1);
    }

    function test_payoutsSurviveRenounce() public {
        _mint(sale, collector, 1);
        vm.prank(artist);
        token.renounceOwnership();
        _mint(sale, collector, 1);
        sale.withdraw(artist);
        assertEq(sale.pendingWithdrawal(artist), 0);
        assertEq(artist.balance, 2 * PRICE - 2 * ((PRICE * 500) / 10_000));
    }

    // ─── config under borrowed authority ────────────────────────────────────

    function test_config_ownerOnly() public {
        vm.startPrank(stranger);
        vm.expectRevert(FixedPriceSale.NotAuthorized.selector);
        sale.setPrice(1);
        vm.expectRevert(FixedPriceSale.NotAuthorized.selector);
        sale.setMintWindow(0, 0);
        vm.expectRevert(FixedPriceSale.NotAuthorized.selector);
        sale.setMaxMints(1);
        vm.expectRevert(FixedPriceSale.NotAuthorized.selector);
        sale.setWalletCap(1);
        vm.expectRevert(FixedPriceSale.NotAuthorized.selector);
        sale.setPayoutRecipient(stranger);
        vm.expectRevert(FixedPriceSale.NotAuthorized.selector);
        sale.setGate(address(0));
        vm.stopPrank();
    }

    function test_config_setters() public {
        MockGate g = new MockGate();
        vm.startPrank(artist);
        sale.setPrice(1 ether);
        sale.setMintWindow(10, 20);
        sale.setMaxMints(7);
        sale.setWalletCap(2);
        sale.setPayoutRecipient(stranger);
        sale.setGate(address(g));
        vm.expectRevert(FixedPriceSale.BadMintWindow.selector);
        sale.setMintWindow(20, 20);
        vm.expectRevert(FixedPriceSale.PayoutRecipientRequired.selector);
        sale.setPayoutRecipient(address(0));
        vm.expectRevert(abi.encodeWithSelector(FixedPriceSale.NotAContract.selector, collector));
        sale.setGate(collector);
        vm.stopPrank();
        assertEq(sale.price(), 1 ether);
        assertEq(sale.mintStart(), 10);
        assertEq(sale.mintEnd(), 20);
        assertEq(sale.maxMints(), 7);
        assertEq(sale.walletCap(), 2);
        assertEq(sale.payoutRecipient(), stranger);
        assertEq(sale.gate(), address(g));
    }

    function test_config_followsTokenOwnership() public {
        vm.prank(artist);
        token.transferOwnership(stranger);
        vm.prank(artist);
        vm.expectRevert(FixedPriceSale.NotAuthorized.selector);
        sale.setPrice(1);
        vm.prank(stranger);
        sale.setPrice(1);
        assertEq(sale.price(), 1);
    }

    function test_config_frozenAfterRenounce() public {
        vm.prank(artist);
        token.renounceOwnership();
        vm.startPrank(artist);
        vm.expectRevert(FixedPriceSale.NotAuthorized.selector);
        sale.setPrice(1);
        vm.expectRevert(FixedPriceSale.NotAuthorized.selector);
        sale.close();
        vm.stopPrank();
    }

    function test_payoutChange_keepsAccruedBalance() public {
        _mint(sale, collector, 1);
        uint256 owed = sale.pendingWithdrawal(artist);
        vm.prank(artist);
        sale.setPayoutRecipient(stranger);
        _mint(sale, collector, 1);
        assertEq(sale.pendingWithdrawal(artist), owed);
        assertEq(sale.pendingWithdrawal(stranger), owed);
    }

    // ─── identification ─────────────────────────────────────────────────────

    function test_identification() public view {
        assertEq(sale.version(), 2);
        assertTrue(sale.supportsInterface(type(IMinter).interfaceId));
        assertTrue(sale.supportsInterface(0x01ffc9a7));
        assertFalse(sale.supportsInterface(0xffffffff));
    }

    function test_rejectsPlainETH() public {
        (bool ok,) = address(sale).call{value: 1}("");
        assertFalse(ok);
    }

    function _hasLog(bytes32 topic) internal view returns (bool) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length != 0 && logs[i].topics[0] == topic) return true;
        }
        return false;
    }
}

/// @dev Passes only the exact arguments it was built with (gates are views,
///      so it cannot record them).
contract ExpectingGate {
    address internal immutable _collection;
    address internal immutable _to;
    uint256 internal immutable _quantity;
    bytes internal _data;

    constructor(address c, address t, uint256 q, bytes memory d) {
        _collection = c;
        _to = t;
        _quantity = q;
        _data = d;
    }

    function check(address c, address t, uint256 q, bytes calldata d) external view returns (bool) {
        return c == _collection && t == _to && q == _quantity && keccak256(d) == keccak256(_data);
    }
}

/// @dev Accepts every id except `rejectId` (0 = accept all) and records the
///      ids it was asked about.
contract PickyReceiver {
    uint256 public immutable rejectId;
    uint256[] public seen;

    constructor(uint256 rejectId_) {
        rejectId = rejectId_;
    }

    function seenCount() external view returns (uint256) {
        return seen.length;
    }

    function onERC721Received(address, address, uint256 tokenId, bytes calldata) external returns (bytes4) {
        seen.push(tokenId);
        return tokenId == rejectId ? bytes4(0) : this.onERC721Received.selector;
    }
}
