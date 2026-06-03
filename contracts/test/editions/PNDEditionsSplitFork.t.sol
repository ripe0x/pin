// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {PNDEditions} from "../../src/editions/PNDEditions.sol";
import {PNDEditionsFactory} from "../../src/editions/PNDEditionsFactory.sol";
import {PNDDefaultRenderer} from "../../src/editions/PNDDefaultRenderer.sol";
import {PNDEditionsV2Mock} from "./EditionsMocks.sol";
import {EditionConfig, EditionKind} from "../../src/editions/PNDEditionsTypes.sol";

interface ISplitMain {
    function createSplit(
        address[] calldata accounts,
        uint32[] calldata percentAllocations,
        uint32 distributorFee,
        address controller
    ) external returns (address);
}

/// @dev Fork test: a real 0xSplits split as the edition payout composes with the
///      settle-before-upgrade gate. Run against a mainnet fork:
///        MAINNET_RPC_URL=https://ethereum-rpc.publicnode.com \
///          forge test --match-contract PNDEditionsSplitFork -vv
///      Skips automatically if the fork cannot be created.
contract PNDEditionsSplitForkTest is Test {
    address constant SPLIT_MAIN = 0x2ed6c4B5dA6378c7897AC67Ba9e43102Feb694EE;

    address internal artist = makeAddr("artist");
    address internal collector = makeAddr("collector");

    function _deployEdition(address split) internal returns (PNDEditions p) {
        PNDDefaultRenderer renderer = new PNDDefaultRenderer();
        PNDEditionsFactory factory = new PNDEditionsFactory(address(new PNDEditions()), address(renderer));
        EditionConfig memory cfg;
        cfg.artworkURI = "ipfs://Qm";
        cfg.kind = EditionKind.Standalone;
        cfg.price = 1 ether;
        cfg.payoutAddress = split;
        p = PNDEditions(factory.createEdition("Collab", "CO", artist, cfg));
    }

    function _deployHalfSplit() internal returns (address) {
        address a = makeAddr("collabA");
        address b = makeAddr("collabB");
        address[] memory accounts = new address[](2);
        (accounts[0], accounts[1]) = a < b ? (a, b) : (b, a); // 0xSplits requires ascending
        uint32[] memory allocations = new uint32[](2);
        allocations[0] = 500_000;
        allocations[1] = 500_000; // sum 1e6
        return ISplitMain(SPLIT_MAIN).createSplit(accounts, allocations, 0, address(0));
    }

    function test_splitPayoutComposesWithSettleGate() public {
        // Opt-in: skip in the default (hermetic) suite; provide a mainnet RPC to
        // run, e.g. MAINNET_RPC_URL=https://ethereum-rpc.publicnode.com.
        string memory rpc = vm.envOr("MAINNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            emit log("skipping split fork test: set MAINNET_RPC_URL to run");
            return;
        }
        try vm.createSelectFork(rpc) {}
        catch {
            emit log("skipping: could not create mainnet fork");
            return;
        }
        require(SPLIT_MAIN.code.length > 0, "SplitMain not on fork");

        address split = _deployHalfSplit();
        assertGt(split.code.length, 0, "split deployed");

        PNDEditions p = _deployEdition(split);

        // A priced mint accrues the full price to the split (surface 0).
        vm.deal(collector, 1 ether);
        vm.prank(collector);
        p.mint{value: 1 ether}(1);
        assertEq(p.pendingWithdrawal(split), 1 ether);

        // Upgrade is blocked while the split is owed.
        PNDEditionsV2Mock v2 = new PNDEditionsV2Mock();
        vm.prank(artist);
        vm.expectRevert(bytes("PND: settle pending"));
        p.upgradeToAndCall(address(v2), "");

        // Flushing routes funds into the immutable 0xSplits wallet, out of the
        // artist's upgradeable edition.
        uint256 before = split.balance;
        p.withdraw(split);
        assertEq(split.balance - before, 1 ether, "funds landed in the split");
        assertEq(p.pendingWithdrawal(split), 0);

        // Nothing owed now, so the upgrade is permitted.
        vm.prank(artist);
        p.upgradeToAndCall(address(v2), "");
        assertEq(PNDEditionsV2Mock(address(p)).version(), 2);
    }
}
