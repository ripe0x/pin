// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";
import {Ownable2Step} from "openzeppelin-contracts/contracts/access/Ownable2Step.sol";

import {ReleaseParams} from "./IRelease.sol";
import {Release} from "./Release.sol";

/// @title ReleaseFactory
/// @notice Deploys full Release contracts — not clones, not proxies. Each
///         release is a complete contract owned by its artist from
///         construction; this factory is discovery + deployment + the fee
///         constant, never a custodian. It holds no funds, sits between no
///         one, and cannot touch a deployed release. If this factory (and
///         every PND frontend) vanished, every release keeps minting,
///         paying its artist, and serving metadata.
///
/// @dev    The one admin lever in the protocol: the owner may move the
///         per-token surface fee under an immutable hard cap baked in at
///         construction. Each release snapshots the fee at creation,
///         immutably — a fee change never reaches an existing release. A
///         wei-denominated constant ages with the ETH price; one bounded
///         knob beats redeploying the factory (and fragmenting discovery)
///         every time the number stales.
contract ReleaseFactory is Ownable2Step {
    /// @notice Hard ceiling on the surface fee, forever, in bytecode.
    uint256 public immutable maxSurfaceFee;

    /// @notice Current per-token surface fee, snapshotted into each new
    ///         release at creation. Never charged when a release is free
    ///         or a mint names no surface.
    uint256 public surfaceFee;

    /// @notice Reverse lookup so anyone can cheaply ask "did this factory
    ///         deploy that release?" without enumerating.
    mapping(address => bool) public isRelease;

    /// @notice All deployed releases, in order of creation.
    address[] public allReleases;

    /// @notice One per release, carrying the full initial configuration —
    ///         an indexer builds a complete record from this event alone,
    ///         with zero follow-up reads. surfaceFee is the snapshot the
    ///         release locked (0 for a free release), not the factory's
    ///         current constant.
    event ReleaseCreated(
        address indexed release,
        address indexed artist,
        uint256 surfaceFee,
        ReleaseParams params
    );

    event SurfaceFeeSet(uint256 surfaceFee);

    /// @param owner_         Controls setSurfaceFee and nothing else.
    /// @param maxSurfaceFee_ The forever cap. 0 makes the protocol
    ///                       feeless for good — a legitimate choice.
    /// @param surfaceFee_    Initial per-token fee, <= the cap.
    constructor(address owner_, uint256 maxSurfaceFee_, uint256 surfaceFee_)
        Ownable(owner_)
    {
        require(surfaceFee_ <= maxSurfaceFee_, "fee above cap");
        maxSurfaceFee = maxSurfaceFee_;
        surfaceFee = surfaceFee_;
        emit SurfaceFeeSet(surfaceFee_);
    }

    /// @notice Deploy a release owned by msg.sender (the artist — also its
    ///         permanent attribution). Anyone can call; PND curates display,
    ///         not access. Terms are validated by the Release constructor.
    function createRelease(ReleaseParams calldata params)
        external
        returns (address release)
    {
        Release r = new Release(msg.sender, surfaceFee, params);
        release = address(r);

        isRelease[release] = true;
        allReleases.push(release);

        emit ReleaseCreated(release, msg.sender, r.surfaceFee(), params);
    }

    /// @notice Move the fee for releases created from now on, under the
    ///         cap. Existing releases are untouchable by construction.
    function setSurfaceFee(uint256 surfaceFee_) external onlyOwner {
        require(surfaceFee_ <= maxSurfaceFee, "fee above cap");
        surfaceFee = surfaceFee_;
        emit SurfaceFeeSet(surfaceFee_);
    }

    /// @notice Number of releases deployed by this factory.
    function totalReleases() external view returns (uint256) {
        return allReleases.length;
    }
}
