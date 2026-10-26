// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {Surface} from "../../../../src/surface/v2/Surface.sol";
import {ISurface} from "../../../../src/surface/v2/interfaces/ISurface.sol";
import {MockRenderer} from "../../mocks/SurfaceMocks.sol";

/// @dev Drives a token as both its owner and its minter: mints, burns,
///      transfers, every setter, and (rarely) a renounce.
contract SurfaceV2Handler is Test {
    Surface public token;
    address public owner;
    MockRenderer[2] internal renderers;
    address[3] internal holders;

    uint256 public ghostMinted;
    uint256 public ghostBurned;
    uint256 public ghostCapRejections;
    uint256 public ghostRenounces;
    bool public idReused;
    mapping(uint256 => bytes32) public seedAtMint;

    bool public renounced;
    bool public changedAfterRenounce;
    bytes32 internal frozenConfig;

    constructor(Surface token_, address owner_) {
        token = token_;
        owner = owner_;
        renderers[0] = new MockRenderer();
        renderers[1] = new MockRenderer();
        holders = [makeAddr("h0"), makeAddr("h1"), makeAddr("h2")];
    }

    function configHash() public view returns (bytes32) {
        (address r, address m, uint256 cap, uint16 bps, address recv,) = token.config();
        return keccak256(abi.encode(r, m, cap, bps, recv, token.name(), token.symbol(), token.owner()));
    }

    function mint(uint256 holderSeed, uint256 quantity) external {
        quantity = bound(quantity, 1, 5);
        if (token.minter() != address(this)) return;
        uint256 cap = token.supplyCap();
        if (cap != 0 && ghostMinted + quantity > cap) {
            vm.expectRevert(abi.encodeWithSelector(ISurface.ExceedsCap.selector, cap, ghostMinted + quantity));
            token.mintTo(holders[holderSeed % 3], quantity);
            ghostCapRejections++;
            return;
        }
        uint256 first = token.mintTo(holders[holderSeed % 3], quantity);
        if (first != ghostMinted + 1) idReused = true;
        for (uint256 i = 0; i < quantity; i++) {
            seedAtMint[first + i] = token.tokenSeed(first + i);
        }
        ghostMinted += quantity;
    }

    /// @dev Force the cap boundary without relying on random values to
    ///      select precisely the current lifetime mint count.
    function probeCap(uint256 holderSeed) external {
        if (renounced || token.minter() != address(this) || ghostMinted == 0) return;
        vm.prank(owner);
        token.setSupplyCap(ghostMinted);
        vm.expectRevert(abi.encodeWithSelector(ISurface.ExceedsCap.selector, ghostMinted, ghostMinted + 1));
        token.mintTo(holders[holderSeed % 3], 1);
        ghostCapRejections++;
    }

    function burn(uint256 idSeed) external {
        if (ghostMinted == 0) return;
        uint256 id = bound(idSeed, 1, ghostMinted);
        try token.ownerOf(id) returns (address holder) {
            vm.prank(holder);
            token.burn(id);
            ghostBurned += 1;
        } catch {}
    }

    function transfer(uint256 idSeed, uint256 toSeed) external {
        if (ghostMinted == 0) return;
        uint256 id = bound(idSeed, 1, ghostMinted);
        try token.ownerOf(id) returns (address holder) {
            vm.prank(holder);
            token.transferFrom(holder, holders[toSeed % 3], id);
        } catch {}
    }

    function _asOwner() internal returns (bool) {
        if (renounced) {
            // Every setter must refuse; try one and note any success.
            vm.prank(owner);
            try token.setMinter(address(this)) {
                changedAfterRenounce = true;
            } catch {}
            return false;
        }
        vm.prank(owner);
        return true;
    }

    function setSupplyCap(uint256 cap) external {
        cap = bound(cap, 0, ghostMinted + 20);
        if (cap != 0 && cap < ghostMinted) cap = ghostMinted;
        if (_asOwner()) token.setSupplyCap(cap);
    }

    function setMinter(bool toHandler) external {
        if (_asOwner()) token.setMinter(toHandler ? address(this) : address(0));
    }

    function setRenderer(bool which) external {
        if (_asOwner()) token.setRenderer(address(renderers[which ? 1 : 0]));
    }

    function setRoyalty(uint16 bps) external {
        bps = uint16(bound(bps, 0, 5000));
        if (_asOwner()) token.setRoyalty(bps, holders[bps % 3]);
    }

    function setName(bool which) external {
        if (_asOwner()) token.setName(which ? "A" : "B", which ? "AA" : "BB");
    }

    function renounce(uint256 chance) external {
        if (renounced || chance % 20 != 0) return;
        vm.prank(owner);
        token.renounceOwnership();
        renounced = true;
        ghostRenounces++;
        frozenConfig = configHash();
    }

    function frozen() external view returns (bytes32) {
        return frozenConfig;
    }
}
