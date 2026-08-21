// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AntonScriptStore} from "../../../src/surface/works/anton/AntonScriptStore.sol";

contract AntonScriptStoreTest is Test {
    function test_storesAndServesContent() public {
        bytes memory content = bytes("SDRzSUFB...base64-of-gzipped-script...");
        AntonScriptStore store = new AntonScriptStore(content);
        assertEq(store.length(), content.length);
        assertEq(store.getContent("anton.js", ""), content);
        // name is ignored: one file
        assertEq(store.getContent("anything", hex"1234"), content);
        assertTrue(store.pointer().code.length > 0);
    }

    function test_largeContent() public {
        bytes memory content = new bytes(20000);
        for (uint256 i = 0; i < content.length; i++) content[i] = bytes1(uint8(65 + (i % 26)));
        AntonScriptStore store = new AntonScriptStore(content);
        assertEq(store.getContent("", ""), content);
    }
}
