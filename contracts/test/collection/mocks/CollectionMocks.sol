// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {IRenderer} from "../../../src/collection/interfaces/IRenderer.sol";
import {IMintHook} from "../../../src/collection/interfaces/IMintHook.sol";
import {IPriceStrategy} from "../../../src/collection/interfaces/IPriceStrategy.sol";
import {ISovereignCollection} from "../../../src/collection/interfaces/ISovereignCollection.sol";

/// @dev Deterministic renderer: returns strings derived from the collection
///      address + tokenId, so tests can assert delegation without depending
///      on any real onchain-SVG renderer.
contract MockRenderer is IRenderer {
    function tokenURI(address collection, uint256 tokenId) external pure override returns (string memory) {
        return string(
            abi.encodePacked("mock://token/", _addrStr(collection), "/", _uintStr(tokenId))
        );
    }

    function contractURI(address collection) external pure override returns (string memory) {
        return string(abi.encodePacked("mock://contract/", _addrStr(collection)));
    }

    function _uintStr(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 j = v;
        uint256 len;
        while (j != 0) {
            len++;
            j /= 10;
        }
        bytes memory b = new bytes(len);
        while (v != 0) {
            len -= 1;
            b[len] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
        return string(b);
    }

    function _addrStr(address a) internal pure returns (string memory) {
        bytes memory data = abi.encodePacked(a);
        bytes memory alphabet = "0123456789abcdef";
        bytes memory str = new bytes(2 + data.length * 2);
        str[0] = "0";
        str[1] = "x";
        for (uint256 i = 0; i < data.length; i++) {
            str[2 + i * 2] = alphabet[uint8(data[i] >> 4)];
            str[3 + i * 2] = alphabet[uint8(data[i] & 0x0f)];
        }
        return string(str);
    }
}

/// @dev Settable fixed-price strategy. Reports every call's args for assertion.
contract MockPriceStrategy is IPriceStrategy {
    uint256 public pricePerToken;

    constructor(uint256 pricePerToken_) {
        pricePerToken = pricePerToken_;
    }

    function setPrice(uint256 p) external {
        pricePerToken = p;
    }

    // NOTE: cannot record call args as mutable state because IPriceStrategy
    // declares priceOf as `view` — the compiler rejects a nonpayable override
    // of a view interface function (confirmed: this is a real, type-level
    // guarantee, not just a convention. See CollectionSecurity.t.sol for the
    // writeup). So this mock, like the real interface, is a pure view: it
    // cannot itself prove "last call args" via storage. Tests instead assert
    // forwarding through RecordingHook (which runs in the same transaction
    // and IS allowed to write storage) or through the returned price alone.
    function priceOf(address, address, uint256 quantity, bytes calldata) external view override returns (uint256) {
        return pricePerToken * quantity;
    }
}

/// @dev Demonstrates that `IPriceStrategy.priceOf` being declared `view` is
///      an enforced, compiler-level guarantee, not just a style convention:
///      a strategy that actually tries to be "malicious" by counting calls
///      and answering differently the second time cannot even compile against
///      the interface (a nonpayable override of a view interface function is
///      a solc error — see the security suite for the attempted variant and
///      writeup). The best a "malicious" strategy can do while staying a
///      valid IPriceStrategy is answer differently across DIFFERENT mint
///      calls (varying with quantity/data/block state), never within a
///      single quote-then-settle sequence, because the core reads it exactly
///      once per mint and reuses that one value for the accounting split.
///      This variant returns a quote that depends on `quantity` parity, to
///      exercise that even a quantity-adversarial strategy cannot desync
///      settlement from the amount actually paid in.
contract MaliciousPriceStrategy is IPriceStrategy {
    uint256 public immutable evenAnswerPerToken;
    uint256 public immutable oddAnswerPerToken;

    constructor(uint256 evenAnswerPerToken_, uint256 oddAnswerPerToken_) {
        evenAnswerPerToken = evenAnswerPerToken_;
        oddAnswerPerToken = oddAnswerPerToken_;
    }

    function priceOf(address, address, uint256 quantity, bytes calldata) external view override returns (uint256) {
        return (quantity % 2 == 0 ? evenAnswerPerToken : oddAnswerPerToken) * quantity;
    }
}

/// @dev Extension minter that calls mintTo / mintToAt. Stands in for a real
///      minter module (BackedMinter, PooledIdMinter, etc.) in tests.
contract MockMinter {
    function callMintTo(ISovereignCollection collection, address to, address surface, bytes calldata hookData)
        external
        returns (uint256 tokenId)
    {
        return collection.mintTo(to, surface, hookData);
    }

    function callMintToAt(
        ISovereignCollection collection,
        address to,
        uint256 tokenId,
        address surface,
        bytes calldata hookData
    ) external {
        collection.mintToAt(to, tokenId, surface, hookData);
    }

    /// @dev Burn as an authorized minter — the only path that can retire a pooled token.
    function callBurn(ISovereignCollection collection, uint256 tokenId) external {
        collection.burn(tokenId);
    }
}

/// @dev Always reverts beforeMint. Used to prove a rejecting hook blocks
///      every mint path.
contract RevertingHook is IMintHook {
    string public reason = "hook: nope";

    function setReason(string calldata r) external {
        reason = r;
    }

    function beforeMint(address, uint256, uint256, address, bytes calldata) external view override returns (bytes4) {
        revert(reason);
    }

    function afterMint(address, uint256, uint256, address, bytes calldata) external pure override {}
}

/// @dev Always returns the wrong selector (as opposed to reverting), so
///      tests can distinguish HookRejected() from a hook-thrown reason.
contract RejectingSelectorHook is IMintHook {
    function beforeMint(address, uint256, uint256, address, bytes calldata) external pure override returns (bytes4) {
        return bytes4(0xffffffff);
    }

    function afterMint(address, uint256, uint256, address, bytes calldata) external pure override {}
}

/// @dev Always accepts; a no-op pass-through hook.
contract AcceptingHook is IMintHook {
    function beforeMint(address, uint256, uint256, address, bytes calldata) external pure override returns (bytes4) {
        return IMintHook.beforeMint.selector;
    }

    function afterMint(address, uint256, uint256, address, bytes calldata) external pure override {}
}

/// @dev Records every arg passed to beforeMint/afterMint, keyed by call index,
///      so tests can assert exact forwarding on both mint paths (built-in
///      paid mints AND the extension mintTo/mintToAt paths).
contract RecordingHook is IMintHook {
    struct Call {
        address minter;
        uint256 quantity;
        uint256 firstTokenId;
        address surface;
        bytes hookData;
    }

    Call[] public beforeCalls;
    Call[] public afterCalls;

    function beforeCallCount() external view returns (uint256) {
        return beforeCalls.length;
    }

    function afterCallCount() external view returns (uint256) {
        return afterCalls.length;
    }

    function beforeMint(
        address minter,
        uint256 quantity,
        uint256 firstTokenId,
        address surface,
        bytes calldata hookData
    ) external override returns (bytes4) {
        beforeCalls.push(
            Call({minter: minter, quantity: quantity, firstTokenId: firstTokenId, surface: surface, hookData: hookData})
        );
        return IMintHook.beforeMint.selector;
    }

    function afterMint(
        address minter,
        uint256 quantity,
        uint256 firstTokenId,
        address surface,
        bytes calldata hookData
    ) external override {
        afterCalls.push(
            Call({minter: minter, quantity: quantity, firstTokenId: firstTokenId, surface: surface, hookData: hookData})
        );
    }
}

/// @dev Re-enters a mint (or withdraw) call from beforeMint/afterMint, used
///      to prove nonReentrant actually blocks reentrancy on every guarded
///      entrypoint.
contract ReenteringHook is IMintHook {
    ISovereignCollection public target;
    bool public reenterOnBefore;
    bool public reenterOnAfter;
    bool public reenterQuantityOne = true;

    function arm(ISovereignCollection target_, bool onBefore, bool onAfter) external {
        target = target_;
        reenterOnBefore = onBefore;
        reenterOnAfter = onAfter;
    }

    function beforeMint(address, uint256, uint256, address, bytes calldata) external override returns (bytes4) {
        if (reenterOnBefore) {
            target.mint{value: 0}(1);
        }
        return IMintHook.beforeMint.selector;
    }

    function afterMint(address, uint256, uint256, address, bytes calldata) external override {
        if (reenterOnAfter) {
            target.mint{value: 0}(1);
        }
    }
}

/// @dev Rejects ETH on receive(); used to prove a reverting payee cannot
///      brick minting (pull payments) and only fails their own withdraw.
///      Mirrors RevertingReceiver.sol's style but scoped to this suite so it
///      also exposes a `pull` helper mirroring the withdraw entrypoint name
///      used by SovereignCollection.
contract RevertingPayee {
    receive() external payable {
        revert("payee: nope");
    }

    function pull(ISovereignCollection collection) external {
        collection.withdraw(address(this));
    }
}

/// @dev Re-enters withdraw() from receive(), to prove withdraw's
///      nonReentrant guard blocks a classic reentrant-drain attempt.
contract ReenteringWithdrawer {
    ISovereignCollection public target;
    bool public armed;

    function arm(ISovereignCollection target_) external {
        target = target_;
        armed = true;
    }

    receive() external payable {
        if (armed) {
            armed = false; // prevent infinite loop if the guard ever failed
            target.withdraw(address(this));
        }
    }

    function pull() external {
        target.withdraw(address(this));
    }
}
