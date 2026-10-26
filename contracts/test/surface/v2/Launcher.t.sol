// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";

import {SurfaceV2Base, MockGate} from "./SurfaceV2Base.sol";
import {Surface} from "../../../src/surface/v2/Surface.sol";
import {FixedPriceSale} from "../../../src/surface/v2/FixedPriceSale.sol";
import {CloneFactory} from "../../../src/surface/v2/CloneFactory.sol";
import {Launcher} from "../../../src/surface/v2/Launcher.sol";

contract LauncherTest is SurfaceV2Base {
    function test_constructor() public view {
        assertEq(address(launcher.tokenFactory()), address(tokenFactory));
        assertEq(address(launcher.saleFactory()), address(saleFactory));
        assertEq(launcher.defaultReferrer(), pnd);
        assertEq(launcher.owner(), launcherOwner);
    }

    function test_launch_fullWiring() public {
        MockGate g = new MockGate();
        Launcher.TokenParams memory t =
            Launcher.TokenParams("Drop", "DRP", artist, address(renderer), 100, 750, makeAddr("royalties"));
        Launcher.SaleParams memory s = Launcher.SaleParams(
            1 ether, uint64(block.timestamp), uint64(block.timestamp + 1 days), 10, 2, makeAddr("payout"), address(g)
        );
        (Surface token, FixedPriceSale sale) = _launch(t, s);

        assertTrue(tokenFactory.isInstance(address(token)));
        assertTrue(saleFactory.isInstance(address(sale)));
        assertEq(token.name(), "Drop");
        assertEq(token.symbol(), "DRP");
        assertEq(token.owner(), artist);
        assertEq(token.renderer(), address(renderer));
        assertEq(token.supplyCap(), 100);
        assertEq(token.royaltyBps(), 750);
        assertEq(token.royaltyReceiver(), makeAddr("royalties"));
        assertEq(token.minter(), address(sale));

        assertEq(sale.collection(), address(token));
        assertEq(sale.price(), 1 ether);
        assertEq(sale.mintStart(), block.timestamp);
        assertEq(sale.mintEnd(), block.timestamp + 1 days);
        assertEq(sale.maxMints(), 10);
        assertEq(sale.walletCap(), 2);
        assertEq(sale.payoutRecipient(), makeAddr("payout"));
        assertEq(sale.gate(), address(g));
        assertEq(sale.defaultReferrer(), pnd);

        // The launcher holds no authority over what it launched.
        assertTrue(token.owner() != address(launcher));
    }

    function test_launch_defaultsToOwner() public {
        (Surface token, FixedPriceSale sale) = _launch();
        assertEq(token.royaltyReceiver(), artist);
        assertEq(sale.payoutRecipient(), artist);
    }

    function test_launch_deterministicSaleAddress() public {
        bytes32 salt = keccak256(abi.encode(stranger, launcher.nonce()));
        address predicted = saleFactory.predict(salt, address(launcher));
        vm.prank(stranger);
        (, address sale) = launcher.launch(_tokenParams(), _saleParams());
        assertEq(sale, predicted);
        assertEq(launcher.nonce(), 1);
    }

    function test_launch_sameCallerTwice_distinctAddresses() public {
        (Surface t1, FixedPriceSale s1) = _launch();
        (Surface t2, FixedPriceSale s2) = _launch();
        assertTrue(address(t1) != address(t2));
        assertTrue(address(s1) != address(s2));
        assertEq(t2.minter(), address(s2));
    }

    function test_launch_oneLaunchedEvent() public {
        vm.recordLogs();
        (Surface token, FixedPriceSale sale) = _launch();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 count;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(launcher) && logs[i].topics[0] == Launcher.Launched.selector) {
                count++;
                assertEq(logs[i].topics[1], bytes32(uint256(uint160(artist))));
                assertEq(logs[i].topics[2], bytes32(uint256(uint160(address(token)))));
                assertEq(logs[i].topics[3], bytes32(uint256(uint160(address(sale)))));
            }
        }
        assertEq(count, 1);
    }

    function test_launch_endToEndMintAndPayout() public {
        (Surface token, FixedPriceSale sale) = _launch();
        _mint(sale, collector, 2);
        assertEq(token.balanceOf(collector), 2);
        assertEq(sale.pendingWithdrawal(pnd), (2 * PRICE * 500) / 10_000);
        assertEq(sale.pendingWithdrawal(artist), 2 * PRICE - (2 * PRICE * 500) / 10_000);
    }

    function test_launch_revertsWhenFactoryPaused() public {
        tokenFactory.setPaused(true);
        vm.expectRevert(CloneFactory.FactoryPaused.selector);
        launcher.launch(_tokenParams(), _saleParams());
        tokenFactory.setPaused(false);
        saleFactory.setPaused(true);
        vm.expectRevert(CloneFactory.FactoryPaused.selector);
        launcher.launch(_tokenParams(), _saleParams());
    }

    function test_launch_propagatesTokenValidation() public {
        Launcher.TokenParams memory t = _tokenParams();
        t.owner = address(0);
        vm.expectRevert();
        launcher.launch(t, _saleParams());
    }

    // ─── default referrer ───────────────────────────────────────────────────

    function test_setDefaultReferrer_ownerOnly() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        launcher.setDefaultReferrer(stranger);
    }

    function test_setDefaultReferrer_affectsLaterLaunchesOnly() public {
        (, FixedPriceSale before) = _launch();
        address next = makeAddr("pndTreasury");
        vm.expectEmit(address(launcher));
        emit Launcher.DefaultReferrerSet(next);
        vm.prank(launcherOwner);
        launcher.setDefaultReferrer(next);
        (, FixedPriceSale later) = _launch();
        assertEq(before.defaultReferrer(), pnd, "existing sale keeps its copy");
        assertEq(later.defaultReferrer(), next);

        vm.prank(launcherOwner);
        launcher.setDefaultReferrer(address(0));
        (, FixedPriceSale none) = _launch();
        _mint(none, collector, 1);
        assertEq(none.pendingWithdrawal(artist), PRICE, "zero default referrer: artist keeps all");
    }

    // ─── bespoke path, no launcher ──────────────────────────────────────────

    function test_bespokePath_tokenFactoryDirect() public {
        BespokeMinter m = new BespokeMinter();
        vm.prank(artist);
        Surface token = Surface(
            tokenFactory.create(
                abi.encodeCall(
                    Surface.initialize, ("Homage", "HMG", artist, address(renderer), 0, 0, artist, address(m))
                )
            )
        );
        m.mint(token, collector, 3);
        assertEq(token.balanceOf(collector), 3);
        assertEq(token.minter(), address(m));
    }
}

/// @dev Stand-in for a bespoke minter (Homage shape): owns its own economics.
contract BespokeMinter {
    function mint(Surface token, address to, uint256 quantity) external {
        token.mintTo(to, quantity);
    }
}
