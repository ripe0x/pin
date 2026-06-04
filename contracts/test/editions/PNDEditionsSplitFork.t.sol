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
    function distributeETH(
        address split,
        address[] calldata accounts,
        uint32[] calldata percentAllocations,
        uint32 distributorFee,
        address distributorAddress
    ) external;
    // ERC20[] in the real ABI; an address[] is calldata-compatible and we only
    // ever pass an empty array (ETH-only withdraw).
    function withdraw(address account, uint256 withdrawETH, address[] calldata tokens) external;
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

    /// @dev Phase 1 of mint-funded permanence (docs/editions-permanence-funding.md):
    ///      a permanence-vault recipient in the payout split actually receives
    ///      its slice of every mint, withdrawable. Uses the EXACT allocations
    ///      the web helper `buildSplitArgsWithPermanence([{artist,100}],
    ///      {vault,5%})` emits: artist 950_000, vault 50_000 (sum 1e6). Proves
    ///      the contribution mechanic end-to-end against the real 0xSplits, not
    ///      just the TS allocation math (unit-tested in editions-split.test.ts).
    function test_permanenceSliceAccruesToVault() public {
        string memory rpc = vm.envOr("MAINNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            emit log("skipping permanence-slice fork test: set MAINNET_RPC_URL to run");
            return;
        }
        try vm.createSelectFork(rpc) {}
        catch {
            emit log("skipping: could not create mainnet fork");
            return;
        }
        require(SPLIT_MAIN.code.length > 0, "SplitMain not on fork");

        address vault = makeAddr("permanenceVault");

        // buildSplitArgsWithPermanence output: vault 5% (50_000), artist 95%
        // (950_000), accounts sorted ascending (0xSplits requirement).
        address[] memory accounts = new address[](2);
        uint32[] memory allocations = new uint32[](2);
        if (artist < vault) {
            accounts[0] = artist;
            allocations[0] = 950_000;
            accounts[1] = vault;
            allocations[1] = 50_000;
        } else {
            accounts[0] = vault;
            allocations[0] = 50_000;
            accounts[1] = artist;
            allocations[1] = 950_000;
        }
        address split = ISplitMain(SPLIT_MAIN).createSplit(accounts, allocations, 0, address(0));

        PNDEditions p = _deployEdition(split); // price 1 ether, payout = split

        // A direct mint (surface 0) accrues the full price to the split.
        vm.deal(collector, 1 ether);
        vm.prank(collector);
        p.mint{value: 1 ether}(1);
        assertEq(p.pendingWithdrawal(split), 1 ether);

        // Flush edition -> split, then distribute the split to its recipients.
        p.withdraw(split);
        assertEq(split.balance, 1 ether, "full price landed in the split");

        ISplitMain(SPLIT_MAIN).distributeETH(split, accounts, allocations, 0, address(0));

        // Pull each recipient's distributed ETH out of 0xSplits.
        address[] memory noTokens = new address[](0);
        uint256 vaultBefore = vault.balance;
        uint256 artistBefore = artist.balance;
        ISplitMain(SPLIT_MAIN).withdraw(vault, 1, noTokens);
        ISplitMain(SPLIT_MAIN).withdraw(artist, 1, noTokens);
        uint256 vaultGot = vault.balance - vaultBefore;
        uint256 artistGot = artist.balance - artistBefore;

        // ~5% to the permanence vault, ~95% to the artist. 0xSplits leaves ~1
        // wei of dust per hop (distribute + withdraw), so assert close, not
        // exact. The vault genuinely received its slice and could spend it.
        assertApproxEqAbs(vaultGot, 0.05 ether, 1e6, "vault received ~5%");
        assertApproxEqAbs(artistGot, 0.95 ether, 1e6, "artist received ~95%");
        assertApproxEqAbs(vaultGot + artistGot, 1 ether, 1e6, "no funds stranded");
        assertGt(vaultGot, 0, "vault slice is non-zero and withdrawable");
    }
}
