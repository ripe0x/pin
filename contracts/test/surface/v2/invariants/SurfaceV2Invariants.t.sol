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
}
