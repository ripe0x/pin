// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {LibString} from "solady/utils/LibString.sol";

import {CollectionBase} from "./CollectionBase.sol";
import {Collection} from "../../src/collection/Collection.sol";
import {MuriOperator} from "../../src/collection/muri/MuriOperator.sol";
import {IMURIProtocol as IMURIProtocolSlim, IMURIProtocolCreator} from "../../src/collection/muri/vendor/IMURIProtocol.sol";

/// @dev Minimal view onto the live MURI protocol singleton — only the surface
///      this probe exercises.
interface IMURIProtocol {
    function registerContract(address contractAddress, address operatorAddress) external;

    function isContractOperator(address contractAddress, address operatorAddress)
        external
        view
        returns (bool);

    function addArtworkUris(address contractAddress, uint256 tokenId, string[] calldata uris) external;

    function getThumbnailUris(address contractAddress, uint256 tokenId) external view returns (string[] memory);

    /// @dev Returns the artist + collector URIs pre-joined as one
    ///      quoted, comma-separated string (MURI embeds it in HTML).
    function getCombinedArtworkUris(address contractAddress, uint256 tokenId)
        external
        view
        returns (string memory);
}

/// @dev Stand-in for a MURI operator adapter: enough of a contract that MURI's
///      registration-time calls land somewhere real. The genuine adapter
///      (supportsInterface + isTokenOwner via ERC721 ownerOf + a permissioned
///      forwarder) is the next work item.
contract PermissiveOperatorStub {
    function supportsInterface(bytes4) external pure returns (bool) {
        return true;
    }
}

