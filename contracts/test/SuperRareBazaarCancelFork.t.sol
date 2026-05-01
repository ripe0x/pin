// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";

/// @notice Mainnet fork test pinning the exact `cancelAuction(address,uint256)`
///         shape that the web app's `buildCancelCall` emits for SuperRare V2
///         listings. The TS unit test in `cancel-calls.test.ts` proves the
///         calldata selector matches `cancelAuction(address,uint256)`; this
///         fork test confirms that selector is a live entrypoint on the
///         deployed SuperRare Bazaar (and not, say, an inadvertently renamed
///         or removed function in a future Bazaar upgrade).
///
/// Run with:
///   MAINNET_RPC_URL=... forge test \
///     --fork-url $MAINNET_RPC_URL \
///     --match-path test/SuperRareBazaarCancelFork.t.sol -vv
contract SuperRareBazaarCancelForkTest is Test {
    /// SuperRare Bazaar (verified mainnet — see packages/addresses).
    address internal constant BAZAAR =
        0x6D7c44773C52D396F43c2D511B81aa168E9a7a42;
    /// SuperRare V2 NFT (verified mainnet).
    address internal constant SR_V2_NFT =
        0xb932a70A57673d89f4acfFBE830E8ed7f75Fb9e0;

    /// @notice Skip when not running on a mainnet fork (no Bazaar code at
    ///         the expected address). Belt-and-braces: if a CI run forgets
    ///         the --fork-url flag, this test no-ops instead of failing.
    modifier requiresFork() {
        if (BAZAAR.code.length == 0) {
            vm.skip(true);
            return;
        }
        _;
    }

    /// @notice Encodes a `cancelAuction(address,uint256)` call on a token
    ///         with no active auction and asserts Bazaar reverts WITH
    ///         revert data. A revert with empty returndata would indicate
    ///         we hit a missing-function fallback (i.e. the selector is
    ///         wrong); a revert with a populated returndata buffer proves
    ///         the selector dispatched into a real function body.
    function test_Fork_CancelAuctionSelectorIsLive() public requiresFork {
        // Token id 0 has no active auction — Bazaar's cancelAuction body
        // will revert with a specific business-logic error.
        bytes memory data = abi.encodeWithSignature(
            "cancelAuction(address,uint256)",
            SR_V2_NFT,
            uint256(0)
        );

        (bool ok, bytes memory ret) = BAZAAR.call(data);
        assertFalse(ok, "cancelAuction with no auction must revert");
        assertGt(
            ret.length,
            0,
            "revert with empty data indicates the cancelAuction selector did not match a real function on Bazaar"
        );
    }

    /// @notice Belt-and-braces: encoding the same call via the high-level
    ///         signature literal must produce calldata identical to a
    ///         hand-rolled selector + abi.encode(args). This guards against
    ///         a future Solidity ABI encoding change silently shifting the
    ///         shape that the web app's `buildCancelCall` produces.
    function test_CancelAuctionCalldataIsStable() public pure {
        bytes memory hi = abi.encodeWithSignature(
            "cancelAuction(address,uint256)",
            SR_V2_NFT,
            uint256(42)
        );
        bytes4 sel = bytes4(keccak256("cancelAuction(address,uint256)"));
        bytes memory lo = abi.encodePacked(
            sel,
            abi.encode(SR_V2_NFT, uint256(42))
        );
        assertEq(keccak256(hi), keccak256(lo));
    }
}
