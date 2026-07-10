// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {Collection} from "../../src/collection/Collection.sol";

/// @dev EIP-170 regression gate. Foundry's test EVM does NOT enforce the
///      24,576-byte deployed-code limit, so without this assertion a
///      too-large implementation sails through CI and fails for the first
///      time at the mainnet broadcast — which is exactly what happened before
///      the 2026-07 surface reduction (26,373 bytes at optimizer runs=200,
///      discovered only by measuring).
///
///      The gate is set BELOW the hard limit on purpose: an immutable
///      implementation should carry ~1KB of standing headroom into audit,
///      because remediations only ever add bytes. If this test fails, the
///      answer is to remove surface (or move it to a companion contract),
///      not to raise the gate.
contract CollectionSizeTest is Test {
    uint256 internal constant EIP170_LIMIT = 24_576;
    uint256 internal constant GATE = 23_576; // limit minus 1,000 bytes headroom

    function test_implementationFitsUnderEip170_withHeadroom() public {
        address impl = address(new Collection());
        uint256 size = impl.code.length;
        emit log_named_uint("Collection deployed bytecode size", size);
        emit log_named_uint("EIP-170 margin", EIP170_LIMIT - size);
        assertLe(size, GATE, "Collection implementation exceeds the size gate");
    }
}