/// @title MuriIntegrationForkTest
/// @notice Fork probe that resolved the one unknown behind the MURI-based
///         thumbnail design (docs/pnd-collection-thumbnails.md): how does a
///         non-Manifold `Collection` wire into the live mainnet MURI
///         singleton? Findings, asserted below against real MURI:
///
///         1. MURI gates `registerContract` on `isAdmin(msg.sender)` of the
///            target contract (its Manifold admin interface). Collection
///            exposes `isAdmin` from the multi-admin work — and, since the
///            isAdmin(owner) honesty fix, the view counts the OWNER too, so
///            both the owner and any admin pass MURI's gate directly. MURI
///            needs no Manifold-specific contract TYPE. A stranger is
///            rejected at the gate.
///
///         2. The MURI `operator` must be a CONTRACT: MURI calls it during
///            registration, so an EOA reverts ("call to non-contract address").
///            That is the role `MURIProtocolManifoldExtension` fills — and now
///            `MuriOperator` (src/collection/muri/): supportsInterface for the
///            IMURIProtocolCreator probe, isTokenOwner via ERC721 ownerOf, and
///            an admin-gated forwarder for the one operator-only MURI call
///            (initializeTokenData). The full green path — register through
///            the real adapter → initializeTokenData → getThumbnailUris →
///            addArtworkUris as artist AND as collector — is asserted below
///            against live mainnet MURI.
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
    /// collection. A stranger fails that gate; the OWNER passes it (the
    /// isAdmin(owner) fix) and, with a contract operator, registers end-to-end.
    function test_fork_muri_registrationGatesOnCollectionIsAdmin() public {
        if (!forked) return;
        Collection c = _collection(_freeConfig()); // owner = artist
        address operator = address(new PermissiveOperatorStub());

        vm.prank(stranger);
        vm.expectRevert(); // MURI rejects: c.isAdmin(stranger) == false
        MURI.registerContract(address(c), operator);
        assertFalse(MURI.isContractOperator(address(c), operator), "nothing registered");

        vm.prank(artist);
        MURI.registerContract(address(c), operator); // owner passes the gate
        assertTrue(MURI.isContractOperator(address(c), operator), "owner registered directly");
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

    // ── the real adapter: full green path against live MURI ─────────────────

    function _minimalInitConfig(string memory thumbUri) internal pure returns (IMURIProtocolSlim.InitConfig memory cfg) {
        cfg.metadata = '{"name":"MURI probe"}';
        cfg.artwork.artistUris = new string[](1);
        cfg.artwork.artistUris[0] = "ar://artwork-primary";
        cfg.artwork.collectorUris = new string[](0);
        cfg.artwork.mimeType = "image/svg+xml";
        cfg.artwork.fileHash = "0123456789abcdef";
        cfg.thumbnail.kind = IMURIProtocolSlim.ThumbnailKind.OFF_CHAIN;
        cfg.thumbnail.offChain.uris = new string[](1);
        cfg.thumbnail.offChain.uris[0] = thumbUri;
        cfg.displayMode = IMURIProtocolSlim.DisplayMode.HTML;
        // Full artist permissions (bits 0-6) + collector add/remove (bit 8).
        cfg.permissions.flags = uint16(0x7F) | uint16(1 << 8);
    }

    /// The whole story: owner registers the collection with the REAL adapter,
    /// initializes a token's MURI data through it (MURI only accepts that
    /// call from the operator), and both write roles work against MURI
    /// directly afterward — the artist via the collection's own isAdmin, the
    /// collector via the adapter's isTokenOwner.
    function test_fork_muri_fullGreenPath_throughAdapter() public {
        if (!forked) return;
        Collection c = _collection(_freeConfig());
        MuriOperator operator = new MuriOperator(address(MURI));

        // ERC-165 exactness: MURI's registration probe passes, junk does not.
        assertTrue(operator.supportsInterface(0x01ffc9a7), "IERC165");
        assertTrue(
            operator.supportsInterface(type(IMURIProtocolCreator).interfaceId), "IMURIProtocolCreator probe"
        );
        assertFalse(operator.supportsInterface(0xffffffff), "ERC-165 sanity");

        // Register with the real adapter (owner passes MURI's isAdmin gate).
        vm.prank(artist);
        MURI.registerContract(address(c), address(operator));
        assertTrue(MURI.isContractOperator(address(c), address(operator)), "registered");

        // Mint token 1 to the collector so ownership checks have a subject.
        vm.prank(collector);
        c.mint(1);

        // A stranger cannot initialize through the adapter...
        IMURIProtocolSlim.InitConfig memory cfg = _minimalInitConfig("ar://thumb-1");
        bytes[] memory noChunks = new bytes[](0);
        string[] memory noTemplate = new string[](0);
        vm.expectRevert(MuriOperator.NotContractAdmin.selector);
        vm.prank(stranger);
        operator.initializeTokenData(address(c), 1, cfg, noChunks, noTemplate);

        // ...the owner can (adapter forwards; MURI accepts it as operator).
        vm.prank(artist);
        operator.initializeTokenData(address(c), 1, cfg, noChunks, noTemplate);
        string[] memory thumbs = MURI.getThumbnailUris(address(c), 1);
        assertEq(thumbs.length, 1);
        assertEq(thumbs[0], "ar://thumb-1", "thumbnail stored via the adapter");

        // Artist path on MURI DIRECTLY: gated by the collection's own isAdmin.
        string[] memory more = new string[](1);
        more[0] = "ar://artwork-backup";
        vm.prank(artist);
        MURI.addArtworkUris(address(c), 1, more);

        // Collector path on MURI directly: gated by the ADAPTER's isTokenOwner.
        string[] memory collectorCopy = new string[](1);
        collectorCopy[0] = "ipfs://collector-fallback";
        vm.prank(collector);
        MURI.addArtworkUris(address(c), 1, collectorCopy);

        // A stranger is neither admin nor holder.
        vm.expectRevert();
        vm.prank(stranger);
        MURI.addArtworkUris(address(c), 1, collectorCopy);

        // All three URIs live in MURI's combined view (one pre-joined string).
        string memory combined = MURI.getCombinedArtworkUris(address(c), 1);
        assertTrue(LibString.contains(combined, "ar://artwork-primary"), "primary");
        assertTrue(LibString.contains(combined, "ar://artwork-backup"), "artist backup");
        assertTrue(LibString.contains(combined, "ipfs://collector-fallback"), "collector fallback");
    }

    /// The adapter answers false (not a revert) for a token that was never
    /// minted, so MURI's admin-or-owner fallthrough stays intact.
    function test_fork_muri_adapterIsTokenOwner_unmintedIsFalse() public {
        if (!forked) return;
        Collection c = _collection(_freeConfig());
        MuriOperator operator = new MuriOperator(address(MURI));
        assertFalse(operator.isTokenOwner(address(c), collector, 999));
    }
}
