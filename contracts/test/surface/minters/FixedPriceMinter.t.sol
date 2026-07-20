// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {FixedPriceMinterBase} from "./FixedPriceMinterBase.sol";
import {FixedPriceMinter, FixedPriceMinterInitParams} from "../../../src/surface/minters/FixedPriceMinter.sol";
import {IMinter} from "../../../src/surface/interfaces/IMinter.sol";
import {ISurfaceCore} from "../../../src/surface/interfaces/ISurfaceCore.sol";
import {Surface} from "../../../src/surface/Surface.sol";
import {MockFixedStrategy, RevertingStrategy, VaryingPriceStrategy, RevertingReceiver} from "./mocks/MinterMocks.sol";

contract FixedPriceMinterTest is FixedPriceMinterBase {
    uint256 internal constant PRICE = 0.01 ether;

    // ─────────────────────────────────────────────────────────────────────────
    // Happy paths
    // ─────────────────────────────────────────────────────────────────────────

    function test_fixedPriceMint_exact_noReferrer() public {
        (Surface c, FixedPriceMinter m) = _collectionWithMinter(PRICE);
        vm.deal(collector, PRICE);
        vm.prank(collector);
        m.mint{value: PRICE}(collector, 1, address(0), "");

        assertEq(c.ownerOf(1), collector);
        assertEq(m.pendingWithdrawal(artist), PRICE, "full price accrues to artist with no referrer");
        assertEq(m.pendingWithdrawal(collector), 0);
    }

    function test_fixedPriceMint_withReferrer_splitsShare() public {
        (, FixedPriceMinter m) = _collectionWithMinter(PRICE);
        vm.deal(collector, PRICE);
        vm.prank(collector);
        m.mint{value: PRICE}(collector, 1, referrer, "");

        uint256 refCut = (PRICE * m.REFERRAL_SHARE_BPS()) / 10_000;
        assertEq(m.pendingWithdrawal(referrer), refCut);
        assertEq(m.pendingWithdrawal(artist), PRICE - refCut);
    }

    function test_strategyPriceMint_refundsExcessToPayer() public {
        MockFixedStrategy strategy = new MockFixedStrategy(PRICE);
        FixedPriceMinterInitParams memory p = _minterParams(address(0), 0);
        p.priceStrategy = address(strategy);
        (, FixedPriceMinter m) = _collectionWithConfiguredMinter(p);

        uint256 sent = PRICE + 0.5 ether;
        vm.deal(collector, sent);
        vm.prank(collector);
        m.mint{value: sent}(collector, 1, address(0), "");

        assertEq(m.pendingWithdrawal(collector), 0.5 ether, "excess accrues to payer");
        assertEq(m.pendingWithdrawal(artist), PRICE);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // mint(uint256): ergonomic overload, mints to msg.sender, no referrer
    // ─────────────────────────────────────────────────────────────────────────

    function test_mintQuantityOverload_mintsToCallerWithNoReferrer() public {
        (Surface c, FixedPriceMinter m) = _collectionWithMinter(PRICE);
        vm.deal(collector, PRICE);
        vm.prank(collector);
        m.mint{value: PRICE}(1);

        assertEq(c.ownerOf(1), collector, "minted to the caller");
        assertEq(m.pendingWithdrawal(artist), PRICE, "full price accrues to artist, no referrer");
        assertEq(m.pendingWithdrawal(collector), 0);
    }

    /// @dev Same settlement/pending outcome as the 4-arg path for an
    ///      equivalent call (to == msg.sender, referrer == 0, no data): the
    ///      overload delegates to the same guarded _executeMint body.
    function test_mintQuantityOverload_matchesFourArgPathSettlement() public {
        (, FixedPriceMinter m4) = _collectionWithMinter(PRICE);
        (, FixedPriceMinter mOverload) = _collectionWithMinter(PRICE);

        vm.deal(collector, PRICE * 2);
        vm.prank(collector);
        m4.mint{value: PRICE}(collector, 1, address(0), "");
        vm.prank(collector);
        mOverload.mint{value: PRICE}(1);

        assertEq(m4.pendingWithdrawal(artist), mOverload.pendingWithdrawal(artist), "identical artist accrual");
        assertEq(m4.totalMinted(), mOverload.totalMinted(), "identical totalMinted bookkeeping");
    }

    function test_mintQuantityOverload_wrongPaymentReverts() public {
        (, FixedPriceMinter m) = _collectionWithMinter(PRICE);
        vm.deal(collector, PRICE);
        vm.expectRevert(abi.encodeWithSelector(IMinter.WrongPayment.selector, PRICE, PRICE - 1));
        vm.prank(collector);
        m.mint{value: PRICE - 1}(1);
    }

    /// @dev Strategy-priced excess on the overload refunds to msg.sender
    ///      (the payer), never to the minter contract itself.
    function test_mintQuantityOverload_strategyExcessRefundsToPayerNotMinter() public {
        MockFixedStrategy strategy = new MockFixedStrategy(PRICE);
        FixedPriceMinterInitParams memory p = _minterParams(address(0), 0);
        p.priceStrategy = address(strategy);
        (, FixedPriceMinter m) = _collectionWithConfiguredMinter(p);

        uint256 sent = PRICE + 0.3 ether;
        vm.deal(collector, sent);
        vm.prank(collector);
        m.mint{value: sent}(1);

        assertEq(m.pendingWithdrawal(collector), 0.3 ether, "excess accrues to the payer, not the minter");
        assertEq(m.pendingWithdrawal(address(m)), 0, "the minter contract itself is never a payee");
        assertEq(m.pendingWithdrawal(artist), PRICE);
    }

    /// @dev The factory default (unset SaleConfig.payoutRecipient resolves to
    ///      the deploy-time `owner` argument) is covered end-to-end in
    ///      SurfaceFactory.t.sol's test_factoryDefaultsPayoutRecipientToDeployOwner.
    ///      Ownership transfer after deploy must NOT move the payout: it is a
    ///      stored value, not a live owner() read.
    function test_ownershipTransfer_doesNotMovePayoutRecipient() public {
        (Surface c, FixedPriceMinter m) = _collectionWithMinter(PRICE);
        vm.deal(collector, PRICE);
        vm.prank(collector);
        m.mint{value: PRICE}(collector, 1, address(0), "");
        assertEq(m.pendingWithdrawal(artist), PRICE);

        address newOwner = makeAddr("newOwner");
        vm.prank(artist);
        c.transferOwnership(newOwner);
        vm.prank(newOwner);
        c.acceptOwnership();

        vm.deal(collector, PRICE);
        vm.prank(collector);
        m.mint{value: PRICE}(collector, 1, address(0), "");
        assertEq(m.pendingWithdrawal(newOwner), 0, "payout does not follow ownership transfer");
        assertEq(m.pendingWithdrawal(artist), PRICE * 2, "the stored payoutRecipient keeps accruing");
    }

    function test_payoutUsesConfiguredPayoutRecipient() public {
        address payoutAddr = makeAddr("payoutAddr");
        FixedPriceMinterInitParams memory p = _minterParams(address(0), PRICE);
        p.payoutRecipient = payoutAddr;
        (, FixedPriceMinter m) = _collectionWithConfiguredMinter(p);

        vm.deal(collector, PRICE);
        vm.prank(collector);
        m.mint{value: PRICE}(collector, 1, address(0), "");
        assertEq(m.pendingWithdrawal(payoutAddr), PRICE);
        assertEq(m.pendingWithdrawal(artist), 0);
    }

    /// @dev 7.8: price 0 is legal config, not a free-mint special case. The
    ///      exact-match check still applies (msg.value must be exactly 0);
    ///      there is no owner/free-mint bypass anywhere in this contract.
    function test_zeroPriceConfig_isLegalAndStillExactMatch() public {
        (Surface c, FixedPriceMinter m) = _collectionWithMinter(0);
        vm.prank(collector);
        m.mint(collector, 1, address(0), ""); // no value sent, required == 0
        assertEq(c.ownerOf(1), collector);

        vm.deal(collector, 1);
        vm.prank(collector);
        vm.expectRevert(abi.encodeWithSelector(IMinter.WrongPayment.selector, uint256(0), uint256(1)));
        m.mint{value: 1}(collector, 1, address(0), "");
    }

    function test_batchQuantityMint() public {
        (Surface c, FixedPriceMinter m) = _collectionWithMinter(PRICE);
        uint256 qty = 3;
        vm.deal(collector, PRICE * qty);
        vm.prank(collector);
        vm.expectEmit(true, true, true, true, address(m));
        emit IMinter.Sold(collector, collector, address(0), qty, PRICE * qty, 1);
        m.mint{value: PRICE * qty}(collector, qty, address(0), "");

        assertEq(c.ownerOf(1), collector);
        assertEq(c.ownerOf(2), collector);
        assertEq(c.ownerOf(3), collector);
        assertEq(m.pendingWithdrawal(artist), PRICE * qty);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Window
    // ─────────────────────────────────────────────────────────────────────────

    function test_mint_beforeStart_reverts() public {
        FixedPriceMinterInitParams memory p = _minterParams(address(0), PRICE);
        p.mintStart = uint64(block.timestamp + 1 days);
        (, FixedPriceMinter m) = _collectionWithConfiguredMinter(p);

        vm.deal(collector, PRICE);
        vm.prank(collector);
        vm.expectRevert(IMinter.MintNotStarted.selector);
        m.mint{value: PRICE}(collector, 1, address(0), "");
    }

    function test_mint_atStartBoundary_succeeds() public {
        FixedPriceMinterInitParams memory p = _minterParams(address(0), PRICE);
        p.mintStart = uint64(block.timestamp + 1 days);
        (, FixedPriceMinter m) = _collectionWithConfiguredMinter(p);

        vm.warp(p.mintStart);
        vm.deal(collector, PRICE);
        vm.prank(collector);
        m.mint{value: PRICE}(collector, 1, address(0), "");
        assertEq(m.pendingWithdrawal(artist), PRICE);
    }

    function test_mint_afterEnd_reverts() public {
        FixedPriceMinterInitParams memory p = _minterParams(address(0), PRICE);
        p.mintEnd = uint64(block.timestamp + 1 days);
        (, FixedPriceMinter m) = _collectionWithConfiguredMinter(p);

        vm.warp(p.mintEnd);
        vm.deal(collector, PRICE);
        vm.prank(collector);
        vm.expectRevert(IMinter.MintEnded.selector);
        m.mint{value: PRICE}(collector, 1, address(0), "");
    }

    function test_mint_justBeforeEnd_succeeds() public {
        FixedPriceMinterInitParams memory p = _minterParams(address(0), PRICE);
        p.mintEnd = uint64(block.timestamp + 1 days);
        (, FixedPriceMinter m) = _collectionWithConfiguredMinter(p);

        vm.warp(p.mintEnd - 1);
        vm.deal(collector, PRICE);
        vm.prank(collector);
        m.mint{value: PRICE}(collector, 1, address(0), "");
        assertEq(m.pendingWithdrawal(artist), PRICE);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // maxMints
    // ─────────────────────────────────────────────────────────────────────────

    function test_maxMints_enforced() public {
        FixedPriceMinterInitParams memory p = _minterParams(address(0), PRICE);
        p.maxMints = 2;
        (, FixedPriceMinter m) = _collectionWithConfiguredMinter(p);

        vm.deal(collector, PRICE * 3);
        vm.prank(collector);
        m.mint{value: PRICE * 2}(collector, 2, address(0), "");

        vm.prank(collector);
        vm.expectRevert(abi.encodeWithSelector(IMinter.MaxMintsExceeded.selector, uint256(2), uint256(3)));
        m.mint{value: PRICE}(collector, 1, address(0), "");
    }

    function test_maxMints_zero_isUnlimited() public {
        (, FixedPriceMinter m) = _collectionWithMinter(PRICE);
        assertEq(m.maxMints(), 0);
        vm.deal(collector, PRICE * 10);
        vm.prank(collector);
        m.mint{value: PRICE * 10}(collector, 10, address(0), "");
        assertEq(m.totalMinted(), 10);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Integration aliases: same values as the underlying getters
    // ─────────────────────────────────────────────────────────────────────────

    function test_saleCap_aliasesMaxMints() public {
        FixedPriceMinterInitParams memory p = _minterParams(address(0), PRICE);
        p.maxMints = 7;
        (, FixedPriceMinter m) = _collectionWithConfiguredMinter(p);
        assertEq(m.saleCap(), m.maxMints());
        assertEq(m.saleCap(), 7);
    }

    function test_totalMintedByThisMinter_aliasesTotalMinted() public {
        (, FixedPriceMinter m) = _collectionWithMinter(PRICE);
        vm.deal(collector, PRICE * 3);
        vm.prank(collector);
        m.mint{value: PRICE * 3}(collector, 3, address(0), "");
        assertEq(m.totalMintedByThisMinter(), m.totalMinted());
        assertEq(m.totalMintedByThisMinter(), 3);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Allowlist
    // ─────────────────────────────────────────────────────────────────────────

    function test_allowlist_validProof_succeeds() public {
        (bytes32 root, bytes32[] memory proof1,) = _twoLeafTree(collector, referrer);
        FixedPriceMinterInitParams memory p = _minterParams(address(0), PRICE);
        p.allowlistRoot = root;
        (, FixedPriceMinter m) = _collectionWithConfiguredMinter(p);

        vm.deal(collector, PRICE);
        vm.prank(collector);
        m.mint{value: PRICE}(collector, 1, address(0), abi.encode(proof1));
        assertEq(m.pendingWithdrawal(artist), PRICE);
    }

    function test_allowlist_wrongProof_reverts() public {
        (bytes32 root,, bytes32[] memory proof2) = _twoLeafTree(collector, referrer);
        FixedPriceMinterInitParams memory p = _minterParams(address(0), PRICE);
        p.allowlistRoot = root;
        (, FixedPriceMinter m) = _collectionWithConfiguredMinter(p);

        // proof2 is valid for `referrer`, not `collector`.
        vm.deal(collector, PRICE);
        vm.prank(collector);
        vm.expectRevert(IMinter.NotAllowlisted.selector);
        m.mint{value: PRICE}(collector, 1, address(0), abi.encode(proof2));
    }

    /// @dev The gate evaluates `to`, not the payer: stranger pays, gifting to
    ///      the allowlisted `collector`, and the mint succeeds.
    function test_allowlist_payerNotRecipient_gateEvaluatesRecipient() public {
        (bytes32 root, bytes32[] memory proof1,) = _twoLeafTree(collector, referrer);
        FixedPriceMinterInitParams memory p = _minterParams(address(0), PRICE);
        p.allowlistRoot = root;
        (Surface c, FixedPriceMinter m) = _collectionWithConfiguredMinter(p);

        vm.deal(stranger, PRICE);
        vm.prank(stranger);
        m.mint{value: PRICE}(collector, 1, address(0), abi.encode(proof1));
        assertEq(c.ownerOf(1), collector, "recipient is the gifted allowlisted address");

        // The reverse: stranger is not allowlisted and cannot mint to itself
        // even though it is the one paying and holds a proof for `collector`.
        vm.deal(stranger, PRICE);
        vm.prank(stranger);
        vm.expectRevert(IMinter.NotAllowlisted.selector);
        m.mint{value: PRICE}(stranger, 1, address(0), abi.encode(proof1));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Wallet cap
    // ─────────────────────────────────────────────────────────────────────────

    function test_walletCap_enforced() public {
        FixedPriceMinterInitParams memory p = _minterParams(address(0), PRICE);
        p.walletCap = 2;
        (, FixedPriceMinter m) = _collectionWithConfiguredMinter(p);

        vm.deal(collector, PRICE * 3);
        vm.prank(collector);
        m.mint{value: PRICE * 2}(collector, 2, address(0), "");

        vm.prank(collector);
        vm.expectRevert(abi.encodeWithSelector(IMinter.WalletCapExceeded.selector, uint256(2), uint256(3)));
        m.mint{value: PRICE}(collector, 1, address(0), "");
    }

    /// @dev A reverted attempt must not count toward the cap.
    function test_walletCap_countsAfterSuccess() public {
        FixedPriceMinterInitParams memory p = _minterParams(address(0), PRICE);
        p.walletCap = 1;
        (, FixedPriceMinter m) = _collectionWithConfiguredMinter(p);

        // Wrong payment: reverts before the wallet-cap counter is touched.
        vm.deal(collector, PRICE * 2);
        vm.prank(collector);
        vm.expectRevert(abi.encodeWithSelector(IMinter.WrongPayment.selector, PRICE, PRICE + 1));
        m.mint{value: PRICE + 1}(collector, 1, address(0), "");
        assertEq(m.mintedBy(collector), 0, "failed attempt must not count");

        vm.prank(collector);
        m.mint{value: PRICE}(collector, 1, address(0), "");
        assertEq(m.mintedBy(collector), 1);
    }

    function test_walletCap_loweredBelowCount_blocksFurtherMints() public {
        FixedPriceMinterInitParams memory p = _minterParams(address(0), PRICE);
        p.walletCap = 5;
        (, FixedPriceMinter m) = _collectionWithConfiguredMinter(p);

        vm.deal(collector, PRICE * 2);
        vm.prank(collector);
        m.mint{value: PRICE * 2}(collector, 2, address(0), "");

        vm.prank(artist);
        m.setWalletCap(1);

        vm.deal(collector, PRICE);
        vm.prank(collector);
        vm.expectRevert(abi.encodeWithSelector(IMinter.WalletCapExceeded.selector, uint256(1), uint256(3)));
        m.mint{value: PRICE}(collector, 1, address(0), "");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // AND-composition: allowlisted but over cap still reverts
    // ─────────────────────────────────────────────────────────────────────────

    function test_allowlistedButOverCap_reverts() public {
        (bytes32 root, bytes32[] memory proof1,) = _twoLeafTree(collector, referrer);
        FixedPriceMinterInitParams memory p = _minterParams(address(0), PRICE);
        p.allowlistRoot = root;
        p.walletCap = 1;
        (, FixedPriceMinter m) = _collectionWithConfiguredMinter(p);

        vm.deal(collector, PRICE * 2);
        vm.prank(collector);
        m.mint{value: PRICE}(collector, 1, address(0), abi.encode(proof1));

        vm.prank(collector);
        vm.expectRevert(abi.encodeWithSelector(IMinter.WalletCapExceeded.selector, uint256(1), uint256(2)));
        m.mint{value: PRICE}(collector, 1, address(0), abi.encode(proof1));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Exact-match violations (fixed price)
    // ─────────────────────────────────────────────────────────────────────────

    function test_fixedPrice_overpayment_reverts() public {
        (, FixedPriceMinter m) = _collectionWithMinter(PRICE);
        vm.deal(collector, PRICE + 1);
        vm.prank(collector);
        vm.expectRevert(abi.encodeWithSelector(IMinter.WrongPayment.selector, PRICE, PRICE + 1));
        m.mint{value: PRICE + 1}(collector, 1, address(0), "");
    }

    function test_fixedPrice_underpayment_reverts() public {
        (, FixedPriceMinter m) = _collectionWithMinter(PRICE);
        vm.deal(collector, PRICE - 1);
        vm.prank(collector);
        vm.expectRevert(abi.encodeWithSelector(IMinter.WrongPayment.selector, PRICE, PRICE - 1));
        m.mint{value: PRICE - 1}(collector, 1, address(0), "");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Strategy underpayment
    // ─────────────────────────────────────────────────────────────────────────

    function test_strategyUnderpayment_reverts() public {
        MockFixedStrategy strategy = new MockFixedStrategy(PRICE);
        FixedPriceMinterInitParams memory p = _minterParams(address(0), 0);
        p.priceStrategy = address(strategy);
        (, FixedPriceMinter m) = _collectionWithConfiguredMinter(p);

        vm.deal(collector, PRICE - 1);
        vm.prank(collector);
        vm.expectRevert(abi.encodeWithSelector(IMinter.Underpayment.selector, PRICE, PRICE - 1));
        m.mint{value: PRICE - 1}(collector, 1, address(0), "");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Withdraw flows
    // ─────────────────────────────────────────────────────────────────────────

    function test_withdraw_anyoneCanTrigger() public {
        (, FixedPriceMinter m) = _collectionWithMinter(PRICE);
        vm.deal(collector, PRICE);
        vm.prank(collector);
        m.mint{value: PRICE}(collector, 1, address(0), "");

        uint256 before = artist.balance;
        vm.prank(stranger); // permissionless trigger
        m.withdraw(artist);
        assertEq(artist.balance, before + PRICE);
        assertEq(m.pendingWithdrawal(artist), 0);
    }

    function test_withdraw_onlyToOwedAddress() public {
        (, FixedPriceMinter m) = _collectionWithMinter(PRICE);
        vm.deal(collector, PRICE);
        vm.prank(collector);
        m.mint{value: PRICE}(collector, 1, address(0), "");

        uint256 strangerBefore = stranger.balance;
        m.withdraw(artist); // funds go to `artist`, regardless of caller
        assertEq(stranger.balance, strangerBefore, "withdraw(artist) must not pay the caller");
    }

    function test_withdraw_zeroBalance_reverts() public {
        (, FixedPriceMinter m) = _collectionWithMinter(PRICE);
        vm.expectRevert(FixedPriceMinter.NothingToWithdraw.selector);
        m.withdraw(stranger);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Unauthorized config setters
    // ─────────────────────────────────────────────────────────────────────────

    function test_unauthorizedConfigSetters_revert() public {
        (, FixedPriceMinter m) = _collectionWithMinter(PRICE);

        vm.startPrank(stranger);
        vm.expectRevert(FixedPriceMinter.NotAuthorized.selector);
        m.setPrice(1);
        vm.expectRevert(FixedPriceMinter.NotAuthorized.selector);
        m.setPriceStrategy(address(0));
        vm.expectRevert(FixedPriceMinter.NotAuthorized.selector);
        m.setMintWindow(0, 0);
        vm.expectRevert(FixedPriceMinter.NotAuthorized.selector);
        m.setPayoutRecipient(stranger);
        vm.expectRevert(FixedPriceMinter.NotAuthorized.selector);
        m.setMaxMints(1);
        vm.expectRevert(FixedPriceMinter.NotAuthorized.selector);
        m.setAllowlistRoot(bytes32(uint256(1)));
        vm.expectRevert(FixedPriceMinter.NotAuthorized.selector);
        m.setWalletCap(1);
        vm.expectRevert(FixedPriceMinter.NotAuthorized.selector);
        m.rescueStrayETH(stranger);
        vm.stopPrank();
    }

    function test_authorizedAdmin_canConfigure() public {
        (Surface c, FixedPriceMinter m) = _collectionWithMinter(PRICE);
        address admin = makeAddr("admin");
        vm.prank(artist);
        c.addAdmin(admin);

        vm.prank(admin);
        m.setPrice(PRICE * 2);
        assertEq(m.price(), PRICE * 2);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // initialize()
    // ─────────────────────────────────────────────────────────────────────────

    function test_initialize_cannotReinitialize() public {
        (Surface c, FixedPriceMinter m) = _collectionWithMinter(PRICE);
        vm.expectRevert();
        m.initialize(_minterParams(address(c), PRICE));
    }

    function test_initialize_zeroCollection_reverts() public {
        FixedPriceMinter m = _freshMinterClone();
        vm.expectRevert(FixedPriceMinter.CollectionRequired.selector);
        m.initialize(_minterParams(address(0), PRICE));
    }

    function test_initialize_collectionNotContract_reverts() public {
        FixedPriceMinter m = _freshMinterClone();
        vm.expectRevert(abi.encodeWithSelector(FixedPriceMinter.NotAContract.selector, stranger));
        m.initialize(_minterParams(stranger, PRICE));
    }

    function test_initialize_priceStrategyNotContract_reverts() public {
        Surface c = _collection(_freeConfig());
        FixedPriceMinter m = _freshMinterClone();
        FixedPriceMinterInitParams memory p = _minterParams(address(c), PRICE);
        p.priceStrategy = stranger;
        vm.expectRevert(abi.encodeWithSelector(FixedPriceMinter.NotAContract.selector, stranger));
        vm.prank(artist);
        m.initialize(p);
    }

    function test_initialize_badMintWindow_reverts() public {
        Surface c = _collection(_freeConfig());
        FixedPriceMinter m = _freshMinterClone();
        FixedPriceMinterInitParams memory p = _minterParams(address(c), PRICE);
        p.mintStart = 100;
        p.mintEnd = 100;
        vm.expectRevert(FixedPriceMinter.BadMintWindow.selector);
        vm.prank(artist);
        m.initialize(p);
    }

    function test_initialize_zeroPayoutRecipient_reverts() public {
        Surface c = _collection(_freeConfig());
        FixedPriceMinter m = _freshMinterClone();
        FixedPriceMinterInitParams memory p = _minterParams(address(c), PRICE);
        p.payoutRecipient = address(0);
        vm.expectRevert(FixedPriceMinter.PayoutRecipientRequired.selector);
        vm.prank(artist);
        m.initialize(p);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Two clones, isolated balances
    // ─────────────────────────────────────────────────────────────────────────

    function test_twoClones_isolatedBalances() public {
        (, FixedPriceMinter m1) = _collectionWithMinter(PRICE);
        (, FixedPriceMinter m2) = _collectionWithMinter(PRICE);

        vm.deal(collector, PRICE * 2);
        vm.prank(collector);
        m1.mint{value: PRICE}(collector, 1, address(0), "");

        assertEq(address(m1).balance, PRICE);
        assertEq(address(m2).balance, 0);
        assertEq(m2.pendingWithdrawal(artist), 0);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Reverting recipient: pull payment isolation
    // ─────────────────────────────────────────────────────────────────────────

    function test_revertingRecipient_cannotBlockMint_butItsOwnWithdrawFails() public {
        RevertingReceiver bad = new RevertingReceiver();
        FixedPriceMinterInitParams memory p = _minterParams(address(0), PRICE);
        p.payoutRecipient = address(bad);
        (, FixedPriceMinter m) = _collectionWithConfiguredMinter(p);

        vm.deal(collector, PRICE);
        vm.prank(collector);
        m.mint{value: PRICE}(collector, 1, address(0), ""); // does not revert despite payout being hostile
        assertEq(m.pendingWithdrawal(address(bad)), PRICE);

        vm.expectRevert(FixedPriceMinter.WithdrawFailed.selector);
        m.withdraw(address(bad));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Malicious / adversarial price strategies
    // ─────────────────────────────────────────────────────────────────────────

    function test_absurdPriceStrategy_reverts() public {
        MockFixedStrategy strategy = new MockFixedStrategy(type(uint256).max);
        FixedPriceMinterInitParams memory p = _minterParams(address(0), 0);
        p.priceStrategy = address(strategy);
        (, FixedPriceMinter m) = _collectionWithConfiguredMinter(p);

        vm.deal(collector, 1 ether);
        vm.prank(collector);
        vm.expectRevert(abi.encodeWithSelector(IMinter.Underpayment.selector, type(uint256).max, 1 ether));
        m.mint{value: 1 ether}(collector, 1, address(0), "");
    }

    function test_revertingStrategy_bubblesRevert() public {
        RevertingStrategy strategy = new RevertingStrategy();
        FixedPriceMinterInitParams memory p = _minterParams(address(0), 0);
        p.priceStrategy = address(strategy);
        (, FixedPriceMinter m) = _collectionWithConfiguredMinter(p);

        vm.deal(collector, 1 ether);
        vm.prank(collector);
        vm.expectRevert("RevertingStrategy: always reverts");
        m.mint{value: 1 ether}(collector, 1, address(0), "");
    }

    /// @dev A strategy whose answer changes between calls (gasleft()-based)
    ///      cannot cause the minter to split more value than it received:
    ///      the sum of everything accrued (payout + referral + excess) must
    ///      equal exactly msg.value, which only holds if the strategy is
    ///      read once and that single value is reused for both the payment
    ///      check and the settle.
    function test_readOnceGuarantee_valueConservedAcrossVaryingStrategy() public {
        VaryingPriceStrategy strategy = new VaryingPriceStrategy();
        FixedPriceMinterInitParams memory p = _minterParams(address(0), 0);
        p.priceStrategy = address(strategy);
        (, FixedPriceMinter m) = _collectionWithConfiguredMinter(p);

        uint256 sent = 1 ether;
        vm.deal(collector, sent);
        vm.prank(collector);
        m.mint{value: sent}(collector, 1, referrer, "");

        uint256 accounted = m.pendingWithdrawal(artist) + m.pendingWithdrawal(referrer) + m.pendingWithdrawal(collector);
        assertEq(accounted, sent, "value not conserved: strategy must have been read more than once");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // NotMinter
    // ─────────────────────────────────────────────────────────────────────────

    function test_mintWithoutGrantOnCollection_reverts_NotMinter() public {
        Surface c = _collection(_freeConfig());
        FixedPriceMinter m = _freshMinterClone();
        vm.prank(artist);
        m.initialize(_minterParams(address(c), PRICE)); // never granted on c

        vm.deal(collector, PRICE);
        vm.prank(collector);
        vm.expectRevert(ISurfaceCore.NotMinter.selector);
        m.mint{value: PRICE}(collector, 1, address(0), "");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Renounce: payoutRecipient is a stored value, decoupled from owner().
    // A renounced collection keeps selling and keeps paying it.
    // ─────────────────────────────────────────────────────────────────────────

    function test_renouncedCollection_stillPaysStoredRecipient() public {
        (Surface c, FixedPriceMinter m) = _collectionWithMinter(PRICE);
        vm.prank(artist);
        c.renounceOwnership();
        assertEq(c.owner(), address(0));

        vm.deal(collector, PRICE);
        vm.prank(collector);
        m.mint{value: PRICE}(collector, 1, address(0), "");
        assertEq(c.ownerOf(1), collector, "renounced collection still mints");
        assertEq(m.pendingWithdrawal(artist), PRICE, "the stored payoutRecipient is credited");

        uint256 before = artist.balance;
        m.withdraw(artist);
        assertEq(artist.balance, before + PRICE, "the stored recipient can still withdraw");
    }

    function test_renouncedCollection_explicitPayoutRecipient_stillMintsAndPays() public {
        address payoutAddr = makeAddr("payoutAddr");
        FixedPriceMinterInitParams memory p = _minterParams(address(0), PRICE);
        p.payoutRecipient = payoutAddr;
        (Surface c, FixedPriceMinter m) = _collectionWithConfiguredMinter(p);
        vm.prank(artist);
        c.renounceOwnership();

        vm.deal(collector, PRICE);
        vm.prank(collector);
        m.mint{value: PRICE}(collector, 1, address(0), "");
        assertEq(c.ownerOf(1), collector);
        assertEq(m.pendingWithdrawal(payoutAddr), PRICE, "explicit payoutRecipient is unaffected by a renounced owner");
    }

    /// @dev price 0 (7.8) means _settle(0, ...) returns before touching
    ///      payoutRecipient at all, so a renounced collection with a zero
    ///      price still mints: there is no artist cut to pay.
    function test_renouncedCollection_zeroPrice_defaultPayoutRecipient_stillMints() public {
        (Surface c, FixedPriceMinter m) = _collectionWithMinter(0);
        vm.prank(artist);
        c.renounceOwnership();

        vm.prank(collector);
        m.mint(collector, 1, address(0), "");
        assertEq(c.ownerOf(1), collector);
    }

    /// @dev Once the owner has renounced and no admin is granted, nobody can
    ///      call setPayoutRecipient (borrowed auth has no live owner/admin),
    ///      but the existing stored value keeps paying out correctly. This
    ///      is the "can no longer be changed" half of the renounce story.
    function test_renouncedCollection_payoutRecipientNoLongerChangeable() public {
        (Surface c, FixedPriceMinter m) = _collectionWithMinter(PRICE);
        vm.prank(artist);
        c.renounceOwnership();

        vm.expectRevert(FixedPriceMinter.NotAuthorized.selector);
        m.setPayoutRecipient(makeAddr("newRecipient"));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Fix 3: initialize() caller-authority gate
    // ─────────────────────────────────────────────────────────────────────────

    function test_standaloneInit_strangerCannotInitializeAgainstLiveCollection() public {
        Surface c = _collection(_freeConfig()); // live, owned by artist
        FixedPriceMinter m = _freshMinterClone();
        vm.prank(stranger);
        vm.expectRevert(FixedPriceMinter.NotAuthorized.selector);
        m.initialize(_minterParams(address(c), PRICE));
    }

    function test_standaloneInit_collectionOwnerCanInitialize() public {
        Surface c = _collection(_freeConfig());
        FixedPriceMinter m = _freshMinterClone();
        vm.prank(artist);
        m.initialize(_minterParams(address(c), PRICE));
        assertEq(m.collection(), address(c));
    }

    function test_standaloneInit_collectionAdminCanInitialize() public {
        Surface c = _collection(_freeConfig());
        address admin = makeAddr("minterAdmin");
        vm.prank(artist);
        c.addAdmin(admin);

        FixedPriceMinter m = _freshMinterClone();
        vm.prank(admin);
        m.initialize(_minterParams(address(c), PRICE));
        assertEq(m.collection(), address(c));
    }

    /// @dev Mirrors the token side's own implementation-cannot-be-initialized
    ///      guarantee (SurfaceSecurity.t.sol's test_confirm_implCannotBeInitialized).
    function test_confirm_minterImplCannotBeInitialized() public {
        Surface c = _collection(_freeConfig());
        vm.expectRevert(abi.encodeWithSignature("InvalidInitialization()"));
        minterImpl.initialize(_minterParams(address(c), PRICE));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Config setter success paths
    // ─────────────────────────────────────────────────────────────────────────

    function test_setPriceStrategy_success() public {
        (, FixedPriceMinter m) = _collectionWithMinter(PRICE);
        MockFixedStrategy strategy = new MockFixedStrategy(PRICE * 2);
        vm.prank(artist);
        vm.expectEmit(true, false, false, true, address(m));
        emit FixedPriceMinter.PriceStrategySet(address(strategy));
        m.setPriceStrategy(address(strategy));
        assertEq(m.priceStrategy(), address(strategy));
    }

    function test_setPriceStrategy_notAContract_reverts() public {
        (, FixedPriceMinter m) = _collectionWithMinter(PRICE);
        vm.prank(artist);
        vm.expectRevert(abi.encodeWithSelector(FixedPriceMinter.NotAContract.selector, stranger));
        m.setPriceStrategy(stranger);
    }

    function test_setMintWindow_success() public {
        (, FixedPriceMinter m) = _collectionWithMinter(PRICE);
        uint64 start = uint64(block.timestamp + 1 days);
        uint64 end = uint64(block.timestamp + 2 days);
        vm.prank(artist);
        vm.expectEmit(false, false, false, true, address(m));
        emit FixedPriceMinter.MintWindowSet(start, end);
        m.setMintWindow(start, end);
        assertEq(m.mintStart(), start);
        assertEq(m.mintEnd(), end);
    }

    function test_setMintWindow_badWindow_reverts() public {
        (, FixedPriceMinter m) = _collectionWithMinter(PRICE);
        vm.prank(artist);
        vm.expectRevert(FixedPriceMinter.BadMintWindow.selector);
        m.setMintWindow(100, 100);
    }

    function test_setPayoutRecipient_success() public {
        (, FixedPriceMinter m) = _collectionWithMinter(PRICE);
        address newRecipient = makeAddr("newRecipient");
        vm.prank(artist);
        vm.expectEmit(true, false, false, true, address(m));
        emit FixedPriceMinter.PayoutRecipientSet(newRecipient);
        m.setPayoutRecipient(newRecipient);
        assertEq(m.payoutRecipient(), newRecipient);
    }

    /// @dev The new recipient is credited on the NEXT mint, proving the
    ///      change actually takes effect on settlement, not just storage.
    function test_setPayoutRecipient_ownerChange_takesEffectOnNextMint() public {
        (, FixedPriceMinter m) = _collectionWithMinter(PRICE);
        address newRecipient = makeAddr("newRecipient");
        vm.prank(artist);
        m.setPayoutRecipient(newRecipient);

        vm.deal(collector, PRICE);
        vm.prank(collector);
        m.mint{value: PRICE}(collector, 1, address(0), "");
        assertEq(m.pendingWithdrawal(newRecipient), PRICE, "the new recipient is paid");
        assertEq(m.pendingWithdrawal(artist), 0, "the old recipient accrues nothing further");
    }

    /// @dev Borrowed authority (onlyCollectionOwnerOrAdmin) covers admins too, not
    ///      just the owner: a collection admin can redirect payout post-deploy.
    function test_setPayoutRecipient_grantedAdmin_takesEffectOnNextMint() public {
        (Surface c, FixedPriceMinter m) = _collectionWithMinter(PRICE);
        address admin = makeAddr("payoutAdmin");
        vm.prank(artist);
        c.addAdmin(admin);

        address newRecipient = makeAddr("adminChosenRecipient");
        vm.prank(admin);
        vm.expectEmit(true, false, false, true, address(m));
        emit FixedPriceMinter.PayoutRecipientSet(newRecipient);
        m.setPayoutRecipient(newRecipient);
        assertEq(m.payoutRecipient(), newRecipient);

        vm.deal(collector, PRICE);
        vm.prank(collector);
        m.mint{value: PRICE}(collector, 1, address(0), "");
        assertEq(m.pendingWithdrawal(newRecipient), PRICE, "the admin-chosen recipient is paid");
        assertEq(m.pendingWithdrawal(artist), 0);
    }

    function test_setPayoutRecipient_stranger_reverts() public {
        (, FixedPriceMinter m) = _collectionWithMinter(PRICE);
        vm.prank(stranger);
        vm.expectRevert(FixedPriceMinter.NotAuthorized.selector);
        m.setPayoutRecipient(makeAddr("newRecipient"));
    }

    function test_setPayoutRecipient_zero_reverts() public {
        (, FixedPriceMinter m) = _collectionWithMinter(PRICE);
        vm.prank(artist);
        vm.expectRevert(FixedPriceMinter.PayoutRecipientRequired.selector);
        m.setPayoutRecipient(address(0));
    }

    function test_setMaxMints_success() public {
        (, FixedPriceMinter m) = _collectionWithMinter(PRICE);
        vm.prank(artist);
        vm.expectEmit(false, false, false, true, address(m));
        emit FixedPriceMinter.MaxMintsSet(5);
        m.setMaxMints(5);
        assertEq(m.maxMints(), 5);
    }

    function test_setAllowlistRoot_success() public {
        (, FixedPriceMinter m) = _collectionWithMinter(PRICE);
        bytes32 root = bytes32(uint256(123));
        vm.prank(artist);
        vm.expectEmit(false, false, false, true, address(m));
        emit FixedPriceMinter.AllowlistRootSet(root);
        m.setAllowlistRoot(root);
        assertEq(m.allowlistRoot(), root);
    }

    /// @dev The 0-default is exercised elsewhere (allowlist/window tests all
    ///      leave it unset); this covers the 0-to-nonzero transition itself,
    ///      distinct from test_walletCap_loweredBelowCount_blocksFurtherMints
    ///      (nonzero-to-nonzero, mid-sale).
    function test_setWalletCap_zeroToNonzero_success() public {
        (, FixedPriceMinter m) = _collectionWithMinter(PRICE);
        assertEq(m.walletCap(), 0);
        vm.prank(artist);
        vm.expectEmit(false, false, false, true, address(m));
        emit FixedPriceMinter.WalletCapSet(3);
        m.setWalletCap(3);
        assertEq(m.walletCap(), 3);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // rescueStrayETH success path
    // ─────────────────────────────────────────────────────────────────────────

    function test_rescueStrayETH_success_sweepsOnlyStrayBalance() public {
        (, FixedPriceMinter m) = _collectionWithMinter(PRICE);
        vm.deal(collector, PRICE);
        vm.prank(collector);
        m.mint{value: PRICE}(collector, 1, address(0), ""); // artist owed PRICE, held in _pending

        uint256 strayAmount = 0.3 ether;
        // Forced ETH (e.g. selfdestruct), not routed through mint/_settle.
        vm.deal(address(m), address(m).balance + strayAmount);

        address rescueTo = makeAddr("rescueTo");
        vm.prank(artist);
        vm.expectEmit(true, false, false, true, address(m));
        emit FixedPriceMinter.StrayETHRescued(rescueTo, strayAmount);
        m.rescueStrayETH(rescueTo);

        assertEq(rescueTo.balance, strayAmount, "only the stray balance is swept");
        assertEq(m.pendingWithdrawal(artist), PRICE, "owed _pending balance is untouched");
        assertEq(address(m).balance, PRICE, "minter retains exactly the owed balance");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ZeroQuantity at the minter layer + priceOf, fixed-price branch
    // ─────────────────────────────────────────────────────────────────────────

    function test_mint_zeroQuantity_reverts() public {
        (, FixedPriceMinter m) = _collectionWithMinter(PRICE);
        vm.prank(collector);
        vm.expectRevert(IMinter.ZeroQuantity.selector);
        m.mint(collector, 0, address(0), "");
    }

    function test_priceOf_fixedPriceBranch() public {
        (, FixedPriceMinter m) = _collectionWithMinter(PRICE);
        assertEq(m.priceOf(collector, 1, ""), PRICE, "single unit");
        assertEq(m.priceOf(collector, 3, ""), PRICE * 3, "scales with quantity");
    }
}
