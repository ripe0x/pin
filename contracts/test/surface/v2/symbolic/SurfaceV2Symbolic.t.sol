// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Clones} from "openzeppelin-contracts/contracts/proxy/Clones.sol";

import {Surface} from "../../../../src/surface/v2/Surface.sol";
import {FixedPriceSale} from "../../../../src/surface/v2/FixedPriceSale.sol";

/// @dev Halmos cannot execute Foundry's deployCode cheat used for CREATE.
///      Etched runtime code has the empty storage of a fresh clone. Forge
///      tests separately exercise real EIP-1167 creation and wiring.
contract SymbolicSurfaceTest is Test {
    Surface internal token;
    address internal constant ARTIST = address(0xA11CE);

    function setUp() public {
        vm.etch(address(0x7101), type(Surface).runtimeCode);
        vm.etch(address(0xBEEF), hex"00");
        token = Surface(address(0x7101));
        token.initialize("", "", ARTIST, address(0xBEEF), 0, 5000, ARTIST, address(this));
    }

    function check_royaltyBound(uint16 salePrice) public view {
        (address receiver, uint256 royalty) = token.royaltyInfo(1, salePrice);
        assertEq(receiver, ARTIST);
        assertLe(royalty, uint256(salePrice) / 2);
    }

    function check_royaltyAtUint256Max() public view {
        (, uint256 royalty) = token.royaltyInfo(1, type(uint256).max);
        assertEq(royalty, type(uint256).max / 2);
    }

    function check_supplyCapFloor(uint256 minted, uint256 cap) public {
        // Surface's own _mintedEver slot is 4 (forge inspect storage-layout).
        // Store the symbolic lifetime count directly; minting a symbolic
        // quantity would make Halmos unroll an unbounded ERC-721 loop.
        vm.store(address(token), bytes32(uint256(4)), bytes32(minted));
        (,,,,, uint256 mintedEver) = token.config();
        assertEq(mintedEver, minted);
        if (cap != 0 && cap < minted) {
            vm.prank(ARTIST);
            (bool ok,) = address(token).call(abi.encodeCall(Surface.setSupplyCap, (cap)));
            assertFalse(ok);
            assertEq(token.supplyCap(), 0);
        } else {
            vm.prank(ARTIST);
            token.setSupplyCap(cap);
            assertEq(token.supplyCap(), cap);
        }
    }
}

contract SymbolicMintCollection {
    address public minter;
    uint256 public minted;

    function configure(address minter_) external {
        minter = minter_;
    }

    function owner() external pure returns (address) {
        return address(0xA11CE);
    }

    function mintTo(address, uint256 quantity) external returns (uint256 first) {
        require(msg.sender == minter);
        first = minted + 1;
        minted += quantity;
    }
}

contract SymbolicSaleTest is Test {
    FixedPriceSale internal sale;
    address internal constant ARTIST = address(0xA11CE);
    address internal constant COLLECTOR = address(0xC011EC7);
    address internal constant REFERRER = address(0x0BEEF);

    function setUp() public {
        vm.etch(address(0x7101), type(SymbolicMintCollection).runtimeCode);
        vm.etch(address(0x5A1E), type(FixedPriceSale).runtimeCode);
        SymbolicMintCollection(address(0x7101)).configure(address(0x5A1E));
        sale = FixedPriceSale(payable(address(0x5A1E)));
        sale.initialize(address(0x7101), 0, 0, 0, 0, 0, ARTIST, address(0), address(0));
    }

    /// @dev uint128 includes every realistically fundable ETH payment and
    ///      keeps the sale's paid * 500 intermediate within uint256.
    function check_referralConservesPaid(uint128 paid) public {
        vm.prank(ARTIST);
        sale.setPrice(paid);
        vm.deal(COLLECTOR, paid);
        vm.prank(COLLECTOR);
        sale.mintWithReferral{value: paid}(COLLECTOR, 1, REFERRER, "");

        uint256 referral = uint256(paid) * 500 / 10_000;
        assertEq(sale.pendingWithdrawal(REFERRER), referral);
        assertEq(sale.pendingWithdrawal(ARTIST), uint256(paid) - referral);
        assertEq(address(sale).balance, paid);
    }
}

/// @dev Pure CREATE2 namespace proof. Actual factory entrypoints are linked
///      to these salts by Forge tests in CloneFactory.t.sol.
contract SymbolicFactoryNamespaceTest {
    function check_callerNamespaces(bytes32 salt, address a, address b) public pure {
        if (a == b) return;
        address implementation = address(0x7101);
        address factory = address(0xFAC7);
        bytes32 deterministicA = keccak256(abi.encode(a, salt));
        bytes32 deterministicB = keccak256(abi.encode(b, salt));
        bytes32 createA = keccak256(abi.encode(a, "create", uint256(0)));
        bytes32 createB = keccak256(abi.encode(b, "create", uint256(0)));
        assert(
            Clones.predictDeterministicAddress(implementation, deterministicA, factory)
                != Clones.predictDeterministicAddress(implementation, deterministicB, factory)
        );
        assert(
            Clones.predictDeterministicAddress(implementation, createA, factory)
                != Clones.predictDeterministicAddress(implementation, createB, factory)
        );
        assert(
            Clones.predictDeterministicAddress(implementation, deterministicA, factory)
                != Clones.predictDeterministicAddress(implementation, createB, factory)
        );
        assert(
            Clones.predictDeterministicAddress(implementation, createA, factory)
                != Clones.predictDeterministicAddress(implementation, deterministicB, factory)
        );
    }
}
