// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {StdInvariant} from "forge-std/StdInvariant.sol";

import {SurfaceV2Base} from "../SurfaceV2Base.sol";
import {Surface} from "../../../../src/surface/v2/Surface.sol";
import {SurfaceV2Handler} from "./SurfaceV2Handler.sol";

contract SurfaceV2InvariantsTest is StdInvariant, SurfaceV2Base {
    Surface internal token;
    SurfaceV2Handler internal handler;

    function setUp() public override {
        super.setUp();
        token = _token(artist);
        handler = new SurfaceV2Handler(token, artist);
        vm.prank(artist);
        token.setMinter(address(handler));
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](10);
        selectors[0] = SurfaceV2Handler.mint.selector;
        selectors[1] = SurfaceV2Handler.probeCap.selector;
        selectors[2] = SurfaceV2Handler.burn.selector;
        selectors[3] = SurfaceV2Handler.transfer.selector;
        selectors[4] = SurfaceV2Handler.setSupplyCap.selector;
        selectors[5] = SurfaceV2Handler.setMinter.selector;
        selectors[6] = SurfaceV2Handler.setRenderer.selector;
        selectors[7] = SurfaceV2Handler.setRoyalty.selector;
        selectors[8] = SurfaceV2Handler.setName.selector;
        selectors[9] = SurfaceV2Handler.renounce.selector;
        targetSelector(StdInvariant.FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @dev Ids equal mint order and are never reused.
    function invariant_idsMonotonic() public view {
        assertFalse(handler.idReused(), "a mint did not start at mintedEver + 1");
        (,,,,, uint256 minted) = token.config();
        assertEq(minted, handler.ghostMinted());
    }

    function invariant_capNeverExceeded() public view {
        (,, uint256 cap,,, uint256 minted) = token.config();
        if (cap != 0) assertLe(minted, cap);
    }

    function invariant_totalSupply() public view {
        assertEq(token.totalSupply(), handler.ghostMinted() - handler.ghostBurned());
    }

    /// @dev Renounce is the only lock: after it, config never changes.
    function invariant_renouncedMeansFrozen() public view {
        assertFalse(handler.changedAfterRenounce(), "a setter succeeded after renounce");
        if (token.owner() == address(0)) {
            assertTrue(handler.renounced());
            assertEq(handler.configHash(), handler.frozen(), "config changed after renounce");
        }
    }

    function invariant_seedImmutable() public view {
        uint256 minted = handler.ghostMinted();
        for (uint256 id = 1; id <= minted; id++) {
            assertEq(token.tokenSeed(id), handler.seedAtMint(id));
        }
    }

    function invariant_holdsNoETH() public view {
        assertEq(address(token).balance, 0);
    }

    /// @dev Check that cap rejection, burn, and renounce actions actually
    ///      execute rather than merely appearing in the selector list.
    function test_handlerReachability() public {
        handler.mint(0, 2);
        assertEq(handler.ghostMinted(), 2);
        handler.probeCap(1);
        assertEq(handler.ghostCapRejections(), 1);
        handler.burn(1);
        assertEq(handler.ghostBurned(), 1);
        handler.renounce(0);
        assertEq(handler.ghostRenounces(), 1);
        assertEq(token.owner(), address(0));
        handler.setName(true);
        assertFalse(handler.changedAfterRenounce());
    }
}
