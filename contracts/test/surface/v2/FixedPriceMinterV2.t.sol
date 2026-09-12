// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {FactoryMinterV2Base} from "./FactoryMinterV2Base.sol";
import {
    FixedPriceMinterV2,
    FixedPriceMinterV2InitParams
} from "../../../src/surface/v2/minters/FixedPriceMinterV2.sol";
import {IMinter} from "../../../src/surface/interfaces/IMinter.sol";
import {ISurfaceV2} from "../../../src/surface/v2/interfaces/ISurfaceV2.sol";
import {SurfaceV2} from "../../../src/surface/v2/SurfaceV2.sol";

import {RevertingReceiverV2} from "./mocks/FactoryMinterV2Mocks.sol";

/// @notice FixedPriceMinterV2 coverage, ported from v1's FixedPriceMinter.t.sol
///         with every priceStrategy path dropped: v2 is exact-payment fixed
///         price only, and referralShareBps initializes to 0 instead of the
///         v1 max default.
contract FixedPriceMinterV2Test is FactoryMinterV2Base {
    uint256 internal constant PRICE = 0.01 ether;

    // ─────────────────────────────────────────────────────────────────────────
    // Happy paths
    // ─────────────────────────────────────────────────────────────────────────

    function test_fixedPriceMint_exact_noReferrer() public {
        (SurfaceV2 c, FixedPriceMinterV2 m) = _collectionWithMinter(PRICE);
        vm.deal(collector, PRICE);
        vm.prank(collector);
        m.mint{value: PRICE}(collector, 1, address(0), "");

        assertEq(c.ownerOf(1), collector);
        assertEq(m.pendingWithdrawal(artist), PRICE, "full price accrues to artist with no referrer");
        assertEq(m.pendingWithdrawal(collector), 0);
    }

    /// @dev Referral defaults to 0, so a referrer supplied on a fresh clone
    ///      accrues nothing: the whole amount goes to the artist until the
    ///      owner/admin explicitly raises referralShareBps.
    function test_fixedPriceMint_withReferrer_defaultsToNoCut() public {
        (, FixedPriceMinterV2 m) = _collectionWithMinter(PRICE);
        vm.deal(collector, PRICE);
        vm.prank(collector);
        m.mint{value: PRICE}(collector, 1, referrer, "");

        assertEq(m.referralShareBps(), 0, "referral share initializes to 0");
        assertEq(m.pendingWithdrawal(referrer), 0, "no referral cut at the default 0 bps");
        assertEq(m.pendingWithdrawal(artist), PRICE, "full amount accrues to the artist");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // mint(uint256): ergonomic overload, mints to msg.sender, no referrer
    // ─────────────────────────────────────────────────────────────────────────

    function test_mintQuantityOverload_mintsToCallerWithNoReferrer() public {
        (SurfaceV2 c, FixedPriceMinterV2 m) = _collectionWithMinter(PRICE);
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
        (, FixedPriceMinterV2 m4) = _collectionWithMinter(PRICE);
        (, FixedPriceMinterV2 mOverload) = _collectionWithMinter(PRICE);

        vm.deal(collector, PRICE * 2);
        vm.prank(collector);
        m4.mint{value: PRICE}(collector, 1, address(0), "");
        vm.prank(collector);
        mOverload.mint{value: PRICE}(1);

        assertEq(m4.pendingWithdrawal(artist), mOverload.pendingWithdrawal(artist), "identical artist accrual");
        assertEq(m4.totalMinted(), mOverload.totalMinted(), "identical totalMinted bookkeeping");
    }

    function test_mintQuantityOverload_wrongPaymentReverts() public {
        (, FixedPriceMinterV2 m) = _collectionWithMinter(PRICE);
        vm.deal(collector, PRICE);
        vm.expectRevert(abi.encodeWithSelector(IMinter.WrongPayment.selector, PRICE, PRICE - 1));
        vm.prank(collector);
        m.mint{value: PRICE - 1}(1);
    }

    /// @dev The factory default (unset SaleConfig.payoutRecipient resolves to
    ///      the deploy-time `owner` argument) is covered end-to-end in
    ///      SurfaceFactoryV2.t.sol's test_factoryDefaultsPayoutRecipientToDeployOwner.
    ///      Ownership transfer after deploy must NOT move the payout: it is a
    ///      stored value, not a live owner() read.
    function test_ownershipTransfer_doesNotMovePayoutRecipient() public {
        (SurfaceV2 c, FixedPriceMinterV2 m) = _collectionWithMinter(PRICE);
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
        FixedPriceMinterV2InitParams memory p = _minterParams(address(0), PRICE);
        p.payoutRecipient = payoutAddr;
        (, FixedPriceMinterV2 m) = _collectionWithConfiguredMinter(p);

        vm.deal(collector, PRICE);
        vm.prank(collector);
        m.mint{value: PRICE}(collector, 1, address(0), "");
        assertEq(m.pendingWithdrawal(payoutAddr), PRICE);
        assertEq(m.pendingWithdrawal(artist), 0);
    }

    /// @dev Price 0 is legal config, not a free-mint special case. The
    ///      exact-match check still applies (msg.value must be exactly 0);
    ///      there is no owner/free-mint bypass anywhere in this contract.
    function test_zeroPriceConfig_isLegalAndStillExactMatch() public {
        (SurfaceV2 c, FixedPriceMinterV2 m) = _collectionWithMinter(0);
        vm.prank(collector);
        m.mint(collector, 1, address(0), ""); // no value sent, required == 0
        assertEq(c.ownerOf(1), collector);

        vm.deal(collector, 1);
        vm.prank(collector);
        vm.expectRevert(abi.encodeWithSelector(IMinter.WrongPayment.selector, uint256(0), uint256(1)));
        m.mint{value: 1}(collector, 1, address(0), "");
    }

    function test_batchQuantityMint() public {
        (SurfaceV2 c, FixedPriceMinterV2 m) = _collectionWithMinter(PRICE);
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
        FixedPriceMinterV2InitParams memory p = _minterParams(address(0), PRICE);
        p.mintStart = uint64(block.timestamp + 1 days);
        (, FixedPriceMinterV2 m) = _collectionWithConfiguredMinter(p);

        vm.deal(collector, PRICE);
        vm.prank(collector);
        vm.expectRevert(IMinter.MintNotStarted.selector);
        m.mint{value: PRICE}(collector, 1, address(0), "");
    }

    function test_mint_atStartBoundary_succeeds() public {
        FixedPriceMinterV2InitParams memory p = _minterParams(address(0), PRICE);
        p.mintStart = uint64(block.timestamp + 1 days);
        (, FixedPriceMinterV2 m) = _collectionWithConfiguredMinter(p);

        vm.warp(p.mintStart);
        vm.deal(collector, PRICE);
        vm.prank(collector);
        m.mint{value: PRICE}(collector, 1, address(0), "");
        assertEq(m.pendingWithdrawal(artist), PRICE);
    }

    function test_mint_afterEnd_reverts() public {
        FixedPriceMinterV2InitParams memory p = _minterParams(address(0), PRICE);
        p.mintEnd = uint64(block.timestamp + 1 days);
        (, FixedPriceMinterV2 m) = _collectionWithConfiguredMinter(p);

        vm.warp(p.mintEnd);
        vm.deal(collector, PRICE);
        vm.prank(collector);
        vm.expectRevert(IMinter.MintEnded.selector);
        m.mint{value: PRICE}(collector, 1, address(0), "");
    }

    function test_mint_justBeforeEnd_succeeds() public {
        FixedPriceMinterV2InitParams memory p = _minterParams(address(0), PRICE);
        p.mintEnd = uint64(block.timestamp + 1 days);
        (, FixedPriceMinterV2 m) = _collectionWithConfiguredMinter(p);

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
        FixedPriceMinterV2InitParams memory p = _minterParams(address(0), PRICE);
        p.maxMints = 2;
        (, FixedPriceMinterV2 m) = _collectionWithConfiguredMinter(p);

        vm.deal(collector, PRICE * 3);
        vm.prank(collector);
        m.mint{value: PRICE * 2}(collector, 2, address(0), "");

        vm.prank(collector);
        vm.expectRevert(abi.encodeWithSelector(IMinter.MaxMintsExceeded.selector, uint256(2), uint256(3)));
        m.mint{value: PRICE}(collector, 1, address(0), "");
    }

    function test_maxMints_zero_isUnlimited() public {
        (, FixedPriceMinterV2 m) = _collectionWithMinter(PRICE);
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
        FixedPriceMinterV2InitParams memory p = _minterParams(address(0), PRICE);
        p.maxMints = 7;
        (, FixedPriceMinterV2 m) = _collectionWithConfiguredMinter(p);
        assertEq(m.saleCap(), m.maxMints());
        assertEq(m.saleCap(), 7);
    }

    function test_totalMintedByThisMinter_aliasesTotalMinted() public {
        (, FixedPriceMinterV2 m) = _collectionWithMinter(PRICE);
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
        FixedPriceMinterV2InitParams memory p = _minterParams(address(0), PRICE);
        p.allowlistRoot = root;
        (, FixedPriceMinterV2 m) = _collectionWithConfiguredMinter(p);

        vm.deal(collector, PRICE);
        vm.prank(collector);
        m.mint{value: PRICE}(collector, 1, address(0), abi.encode(proof1));
        assertEq(m.pendingWithdrawal(artist), PRICE);
    }

    function test_allowlist_wrongProof_reverts() public {
        (bytes32 root,, bytes32[] memory proof2) = _twoLeafTree(collector, referrer);
        FixedPriceMinterV2InitParams memory p = _minterParams(address(0), PRICE);
        p.allowlistRoot = root;
        (, FixedPriceMinterV2 m) = _collectionWithConfiguredMinter(p);

        // proof2 is valid for `referrer`, not `collector`.
        vm.deal(collector, PRICE);
        vm.prank(collector);
        vm.expectRevert(IMinter.NotAllowlisted.selector);
        m.mint{value: PRICE}(collector, 1, address(0), abi.encode(proof2));
    }

    /// @dev The no-arg mint(quantity) overload passes empty data, so on a
    ///      gated collection it carries no proof and must revert
    ///      NotAllowlisted rather than panic on abi.decode of empty bytes.
    function test_allowlist_noArgOverload_emptyData_revertsNotAllowlisted() public {
        (bytes32 root,,) = _twoLeafTree(collector, referrer);
        FixedPriceMinterV2InitParams memory p = _minterParams(address(0), PRICE);
        p.allowlistRoot = root;
        (, FixedPriceMinterV2 m) = _collectionWithConfiguredMinter(p);

        vm.deal(collector, PRICE);
        vm.prank(collector);
        vm.expectRevert(IMinter.NotAllowlisted.selector);
        m.mint{value: PRICE}(1);
    }

    /// @dev Same clean revert on the 4-arg entrypoint when data is empty on a
    ///      gated collection (no low-level decode panic).
    function test_allowlist_emptyData_revertsNotAllowlisted() public {
        (bytes32 root,,) = _twoLeafTree(collector, referrer);
        FixedPriceMinterV2InitParams memory p = _minterParams(address(0), PRICE);
        p.allowlistRoot = root;
        (, FixedPriceMinterV2 m) = _collectionWithConfiguredMinter(p);

        vm.deal(collector, PRICE);
        vm.prank(collector);
        vm.expectRevert(IMinter.NotAllowlisted.selector);
        m.mint{value: PRICE}(collector, 1, address(0), "");
    }

    /// @dev The gate evaluates `to`, not the payer: stranger pays, gifting to
    ///      the allowlisted `collector`, and the mint succeeds. The reverse
    ///      (stranger minting to itself) still fails even though stranger is
    ///      the one paying and holds a proof for `collector`.
    function test_allowlist_payerNotRecipient_gateEvaluatesRecipient() public {
        (bytes32 root, bytes32[] memory proof1,) = _twoLeafTree(collector, referrer);
        FixedPriceMinterV2InitParams memory p = _minterParams(address(0), PRICE);
        p.allowlistRoot = root;
        (SurfaceV2 c, FixedPriceMinterV2 m) = _collectionWithConfiguredMinter(p);

        vm.deal(stranger, PRICE);
        vm.prank(stranger);
        m.mint{value: PRICE}(collector, 1, address(0), abi.encode(proof1));
        assertEq(c.ownerOf(1), collector, "recipient is the gifted allowlisted address");

        vm.deal(stranger, PRICE);
        vm.prank(stranger);
        vm.expectRevert(IMinter.NotAllowlisted.selector);
        m.mint{value: PRICE}(stranger, 1, address(0), abi.encode(proof1));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Wallet cap
    // ─────────────────────────────────────────────────────────────────────────

    function test_walletCap_enforced() public {
        FixedPriceMinterV2InitParams memory p = _minterParams(address(0), PRICE);
        p.walletCap = 2;
        (, FixedPriceMinterV2 m) = _collectionWithConfiguredMinter(p);

        vm.deal(collector, PRICE * 3);
        vm.prank(collector);
        m.mint{value: PRICE * 2}(collector, 2, address(0), "");

        vm.prank(collector);
        vm.expectRevert(abi.encodeWithSelector(IMinter.WalletCapExceeded.selector, uint256(2), uint256(3)));
        m.mint{value: PRICE}(collector, 1, address(0), "");
    }

    /// @dev A reverted attempt must not count toward the cap.
    function test_walletCap_countsAfterSuccess() public {
        FixedPriceMinterV2InitParams memory p = _minterParams(address(0), PRICE);
        p.walletCap = 1;
        (, FixedPriceMinterV2 m) = _collectionWithConfiguredMinter(p);

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
        FixedPriceMinterV2InitParams memory p = _minterParams(address(0), PRICE);
        p.walletCap = 5;
        (, FixedPriceMinterV2 m) = _collectionWithConfiguredMinter(p);

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
        FixedPriceMinterV2InitParams memory p = _minterParams(address(0), PRICE);
        p.allowlistRoot = root;
        p.walletCap = 1;
        (, FixedPriceMinterV2 m) = _collectionWithConfiguredMinter(p);

        vm.deal(collector, PRICE * 2);
        vm.prank(collector);
        m.mint{value: PRICE}(collector, 1, address(0), abi.encode(proof1));

        vm.prank(collector);
        vm.expectRevert(abi.encodeWithSelector(IMinter.WalletCapExceeded.selector, uint256(1), uint256(2)));
        m.mint{value: PRICE}(collector, 1, address(0), abi.encode(proof1));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Exact-match violations
    // ─────────────────────────────────────────────────────────────────────────

    function test_fixedPrice_overpayment_reverts() public {
        (, FixedPriceMinterV2 m) = _collectionWithMinter(PRICE);
        vm.deal(collector, PRICE + 1);
        vm.prank(collector);
        vm.expectRevert(abi.encodeWithSelector(IMinter.WrongPayment.selector, PRICE, PRICE + 1));
        m.mint{value: PRICE + 1}(collector, 1, address(0), "");
    }

    function test_fixedPrice_underpayment_reverts() public {
        (, FixedPriceMinterV2 m) = _collectionWithMinter(PRICE);
        vm.deal(collector, PRICE - 1);
        vm.prank(collector);
        vm.expectRevert(abi.encodeWithSelector(IMinter.WrongPayment.selector, PRICE, PRICE - 1));
        m.mint{value: PRICE - 1}(collector, 1, address(0), "");
    }

    function test_fixedPrice_batchOverpayment_reverts() public {
        (, FixedPriceMinterV2 m) = _collectionWithMinter(PRICE);
        uint256 qty = 3;
        vm.deal(collector, PRICE * qty + 1);
        vm.prank(collector);
        vm.expectRevert(abi.encodeWithSelector(IMinter.WrongPayment.selector, PRICE * qty, PRICE * qty + 1));
        m.mint{value: PRICE * qty + 1}(collector, qty, address(0), "");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Withdraw flows
    // ─────────────────────────────────────────────────────────────────────────

    function test_withdraw_anyoneCanTrigger() public {
        (, FixedPriceMinterV2 m) = _collectionWithMinter(PRICE);
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
        (, FixedPriceMinterV2 m) = _collectionWithMinter(PRICE);
        vm.deal(collector, PRICE);
        vm.prank(collector);
        m.mint{value: PRICE}(collector, 1, address(0), "");

        uint256 strangerBefore = stranger.balance;
        m.withdraw(artist); // funds go to `artist`, regardless of caller
        assertEq(stranger.balance, strangerBefore, "withdraw(artist) must not pay the caller");
    }

    function test_withdraw_zeroBalance_reverts() public {
        (, FixedPriceMinterV2 m) = _collectionWithMinter(PRICE);
        vm.expectRevert(FixedPriceMinterV2.NothingToWithdraw.selector);
        m.withdraw(stranger);
    }

    function test_withdraw_zeroAccount_reverts() public {
        (, FixedPriceMinterV2 m) = _collectionWithMinter(PRICE);
        vm.expectRevert(FixedPriceMinterV2.ZeroAccount.selector);
        m.withdraw(address(0));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Reverting recipient: pull payment isolation
    // ─────────────────────────────────────────────────────────────────────────

    function test_revertingRecipient_cannotBlockMint_butItsOwnWithdrawFails() public {
        RevertingReceiverV2 bad = new RevertingReceiverV2();
        FixedPriceMinterV2InitParams memory p = _minterParams(address(0), PRICE);
        p.payoutRecipient = address(bad);
        (, FixedPriceMinterV2 m) = _collectionWithConfiguredMinter(p);

        vm.deal(collector, PRICE);
        vm.prank(collector);
        m.mint{value: PRICE}(collector, 1, address(0), ""); // does not revert despite payout being hostile
        assertEq(m.pendingWithdrawal(address(bad)), PRICE);

        vm.expectRevert(FixedPriceMinterV2.WithdrawFailed.selector);
        m.withdraw(address(bad));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Unauthorized config setters
    // ─────────────────────────────────────────────────────────────────────────

    function test_unauthorizedConfigSetters_revert() public {
        (, FixedPriceMinterV2 m) = _collectionWithMinter(PRICE);

        vm.startPrank(stranger);
        vm.expectRevert(FixedPriceMinterV2.NotAuthorized.selector);
        m.setPrice(1);
        vm.expectRevert(FixedPriceMinterV2.NotAuthorized.selector);
        m.setMintWindow(0, 0);
        vm.expectRevert(FixedPriceMinterV2.NotAuthorized.selector);
        m.setPayoutRecipient(stranger);
        vm.expectRevert(FixedPriceMinterV2.NotAuthorized.selector);
        m.setMaxMints(1);
        vm.expectRevert(FixedPriceMinterV2.NotAuthorized.selector);
        m.setAllowlistRoot(bytes32(uint256(1)));
        vm.expectRevert(FixedPriceMinterV2.NotAuthorized.selector);
        m.setWalletCap(1);
        vm.expectRevert(FixedPriceMinterV2.NotAuthorized.selector);
        m.setReferralShareBps(500);
        vm.expectRevert(FixedPriceMinterV2.NotAuthorized.selector);
        m.rescueStrayETH(stranger);
        vm.stopPrank();
    }

    function test_authorizedAdmin_canConfigure() public {
        (SurfaceV2 c, FixedPriceMinterV2 m) = _collectionWithMinter(PRICE);
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
        (SurfaceV2 c, FixedPriceMinterV2 m) = _collectionWithMinter(PRICE);
        vm.expectRevert();
        m.initialize(_minterParams(address(c), PRICE));
    }

    function test_initialize_zeroCollection_reverts() public {
        FixedPriceMinterV2 m = _freshMinterClone();
        vm.expectRevert(FixedPriceMinterV2.CollectionRequired.selector);
        m.initialize(_minterParams(address(0), PRICE));
    }

    function test_initialize_collectionNotContract_reverts() public {
        FixedPriceMinterV2 m = _freshMinterClone();
        vm.expectRevert(abi.encodeWithSelector(FixedPriceMinterV2.NotAContract.selector, stranger));
        m.initialize(_minterParams(stranger, PRICE));
    }

    function test_initialize_badMintWindow_reverts() public {
        SurfaceV2 c = _collection(_freeConfig());
        FixedPriceMinterV2 m = _freshMinterClone();
        FixedPriceMinterV2InitParams memory p = _minterParams(address(c), PRICE);
        p.mintStart = 100;
        p.mintEnd = 100;
        vm.expectRevert(FixedPriceMinterV2.BadMintWindow.selector);
        vm.prank(artist);
        m.initialize(p);
    }

    function test_initialize_zeroPayoutRecipient_reverts() public {
        SurfaceV2 c = _collection(_freeConfig());
        FixedPriceMinterV2 m = _freshMinterClone();
        FixedPriceMinterV2InitParams memory p = _minterParams(address(c), PRICE);
        p.payoutRecipient = address(0);
        vm.expectRevert(FixedPriceMinterV2.PayoutRecipientRequired.selector);
        vm.prank(artist);
        m.initialize(p);
    }

    function test_initialize_referralShareStartsAtZero() public {
        (, FixedPriceMinterV2 m) = _collectionWithMinter(PRICE);
        assertEq(m.referralShareBps(), 0, "referral share initializes to 0, not the cap");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Two clones, isolated balances
    // ─────────────────────────────────────────────────────────────────────────

    function test_twoClones_isolatedBalances() public {
        (, FixedPriceMinterV2 m1) = _collectionWithMinter(PRICE);
        (, FixedPriceMinterV2 m2) = _collectionWithMinter(PRICE);

        vm.deal(collector, PRICE * 2);
        vm.prank(collector);
        m1.mint{value: PRICE}(collector, 1, address(0), "");

        assertEq(address(m1).balance, PRICE);
        assertEq(address(m2).balance, 0);
        assertEq(m2.pendingWithdrawal(artist), 0);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // NotMinter
    // ─────────────────────────────────────────────────────────────────────────

    function test_mintWithoutGrantOnCollection_reverts_NotMinter() public {
        SurfaceV2 c = _collection(_freeConfig());
        FixedPriceMinterV2 m = _freshMinterClone();
        vm.prank(artist);
        m.initialize(_minterParams(address(c), PRICE)); // never granted on c

        vm.deal(collector, PRICE);
        vm.prank(collector);
        vm.expectRevert(ISurfaceV2.NotMinter.selector);
        m.mint{value: PRICE}(collector, 1, address(0), "");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Renounce: payoutRecipient is a stored value, decoupled from owner().
    // A renounced collection keeps selling and keeps paying it.
    // ─────────────────────────────────────────────────────────────────────────

    function test_renouncedCollection_stillPaysStoredRecipient() public {
        (SurfaceV2 c, FixedPriceMinterV2 m) = _collectionWithMinter(PRICE);
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
        FixedPriceMinterV2InitParams memory p = _minterParams(address(0), PRICE);
        p.payoutRecipient = payoutAddr;
        (SurfaceV2 c, FixedPriceMinterV2 m) = _collectionWithConfiguredMinter(p);
        vm.prank(artist);
        c.renounceOwnership();

        vm.deal(collector, PRICE);
        vm.prank(collector);
        m.mint{value: PRICE}(collector, 1, address(0), "");
        assertEq(c.ownerOf(1), collector);
        assertEq(m.pendingWithdrawal(payoutAddr), PRICE, "explicit payoutRecipient is unaffected by a renounced owner");
    }

    /// @dev Price 0 means _settle(0, ...) returns before touching
    ///      payoutRecipient at all, so a renounced collection with a zero
    ///      price still mints: there is no artist cut to pay.
    function test_renouncedCollection_zeroPrice_defaultPayoutRecipient_stillMints() public {
        (SurfaceV2 c, FixedPriceMinterV2 m) = _collectionWithMinter(0);
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
        (SurfaceV2 c, FixedPriceMinterV2 m) = _collectionWithMinter(PRICE);
        vm.prank(artist);
        c.renounceOwnership();

        vm.expectRevert(FixedPriceMinterV2.NotAuthorized.selector);
        m.setPayoutRecipient(makeAddr("newRecipient"));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // initialize() caller-authority gate
    // ─────────────────────────────────────────────────────────────────────────

    function test_standaloneInit_strangerCannotInitializeAgainstLiveCollection() public {
        SurfaceV2 c = _collection(_freeConfig()); // live, owned by artist
        FixedPriceMinterV2 m = _freshMinterClone();
        vm.prank(stranger);
        vm.expectRevert(FixedPriceMinterV2.NotAuthorized.selector);
        m.initialize(_minterParams(address(c), PRICE));
    }

    function test_standaloneInit_collectionOwnerCanInitialize() public {
        SurfaceV2 c = _collection(_freeConfig());
        FixedPriceMinterV2 m = _freshMinterClone();
        vm.prank(artist);
        m.initialize(_minterParams(address(c), PRICE));
        assertEq(m.collection(), address(c));
    }

    function test_standaloneInit_collectionAdminCanInitialize() public {
        SurfaceV2 c = _collection(_freeConfig());
        address admin = makeAddr("minterAdmin");
        vm.prank(artist);
        c.addAdmin(admin);

        FixedPriceMinterV2 m = _freshMinterClone();
        vm.prank(admin);
        m.initialize(_minterParams(address(c), PRICE));
        assertEq(m.collection(), address(c));
    }

    /// @dev Mirrors the token side's own implementation-cannot-be-initialized
    ///      guarantee.
    function test_confirm_minterImplCannotBeInitialized() public {
        SurfaceV2 c = _collection(_freeConfig());
        vm.expectRevert(abi.encodeWithSignature("InvalidInitialization()"));
        minterImpl.initialize(_minterParams(address(c), PRICE));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Config setter success paths
    // ─────────────────────────────────────────────────────────────────────────

    function test_setMintWindow_success() public {
        (, FixedPriceMinterV2 m) = _collectionWithMinter(PRICE);
        uint64 start = uint64(block.timestamp + 1 days);
        uint64 end = uint64(block.timestamp + 2 days);
        vm.prank(artist);
        vm.expectEmit(false, false, false, true, address(m));
        emit FixedPriceMinterV2.MintWindowSet(start, end);
        m.setMintWindow(start, end);
        assertEq(m.mintStart(), start);
        assertEq(m.mintEnd(), end);
    }

    function test_setMintWindow_badWindow_reverts() public {
        (, FixedPriceMinterV2 m) = _collectionWithMinter(PRICE);
        vm.prank(artist);
        vm.expectRevert(FixedPriceMinterV2.BadMintWindow.selector);
        m.setMintWindow(100, 100);
    }

    function test_setPayoutRecipient_success() public {
        (, FixedPriceMinterV2 m) = _collectionWithMinter(PRICE);
        address newRecipient = makeAddr("newRecipient");
        vm.prank(artist);
        vm.expectEmit(true, false, false, true, address(m));
        emit FixedPriceMinterV2.PayoutRecipientSet(newRecipient);
        m.setPayoutRecipient(newRecipient);
        assertEq(m.payoutRecipient(), newRecipient);
    }

    /// @dev The new recipient is credited on the NEXT mint, proving the
    ///      change actually takes effect on settlement, not just storage.
    function test_setPayoutRecipient_ownerChange_takesEffectOnNextMint() public {
        (, FixedPriceMinterV2 m) = _collectionWithMinter(PRICE);
        address newRecipient = makeAddr("newRecipient");
        vm.prank(artist);
        m.setPayoutRecipient(newRecipient);

        vm.deal(collector, PRICE);
        vm.prank(collector);
        m.mint{value: PRICE}(collector, 1, address(0), "");
        assertEq(m.pendingWithdrawal(newRecipient), PRICE, "the new recipient is paid");
        assertEq(m.pendingWithdrawal(artist), 0, "the old recipient accrues nothing further");
    }

    /// @dev Borrowed authority (onlyCollectionOwnerOrAdmin) covers admins
    ///      too, not just the owner: a collection admin can redirect payout
    ///      post-deploy.
    function test_setPayoutRecipient_grantedAdmin_takesEffectOnNextMint() public {
        (SurfaceV2 c, FixedPriceMinterV2 m) = _collectionWithMinter(PRICE);
        address admin = makeAddr("payoutAdmin");
        vm.prank(artist);
        c.addAdmin(admin);

        address newRecipient = makeAddr("adminChosenRecipient");
        vm.prank(admin);
        vm.expectEmit(true, false, false, true, address(m));
        emit FixedPriceMinterV2.PayoutRecipientSet(newRecipient);
        m.setPayoutRecipient(newRecipient);
        assertEq(m.payoutRecipient(), newRecipient);

        vm.deal(collector, PRICE);
        vm.prank(collector);
        m.mint{value: PRICE}(collector, 1, address(0), "");
        assertEq(m.pendingWithdrawal(newRecipient), PRICE, "the admin-chosen recipient is paid");
        assertEq(m.pendingWithdrawal(artist), 0);
    }

    function test_setPayoutRecipient_stranger_reverts() public {
        (, FixedPriceMinterV2 m) = _collectionWithMinter(PRICE);
        vm.prank(stranger);
        vm.expectRevert(FixedPriceMinterV2.NotAuthorized.selector);
        m.setPayoutRecipient(makeAddr("newRecipient"));
    }

    function test_setPayoutRecipient_zero_reverts() public {
        (, FixedPriceMinterV2 m) = _collectionWithMinter(PRICE);
        vm.prank(artist);
        vm.expectRevert(FixedPriceMinterV2.PayoutRecipientRequired.selector);
        m.setPayoutRecipient(address(0));
    }

    function test_setMaxMints_success() public {
        (, FixedPriceMinterV2 m) = _collectionWithMinter(PRICE);
        vm.prank(artist);
        vm.expectEmit(false, false, false, true, address(m));
        emit FixedPriceMinterV2.MaxMintsSet(5);
        m.setMaxMints(5);
        assertEq(m.maxMints(), 5);
    }

    function test_setAllowlistRoot_success() public {
        (, FixedPriceMinterV2 m) = _collectionWithMinter(PRICE);
        bytes32 root = bytes32(uint256(123));
        vm.prank(artist);
        vm.expectEmit(false, false, false, true, address(m));
        emit FixedPriceMinterV2.AllowlistRootSet(root);
        m.setAllowlistRoot(root);
        assertEq(m.allowlistRoot(), root);
    }

    /// @dev Covers the 0-to-nonzero transition, distinct from
    ///      test_walletCap_loweredBelowCount_blocksFurtherMints
    ///      (nonzero-to-nonzero, mid-sale).
    function test_setWalletCap_zeroToNonzero_success() public {
        (, FixedPriceMinterV2 m) = _collectionWithMinter(PRICE);
        assertEq(m.walletCap(), 0);
        vm.prank(artist);
        vm.expectEmit(false, false, false, true, address(m));
        emit FixedPriceMinterV2.WalletCapSet(3);
        m.setWalletCap(3);
        assertEq(m.walletCap(), 3);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // rescueStrayETH success path
    // ─────────────────────────────────────────────────────────────────────────

    function test_rescueStrayETH_success_sweepsOnlyStrayBalance() public {
        (, FixedPriceMinterV2 m) = _collectionWithMinter(PRICE);
        vm.deal(collector, PRICE);
        vm.prank(collector);
        m.mint{value: PRICE}(collector, 1, address(0), ""); // artist owed PRICE, held in _pending

        uint256 strayAmount = 0.3 ether;
        // Forced ETH (e.g. selfdestruct), not routed through mint/_settle.
        vm.deal(address(m), address(m).balance + strayAmount);

        address rescueTo = makeAddr("rescueTo");
        vm.prank(artist);
        vm.expectEmit(true, false, false, true, address(m));
        emit FixedPriceMinterV2.StrayETHRescued(rescueTo, strayAmount);
        m.rescueStrayETH(rescueTo);

        assertEq(rescueTo.balance, strayAmount, "only the stray balance is swept");
        assertEq(m.pendingWithdrawal(artist), PRICE, "owed _pending balance is untouched");
        assertEq(address(m).balance, PRICE, "minter retains exactly the owed balance");
    }

    function test_rescueStrayETH_noStray_reverts() public {
        (, FixedPriceMinterV2 m) = _collectionWithMinter(PRICE);
        vm.prank(artist);
        vm.expectRevert(FixedPriceMinterV2.NoStrayETH.selector);
        m.rescueStrayETH(makeAddr("rescueTo"));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ZeroQuantity + priceOf
    // ─────────────────────────────────────────────────────────────────────────

    function test_mint_zeroQuantity_reverts() public {
        (, FixedPriceMinterV2 m) = _collectionWithMinter(PRICE);
        vm.prank(collector);
        vm.expectRevert(IMinter.ZeroQuantity.selector);
        m.mint(collector, 0, address(0), "");
    }

    function test_priceOf_scalesWithQuantity() public {
        (, FixedPriceMinterV2 m) = _collectionWithMinter(PRICE);
        assertEq(m.priceOf(collector, 1), PRICE, "single unit");
        assertEq(m.priceOf(collector, 3), PRICE * 3, "scales with quantity");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Referral share: 0 by default, admin-settable, capped at
    // MAX_REFERRAL_SHARE_BPS. Cut accrues and ReferralPaid emits at mint
    // time, once a nonzero share is configured.
    // ─────────────────────────────────────────────────────────────────────────

    function test_setReferralShareBps_appliesToSettle() public {
        (, FixedPriceMinterV2 m) = _collectionWithMinter(PRICE);
        vm.prank(artist);
        vm.expectEmit(false, false, false, true, address(m));
        emit FixedPriceMinterV2.ReferralShareSet(250);
        m.setReferralShareBps(250);
        assertEq(m.referralShareBps(), 250);

        uint256 refCut = (PRICE * 250) / 10_000;
        vm.deal(collector, PRICE);
        vm.prank(collector);
        vm.expectEmit(true, false, false, true, address(m));
        emit IMinter.ReferralPaid(referrer, refCut);
        m.mint{value: PRICE}(collector, 1, referrer, "");
        assertEq(m.pendingWithdrawal(referrer), refCut, "referrer accrues the set share");
        assertEq(m.pendingWithdrawal(artist), PRICE - refCut, "artist accrues the rest");
    }

    function test_setReferralShareBps_noReferrerSupplied_accruesAllToArtist() public {
        (, FixedPriceMinterV2 m) = _collectionWithMinter(PRICE);
        vm.prank(artist);
        m.setReferralShareBps(250);

        vm.deal(collector, PRICE);
        vm.prank(collector);
        m.mint{value: PRICE}(collector, 1, address(0), "");
        assertEq(m.pendingWithdrawal(artist), PRICE, "no referrer means no cut, even with a share configured");
    }

    function test_setReferralShareBps_atCap_succeeds() public {
        (, FixedPriceMinterV2 m) = _collectionWithMinter(PRICE);
        uint16 cap = m.MAX_REFERRAL_SHARE_BPS();
        vm.prank(artist);
        m.setReferralShareBps(cap);
        assertEq(m.referralShareBps(), 1000);
    }

    function test_setReferralShareBps_aboveCap_reverts() public {
        (, FixedPriceMinterV2 m) = _collectionWithMinter(PRICE);
        vm.prank(artist);
        vm.expectRevert(abi.encodeWithSelector(FixedPriceMinterV2.ReferralShareAboveCap.selector, 1001, 1000));
        m.setReferralShareBps(1001);
    }
}
