// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";

import {CloneFactory} from "./CloneFactory.sol";
import {Surface} from "./Surface.sol";
import {FixedPriceSale} from "./FixedPriceSale.sol";

/// @title Launcher
/// @notice The common wiring: one call deploys a collection and its sale,
///         already pointed at each other. Holds every product default (the
///         owner as royalty and payout fallback, PND's default referrer, one
///         sale per collection). Replaceable without touching anything
///         deployed; a bespoke project calls the factories directly.
contract Launcher is Ownable {
    struct TokenParams {
        string name;
        string symbol;
        address owner;
        address renderer;
        uint256 supplyCap;
        uint16 royaltyBps;
        address royaltyReceiver; // 0 = owner
    }

    struct SaleParams {
        uint256 price;
        uint64 mintStart;
        uint64 mintEnd;
        uint256 maxMints;
        uint256 walletCap;
        address payoutRecipient; // 0 = owner
        address gate; // 0 = none
    }

    CloneFactory public immutable tokenFactory;
    CloneFactory public immutable saleFactory;

    /// @notice Copied into each sale at launch as the referrer its
    ///         `mint(quantity)` pays. Changing it affects later launches only.
    address public defaultReferrer;
    uint256 public nonce;

    error SalePredictionMismatch(address predicted, address actual);

    event DefaultReferrerSet(address indexed defaultReferrer);
    event Launched(address indexed owner, address indexed collection, address indexed sale);

    constructor(CloneFactory tokenFactory_, CloneFactory saleFactory_, address defaultReferrer_, address owner_)
        Ownable(owner_)
    {
        tokenFactory = tokenFactory_;
        saleFactory = saleFactory_;
        defaultReferrer = defaultReferrer_;
        emit DefaultReferrerSet(defaultReferrer_);
    }

    /// @notice Owner only. 0 = launcher sales pay no referral on `mint`.
    function setDefaultReferrer(address defaultReferrer_) external onlyOwner {
        defaultReferrer = defaultReferrer_;
        emit DefaultReferrerSet(defaultReferrer_);
    }

    function launch(TokenParams calldata t, SaleParams calldata s) external returns (address collection, address sale) {
        bytes32 salt = keccak256(abi.encode(msg.sender, nonce++));
        address predicted = saleFactory.predict(salt, address(this));

        // The launcher is not the owner and cannot call setMinter, so the
        // predicted sale is the token's initial minter.
        collection = tokenFactory.create(_tokenInit(t, predicted));
        // The sale's init authority check passes: the token already names it.
        sale = saleFactory.createDeterministic(salt, _saleInit(collection, t.owner, s));
        if (sale != predicted) revert SalePredictionMismatch(predicted, sale);

        emit Launched(t.owner, collection, sale);
    }

    function _tokenInit(TokenParams calldata t, address minter) internal pure returns (bytes memory) {
        return abi.encodeCall(
            Surface.initialize,
            (
                t.name,
                t.symbol,
                t.owner,
                t.renderer,
                t.supplyCap,
                t.royaltyBps,
                t.royaltyReceiver == address(0) ? t.owner : t.royaltyReceiver,
                minter
            )
        );
    }

    function _saleInit(address collection, address owner_, SaleParams calldata s) internal view returns (bytes memory) {
        return abi.encodeCall(
            FixedPriceSale.initialize,
            (
                collection,
                s.price,
                s.mintStart,
                s.mintEnd,
                s.maxMints,
                s.walletCap,
                s.payoutRecipient == address(0) ? owner_ : s.payoutRecipient,
                s.gate,
                defaultReferrer
            )
        );
    }
}
