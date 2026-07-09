// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {CollectionBase} from "./CollectionBase.sol";
import {Collection} from "../../src/collection/Collection.sol";

/// @dev Minimal view onto the live MURI protocol singleton — only the surface
///      this probe exercises.
interface IMURIProtocol {
    function registerContract(address contractAddress, address operatorAddress) external;

    function isContractOperator(address contractAddress, address operatorAddress)
        external
        view
        returns (bool);
}

/// @title MuriIntegrationForkTest
/// @notice Fork probe that resolved the one unknown behind the MURI-based
///         thumbnail design (docs/pnd-collection-thumbnails.md): how does a
///         non-Manifold `Collection` wire into the live mainnet MURI
///         singleton? Two findings, both asserted below against real MURI:
///
///         1. MURI gates `registerContract` on `isAdmin(msg.sender)` of the
///            target contract (its Manifold admin interface). Collection
///            exposes `isAdmin` from the multi-admin work, so a collection ADMIN
///            can register it — MURI needs no Manifold-specific contract TYPE.
///            But `isAdmin(owner())` is false today (the owner is an implicit,
///            unlisted admin), so the OWNER cannot register directly until
///            `isAdmin` counts the owner (one-line change; tracked in
///            docs/pnd-collection-reaudit-notes.md).
///
///         2. The MURI `operator` must be a CONTRACT: MURI calls it during
///            registration, so an EOA reverts ("call to non-contract address").
///            That is the role `MURIProtocolManifoldExtension` fills. So a
///            Collection needs a small MURI operator ADAPTER contract
///            implementing MURI's operator interface (supportsInterface +
///            isTokenOwner via ERC721 ownerOf + a permissioned forwarder for
///            initializeTokenData / addArtworkUris). Building that adapter is
///            the next work item; this test then grows into the full green path
///            register -> initializeTokenData -> getThumbnailUris.
///
///         Opt-in like the other fork suites (skips without MAINNET_RPC_URL):
///           MAINNET_RPC_URL=https://ethereum-rpc.publicnode.com \
///           forge test --match-contract MuriIntegrationFork -vvv
contract MuriIntegrationForkTest is CollectionBase {
    IMURIProtocol constant MURI = IMURIProtocol(0x0000000000C2A0B63ab4aA971B08B905E5875b01);

    address internal muriAdmin = makeAddr("muriAdmin");
    address internal operatorEOA = makeAddr("muriOperator");
    bool internal forked;

    function setUp() public override {
        string memory rpc = vm.envOr("MAINNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            emit log("skipping MURI fork probe: set MAINNET_RPC_URL to run");
            return;
        }
        try vm.createSelectFork(rpc) {
            uint256 pin = vm.envOr("FORK_BLOCK", uint256(0));
            if (pin != 0) vm.rollFork(pin);
        } catch {
            emit log("skipping: could not create mainnet fork");
            return;
        }
        forked = true;
        super.setUp(); // deploys the Collection impl + factory
    }

    /// Finding 1: MURI authorizes registration via `isAdmin(msg.sender)` on the
    /// collection. The owner is not an explicit admin (`isAdmin(owner)==false`),
    /// so even the owner is rejected today.
    function test_fork_muri_registrationGatesOnCollectionIsAdmin() public {
        if (!forked) return;
        Collection c = _collection(_freeConfig()); // owner = artist

        vm.prank(artist);
        vm.expectRevert(); // MURI rejects: c.isAdmin(artist) == false
        MURI.registerContract(address(c), operatorEOA);

        assertFalse(MURI.isContractOperator(address(c), operatorEOA), "nothing registered");
    }

    /// Finding 2: an explicit admin passes the `isAdmin` gate, but the operator
    /// must be a contract; an EOA operator reverts. Proves a MURI operator
    /// adapter contract is required for a non-Manifold Collection.
    function test_fork_muri_operatorMustBeContract() public {
        if (!forked) return;
        Collection c = _collection(_freeConfig());

        vm.prank(artist);
        c.addAdmin(muriAdmin); // now c.isAdmin(muriAdmin) == true

        vm.prank(muriAdmin);
        vm.expectRevert(); // passes the isAdmin gate, then reverts calling the EOA operator
        MURI.registerContract(address(c), operatorEOA);

        assertFalse(MURI.isContractOperator(address(c), operatorEOA), "nothing registered");
    }
}
