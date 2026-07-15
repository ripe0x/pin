// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {ScriptyRenderer} from "../../../src/surface/templates/ScriptyRenderer.sol";
import {CodeKind, CodeRef} from "../../../src/surface/templates/CodeTypes.sol";

/// @dev Audit I-02 remediation. The core refuses a non-contract renderer at the
///      door; this pushes the same check down to the files a ScriptyRenderer
///      reads — the builder, every code/dep store, and the gunzip store when a
///      gzipped file is present. An EOA there makes tokenURI revert, and if the
///      renderer is then locked in, the break is permanent, so it is refused at
///      construction. (address(this) is a deployed contract, so it stands in
///      for a real store; `eoa` has no code.)
contract ScriptyRendererStoresTest is Test {
    address internal eoa = makeAddr("eoa");

    function _ref(address store, CodeKind kind) internal pure returns (CodeRef[] memory a) {
        a = new CodeRef[](1);
        a[0] = CodeRef({store: store, name: "sketch.js", kind: kind});
    }

    function test_ctor_rejectsEoaBuilder() public {
        CodeRef[] memory code = _ref(address(this), CodeKind.Script);
        vm.expectRevert(ScriptyRenderer.BuilderRequired.selector);
        new ScriptyRenderer(eoa, address(0), "", code, new CodeRef[](0), 1, address(0));
    }

    function test_ctor_rejectsEoaCodeStore() public {
        CodeRef[] memory code = _ref(eoa, CodeKind.Script);
        vm.expectRevert(abi.encodeWithSelector(ScriptyRenderer.StoreNotContract.selector, eoa));
        new ScriptyRenderer(address(this), address(0), "", code, new CodeRef[](0), 1, address(0));
    }

    function test_ctor_rejectsEoaDepStore() public {
        CodeRef[] memory code = _ref(address(this), CodeKind.Script);
        CodeRef[] memory deps = _ref(eoa, CodeKind.Script);
        vm.expectRevert(abi.encodeWithSelector(ScriptyRenderer.StoreNotContract.selector, eoa));
        new ScriptyRenderer(address(this), address(0), "", code, deps, 1, address(0));
    }

    function test_ctor_rejectsMissingGunzipStore_whenGzipPresent() public {
        // a gzipped dep needs the gunzip helper store; a zero/EOA one is refused
        // up front instead of bricking the build later
        CodeRef[] memory code = _ref(address(this), CodeKind.Script);
        CodeRef[] memory deps = _ref(address(this), CodeKind.ScriptGzip);
        vm.expectRevert(ScriptyRenderer.GunzipStoreRequired.selector);
        new ScriptyRenderer(address(this), address(0), "", code, deps, 1, address(0));
    }

    function test_ctor_acceptsContractStores() public {
        // builder + store are deployed contracts, no gzip so no gunzip needed
        CodeRef[] memory code = _ref(address(this), CodeKind.Script);
        ScriptyRenderer r = new ScriptyRenderer(address(this), address(0), "", code, new CodeRef[](0), 1, address(0));
        assertEq(r.injectionVersion(), 1);
    }

    function test_ctor_gzipWithContractGunzipStore_ok() public {
        CodeRef[] memory code = _ref(address(this), CodeKind.Script);
        CodeRef[] memory deps = _ref(address(this), CodeKind.ScriptGzip);
        ScriptyRenderer r =
            new ScriptyRenderer(address(this), address(this), "gunzip.js", code, deps, 1, address(0));
        assertEq(r.gunzipStore(), address(this));
    }
}
