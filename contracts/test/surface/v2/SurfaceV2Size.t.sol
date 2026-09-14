// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {SurfaceV2} from "../../../src/surface/v2/SurfaceV2.sol";
import {SurfaceFactoryV2} from "../../../src/surface/v2/SurfaceFactoryV2.sol";
import {FixedPriceMinterV2} from "../../../src/surface/v2/minters/FixedPriceMinterV2.sol";

/// @dev EIP-170 regression gate for the v2 contracts, same rationale and gate
///      as test/surface/SurfaceSize.t.sol: Foundry's test EVM does not enforce
///      the 24,576-byte deployed-code limit, so this assertion is the only
///      thing that catches an oversized implementation before the mainnet
///      broadcast. Gate set below the hard limit on purpose for standing
///      headroom into audit; the answer to a failure here is removing
///      surface, not raising the gate.
contract SurfaceV2SizeTest is Test {
    uint256 internal constant EIP170_LIMIT = 24_576;
    uint256 internal constant GATE = 23_576; // limit minus 1,000 bytes headroom

    function test_surfaceV2_fitsUnderEip170_withHeadroom() public {
        address deployed = address(new SurfaceV2());
        uint256 size = deployed.code.length;
        emit log_named_uint("SurfaceV2 deployed bytecode size", size);
        emit log_named_uint("EIP-170 margin", EIP170_LIMIT - size);
        assertLe(size, GATE, "SurfaceV2 implementation exceeds the size gate");
    }

    function test_surfaceFactoryV2_fitsUnderEip170_withHeadroom() public {
        SurfaceV2 impl = new SurfaceV2();
        FixedPriceMinterV2 minterImpl = new FixedPriceMinterV2();
        address deployed = address(new SurfaceFactoryV2(address(impl), address(minterImpl), address(0), address(0)));
        uint256 size = deployed.code.length;
        emit log_named_uint("SurfaceFactoryV2 deployed bytecode size", size);
        emit log_named_uint("EIP-170 margin", EIP170_LIMIT - size);
        assertLe(size, GATE, "SurfaceFactoryV2 exceeds the size gate");
    }
}
