// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {SurfaceBase} from "./SurfaceBase.sol";
import {MockPriceStrategy, RecordingHook} from "./mocks/SurfaceMocks.sol";

import {Surface} from "../../src/surface/Surface.sol";
import {ISurfaceCore} from "../../src/surface/interfaces/ISurfaceCore.sol";
import {SurfaceConfig, SurfaceStatus} from "../../src/surface/SurfaceTypes.sol";

import {AllowlistHook} from "../../src/surface/hooks/AllowlistHook.sol";
import {PerWalletCapHook} from "../../src/surface/hooks/PerWalletCapHook.sol";

/// @dev mintFor: the paid gift-mint. Someone pays, someone else receives —
///      a gift, a hot wallet buying for a vault, a sponsor covering a
///      collector. The recipient is who hooks and the price strategy judge;
///      refunds go back to the payer; the event records the true first owner.
contract SurfaceMintForTest is SurfaceBase {
    address internal payer = makeAddr("payer");
    address internal recipient = makeAddr("recipient");

    function test_mintFor_recipientOwns_payerPays() public {
        Surface c = _collection(_pricedConfig(1 ether));
        vm.deal(payer, 1 ether);

        vm.expectEmit(true, true, false, true, address(c));
        emit ISurfaceCore.Minted(recipient, referrer, 1, 1, 0, SurfaceStatus.Open);
        vm.prank(payer);
        c.mintFor{value: 1 ether}(recipient, 1, referrer, "");

        assertEq(c.ownerOf(1), recipient, "recipient is the first owner");
        assertEq(c.balanceOf(payer), 0, "payer holds nothing");
        assertEq(payer.balance, 0, "payer paid");
        // The split is unchanged: referral share + artist remainder.
        assertEq(c.pendingWithdrawal(referrer), 0.1 ether);
        assertEq(c.pendingWithdrawal(artist), 0.9 ether);
    }

    function test_mintFor_exactPaymentRequired() public {
        Surface c = _collection(_pricedConfig(1 ether));
        vm.deal(payer, 2 ether);

        vm.expectRevert(abi.encodeWithSelector(ISurfaceCore.WrongPayment.selector, 1 ether, 2 ether));
        vm.prank(payer);
        c.mintFor{value: 2 ether}(recipient, 1, address(0), "");
    }

    function test_mintFor_zeroQuantityReverts() public {
        Surface c = _collection(_freeConfig());
        vm.expectRevert(ISurfaceCore.ZeroQuantity.selector);
        vm.prank(payer);
        c.mintFor(recipient, 0, address(0), "");
    }

    function test_mintFor_windowApplies() public {
        SurfaceConfig memory cfg;
        cfg.mintStart = uint64(block.timestamp + 100);
        Surface c = _collection(cfg);

        vm.expectRevert(ISurfaceCore.MintNotStarted.selector);
        vm.prank(payer);
        c.mintFor(recipient, 1, address(0), "");
    }

    function test_mintFor_capApplies() public {
        SurfaceConfig memory cfg;
        cfg.supplyCap = 1;
        Surface c = _collection(cfg);

        vm.prank(payer);
        c.mintFor(recipient, 1, address(0), "");
        vm.expectRevert(abi.encodeWithSelector(ISurfaceCore.ExceedsCap.selector, 1, 2));
        vm.prank(payer);
        c.mintFor(recipient, 1, address(0), "");
    }

    /// @dev With a price strategy the payment is >= and the excess accrues
    ///      back to the PAYER — the refund follows the money, not the token.
    function test_mintFor_strategyExcessRefundsToPayer() public {
        Surface c = _collection(_freeConfig());
        MockPriceStrategy strategy = new MockPriceStrategy(1 ether);
        vm.prank(artist);
        c.setPriceStrategy(address(strategy));

        vm.deal(payer, 1.5 ether);
        vm.prank(payer);
        c.mintFor{value: 1.5 ether}(recipient, 1, address(0), "");

        assertEq(c.ownerOf(1), recipient);
        assertEq(c.pendingWithdrawal(payer), 0.5 ether, "excess accrues to the payer");
        assertEq(c.pendingWithdrawal(recipient), 0, "recipient is owed nothing");
    }

    /// @dev The hook judges the RECIPIENT, exactly as the extension mintTo
    ///      path does — an allowlist gates the collector, not their payer.
    function test_mintFor_hookReceivesRecipient() public {
        Surface c = _collection(_freeConfig());
        RecordingHook hook = new RecordingHook();
        vm.prank(artist);
        c.setMintHook(address(hook));

        vm.prank(payer);
        c.mintFor(recipient, 2, referrer, bytes("gift"));

        (address judged, uint256 q, uint256 fid, address r, bytes memory data) = hook.beforeCalls(0);
        assertEq(judged, recipient, "hook judges the recipient");
        assertEq(q, 2);
        assertEq(fid, 1);
        assertEq(r, referrer);
        assertEq(data, bytes("gift"));
    }

    function test_mintFor_allowlistGatesRecipient() public {
        Surface c = _collection(_freeConfig());
        AllowlistHook allow = new AllowlistHook();
        vm.prank(artist);
        c.setMintHook(address(allow));

        // Tree contains the recipient only; the payer is NOT allowlisted.
        bytes32 leafRecipient = keccak256(bytes.concat(keccak256(abi.encode(recipient))));
        bytes32 leafOther = keccak256(bytes.concat(keccak256(abi.encode(stranger))));
        bytes32 root = leafRecipient < leafOther
            ? keccak256(abi.encodePacked(leafRecipient, leafOther))
            : keccak256(abi.encodePacked(leafOther, leafRecipient));
        vm.prank(artist);
        allow.setRoot(address(c), root);

        // The payer mints FOR the allowlisted recipient: passes.
        bytes32[] memory proofForRecipient = new bytes32[](1);
        proofForRecipient[0] = leafOther;
        vm.prank(payer);
        c.mintFor(recipient, 1, address(0), abi.encode(proofForRecipient));
        assertEq(c.ownerOf(1), recipient);

        // Minting for a non-listed recipient fails, even with that proof.
        vm.expectRevert(AllowlistHook.NotAllowlisted.selector);
        vm.prank(payer);
        c.mintFor(makeAddr("unlisted"), 1, address(0), abi.encode(proofForRecipient));
    }

    /// @dev The per-wallet cap counts the RECIPIENT: a sponsor paying for many
    ///      wallets spends each recipient's budget, never its own.
    function test_mintFor_perWalletCapCountsRecipient() public {
        Surface c = _collection(_freeConfig());
        PerWalletCapHook cap = new PerWalletCapHook();
        vm.prank(artist);
        c.setMintHook(address(cap));
        vm.prank(artist);
        cap.setCap(address(c), 1);

        vm.startPrank(payer);
        c.mintFor(recipient, 1, address(0), "");
        vm.expectRevert(abi.encodeWithSelector(PerWalletCapHook.WalletCapExceeded.selector, 1, 2));
        c.mintFor(recipient, 1, address(0), "");
        // A different recipient has its own budget — and the payer's own
        // budget is untouched by everything above.
        c.mintFor(makeAddr("recipient2"), 1, address(0), "");
        c.mintFor(payer, 1, address(0), "");
        vm.stopPrank();
    }

    function test_mintFor_zeroRecipientReverts() public {
        Surface c = _collection(_freeConfig());
        vm.expectRevert(); // OZ ERC721InvalidReceiver(address(0))
        vm.prank(payer);
        c.mintFor(address(0), 1, address(0), "");
    }
}
