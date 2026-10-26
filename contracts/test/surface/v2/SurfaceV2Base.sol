// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC721Receiver} from "openzeppelin-contracts/contracts/token/ERC721/IERC721Receiver.sol";

import {Surface} from "../../../src/surface/v2/Surface.sol";
import {FixedPriceSale} from "../../../src/surface/v2/FixedPriceSale.sol";
import {AllowlistGate} from "../../../src/surface/v2/AllowlistGate.sol";
import {CloneFactory} from "../../../src/surface/v2/CloneFactory.sol";
import {Launcher} from "../../../src/surface/v2/Launcher.sol";
import {IGate} from "../../../src/surface/v2/interfaces/IGate.sol";
import {MockRenderer} from "../mocks/SurfaceMocks.sol";

/// @dev A gate whose answer the test sets.
contract MockGate is IGate {
    bool public answer = true;

    function setAnswer(bool a) external {
        answer = a;
    }

    function check(address, address, uint256, bytes calldata) external view returns (bool) {
        return answer;
    }
}

contract GoodReceiver is IERC721Receiver {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}

contract WrongReceiver {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return 0xdeadbeef;
    }
}

/// @dev No onERC721Received at all.
contract NoReceiver {}

/// @dev Rejects every ETH transfer.
contract RejectETH {
    receive() external payable {
        revert("no");
    }
}

/// @notice Shared fixture: the implementations, both factories (unpaused),
///         the launcher with a PND default referrer, and helpers for the
///         launcher path and the bespoke path.
abstract contract SurfaceV2Base is Test {
    Surface internal surfaceImpl;
    FixedPriceSale internal saleImpl;
    CloneFactory internal tokenFactory;
    CloneFactory internal saleFactory;
    Launcher internal launcher;
    AllowlistGate internal allowlist;
    MockRenderer internal renderer;

    address internal pnd = makeAddr("pnd");
    address internal launcherOwner = makeAddr("launcherOwner");
    address internal artist = makeAddr("artist");
    address internal collector = makeAddr("collector");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant PRICE = 0.01 ether;

    function setUp() public virtual {
        surfaceImpl = new Surface();
        saleImpl = new FixedPriceSale();
        tokenFactory = new CloneFactory(address(surfaceImpl));
        saleFactory = new CloneFactory(address(saleImpl));
        launcher = new Launcher(tokenFactory, saleFactory, pnd, launcherOwner);
        allowlist = new AllowlistGate();
        renderer = new MockRenderer();
        vm.deal(collector, 100 ether);
        vm.deal(stranger, 100 ether);
    }

    function _tokenParams() internal view returns (Launcher.TokenParams memory) {
        return Launcher.TokenParams("Surface", "SRF", artist, address(renderer), 0, 500, address(0));
    }

    function _saleParams() internal pure returns (Launcher.SaleParams memory) {
        return Launcher.SaleParams(PRICE, 0, 0, 0, 0, address(0), address(0));
    }

    function _launch() internal returns (Surface token, FixedPriceSale sale) {
        return _launch(_tokenParams(), _saleParams());
    }

    function _launch(Launcher.TokenParams memory t, Launcher.SaleParams memory s)
        internal
        returns (Surface token, FixedPriceSale sale)
    {
        (address c, address sl) = launcher.launch(t, s);
        return (Surface(c), FixedPriceSale(sl));
    }

    /// @dev A bare token through the factory with `minter_` as its minter.
    function _token(address minter_) internal returns (Surface) {
        return Surface(
            tokenFactory.create(
                abi.encodeCall(
                    Surface.initialize, ("Surface", "SRF", artist, address(renderer), 0, 500, artist, minter_)
                )
            )
        );
    }

    function _mint(FixedPriceSale sale, address to, uint256 quantity) internal {
        uint256 value = sale.price() * quantity;
        vm.prank(to);
        sale.mint{value: value}(quantity);
    }

    /// @dev OZ standard-merkle-tree leaf.
    function _leaf(address account) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(account))));
    }

    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }
}
