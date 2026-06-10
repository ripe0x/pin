// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "openzeppelin-contracts/contracts/token/ERC721/ERC721.sol";
import {ERC721Burnable} from
    "openzeppelin-contracts/contracts/token/ERC721/extensions/ERC721Burnable.sol";

import {Release} from "../../src/releases/Release.sol";
import {IReleaseRenderer} from "../../src/releases/IReleaseRenderer.sol";

/// @notice Burnable ERC721 gate: the well-behaved BURN-gate case (de-facto
///         burn(uint256), owner-or-approved). MockERC721 at test root covers
///         the HOLD case and the BURN-gate-without-burn failure case.
contract BurnableGate is ERC721, ERC721Burnable {
    constructor() ERC721("Burnable Gate", "BGATE") {}

    function mint(address to, uint256 tokenId) external {
        _mint(to, tokenId);
    }
}

/// @notice A renderer that proves the tokenURI override path.
contract StaticRenderer is IReleaseRenderer {
    function tokenURI(uint256 tokenId) external pure returns (string memory) {
        return string.concat("rendered:", _toString(tokenId));
    }

    function _toString(uint256 v) private pure returns (string memory s) {
        if (v == 0) return "0";
        uint256 t = v;
        uint256 len;
        while (t != 0) {
            len++;
            t /= 10;
        }
        bytes memory b = new bytes(len);
        while (v != 0) {
            len--;
            b[len] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
        s = string(b);
    }
}

/// @notice A payout that tries to drain by reentering withdraw() from its
///         receive(). The balance is zeroed before the send, so the inner
///         call reverts ("nothing to withdraw") and is swallowed here —
///         the test asserts a single payment happened.
contract GreedyPayout {
    Release public release;
    uint256 public received;
    uint256 public reentries;

    function setRelease(Release release_) external {
        release = release_;
    }

    receive() external payable {
        received += msg.value;
        if (reentries == 0) {
            reentries++;
            try release.withdraw() {} catch {}
        }
    }
}

/// @notice A surface that tries to drain by reentering claimSurfaceFees()
///         from its receive(). Same zero-before-send story.
contract GreedySurface {
    Release public release;
    uint256 public received;
    uint256 public reentries;

    function setRelease(Release release_) external {
        release = release_;
    }

    receive() external payable {
        received += msg.value;
        if (reentries == 0) {
            reentries++;
            try release.claimSurfaceFees(address(this)) {} catch {}
        }
    }
}

/// @notice A malicious BURN gate: lies about ownership and reenters
///         mintGated from inside burn(). Exists to prove the documented
///         trust boundary — a hostile gate can corrupt its own release's
///         gating (mint extra gated tokens) but can never touch funds
///         accounting or any other contract.
contract LyingGate {
    Release public target;
    mapping(uint256 => address) public claimedOwners;
    bool public reentered;

    function setTarget(Release target_) external {
        target = target_;
    }

    function setClaimedOwner(uint256 id, address who) external {
        claimedOwners[id] = who;
    }

    function ownerOf(uint256 id) external view returns (address) {
        return claimedOwners[id];
    }

    function burn(uint256) external {
        if (!reentered && address(target) != address(0)) {
            reentered = true;
            uint256[] memory ids = new uint256[](1);
            ids[0] = 999;
            // Free release: the reentrant call needs no value.
            target.mintGated(address(this), ids, address(0));
        }
    }
}
