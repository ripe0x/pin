// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {Surface} from "../../../src/surface/v2/Surface.sol";
import {FixedPriceSale} from "../../../src/surface/v2/FixedPriceSale.sol";
import {AllowlistGate} from "../../../src/surface/v2/AllowlistGate.sol";
import {CloneFactory} from "../../../src/surface/v2/CloneFactory.sol";
import {Launcher} from "../../../src/surface/v2/Launcher.sol";

/// @dev EIP-170 gate for every v2 implementation. Foundry's test EVM does not
///      enforce the 24,576-byte limit, so this is the only check before a
///      broadcast. Same 1,000-byte standing headroom as the v1 gate: audit
///      remediations only ever add bytes.
contract SurfaceV2SizeTest is Test {
    uint256 internal constant EIP170_LIMIT = 24_576;
    uint256 internal constant GATE = 23_576;

    function _check(string memory label, address impl) internal {
        uint256 size = impl.code.length;
        emit log_named_uint(string.concat(label, " deployed bytecode size"), size);
        assertLe(size, GATE, string.concat(label, " exceeds the size gate"));
    }

    function test_surface() public {
        _check("Surface", address(new Surface()));
    }

    function test_fixedPriceSale() public {
        _check("FixedPriceSale", address(new FixedPriceSale()));
    }

    function test_allowlistGate() public {
        _check("AllowlistGate", address(new AllowlistGate()));
    }

    function test_cloneFactory() public {
        _check("CloneFactory", address(new CloneFactory(address(new Surface()))));
    }

    function test_launcher() public {
        CloneFactory f = new CloneFactory(address(new Surface()));
        _check("Launcher", address(new Launcher(f, f, address(0), address(this))));
    }
}
