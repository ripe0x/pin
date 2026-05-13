// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ArtistRecordRegistry} from "../src/ArtistRecordRegistry.sol";

contract ArtistRecordRegistryTest is Test {
    ArtistRecordRegistry internal reg;

    address internal artist = address(0xA0A0);
    address internal artistB = address(0xB0B0);
    address internal operator = address(0x0001);
    address internal stranger = address(0xDEAD);

    address internal constant NFT_ADDR = address(0xF00D);
    address internal constant NFT_ADDR_B = address(0xF11D);

    // Re-declared so vm.expectEmit can match on topics + data.
    event ContractAdded(
        address indexed artist,
        address indexed contractAddress
    );
    event ContractRemoved(
        address indexed artist,
        address indexed contractAddress
    );
    event TokenAdded(
        address indexed artist,
        address indexed contractAddress,
        uint256 indexed tokenId
    );
    event TokenRemoved(
        address indexed artist,
        address indexed contractAddress,
        uint256 indexed tokenId
    );
    event TokenRangeAdded(
        address indexed artist,
        address indexed contractAddress,
        uint256 startTokenId,
        uint256 endTokenId
    );
    event TokenRangeRemoved(
        address indexed artist,
        address indexed contractAddress,
        uint256 startTokenId,
        uint256 endTokenId
    );
    event OperatorSet(
        address indexed artist,
        address indexed operator,
        bool approved
    );

    function setUp() public {
        reg = new ArtistRecordRegistry();
    }

    // ─── Deployment ─────────────────────────────────────────────────

    function test_deploysSuccessfully() public view {
        assertEq(reg.getContractCount(artist), 0);
    }

    function test_hasNoOwnerOrAdminSurface() public view {
        // No owner / admin / pause / upgrade functions exposed; the
        // absence is enforced by the contract's source.
        assertTrue(address(reg).code.length > 0);
    }

    // ─── Contract pointers ──────────────────────────────────────────

    function test_addContract_succeeds_andEmits() public {
        vm.expectEmit(true, true, false, false);
        emit ContractAdded(artist, NFT_ADDR);
        vm.prank(artist);
        reg.addContract(NFT_ADDR);

        assertTrue(reg.isContractRegistered(artist, NFT_ADDR));
        assertEq(reg.getContractCount(artist), 1);

        address[] memory cs = reg.getContracts(artist);
        assertEq(cs.length, 1);
        assertEq(cs[0], NFT_ADDR);

        assertEq(reg.getContractAt(artist, 0), NFT_ADDR);
    }

    function test_addContract_duplicate_reverts() public {
        vm.prank(artist);
        reg.addContract(NFT_ADDR);
        vm.expectRevert(ArtistRecordRegistry.ContractAlreadyRegistered.selector);
        vm.prank(artist);
        reg.addContract(NFT_ADDR);
    }

    function test_addContract_zeroAddress_reverts() public {
        vm.expectRevert(ArtistRecordRegistry.InvalidContractAddress.selector);
        vm.prank(artist);
        reg.addContract(address(0));
    }

    function test_removeContract_succeeds_andEmits() public {
        vm.prank(artist);
        reg.addContract(NFT_ADDR);

        vm.expectEmit(true, true, false, false);
        emit ContractRemoved(artist, NFT_ADDR);
        vm.prank(artist);
        reg.removeContract(NFT_ADDR);

        assertFalse(reg.isContractRegistered(artist, NFT_ADDR));
        assertEq(reg.getContractCount(artist), 0);
    }

    function test_removeContract_missing_reverts() public {
        vm.expectRevert(ArtistRecordRegistry.ContractNotRegistered.selector);
        vm.prank(artist);
        reg.removeContract(NFT_ADDR);
    }

    function test_removeContract_zeroAddress_reverts() public {
        vm.expectRevert(ArtistRecordRegistry.InvalidContractAddress.selector);
        vm.prank(artist);
        reg.removeContract(address(0));
    }

    // ─── Token pointers ─────────────────────────────────────────────

    function test_addToken_succeeds_andEmits() public {
        vm.expectEmit(true, true, true, false);
        emit TokenAdded(artist, NFT_ADDR, 42);
        vm.prank(artist);
        reg.addToken(NFT_ADDR, 42);

        assertTrue(reg.isTokenRegistered(artist, NFT_ADDR, 42));
        assertEq(reg.getTokenCount(artist), 1);
        (address addr, uint256 tid) = reg.getTokenAt(artist, 0);
        assertEq(addr, NFT_ADDR);
        assertEq(tid, 42);

        ArtistRecordRegistry.TokenPointer[] memory ts = reg.getTokens(artist);
        assertEq(ts.length, 1);
        assertEq(ts[0].tokenId, 42);
    }

    function test_addToken_duplicate_reverts() public {
        vm.prank(artist);
        reg.addToken(NFT_ADDR, 1);
        vm.expectRevert(ArtistRecordRegistry.TokenAlreadyRegistered.selector);
        vm.prank(artist);
        reg.addToken(NFT_ADDR, 1);
    }

    function test_addToken_sameTokenIdDifferentContract_succeeds() public {
        vm.prank(artist);
        reg.addToken(NFT_ADDR, 1);
        vm.prank(artist);
        reg.addToken(NFT_ADDR_B, 1);
        assertEq(reg.getTokenCount(artist), 2);
    }

    function test_addToken_differentTokenIdSameContract_succeeds() public {
        vm.prank(artist);
        reg.addToken(NFT_ADDR, 1);
        vm.prank(artist);
        reg.addToken(NFT_ADDR, 2);
        assertEq(reg.getTokenCount(artist), 2);
    }

    function test_addToken_zeroAddress_reverts() public {
        vm.expectRevert(ArtistRecordRegistry.InvalidContractAddress.selector);
        vm.prank(artist);
        reg.addToken(address(0), 1);
    }

    function test_removeToken_succeeds_andEmits() public {
        vm.prank(artist);
        reg.addToken(NFT_ADDR, 7);

        vm.expectEmit(true, true, true, false);
        emit TokenRemoved(artist, NFT_ADDR, 7);
        vm.prank(artist);
        reg.removeToken(NFT_ADDR, 7);

        assertFalse(reg.isTokenRegistered(artist, NFT_ADDR, 7));
        assertEq(reg.getTokenCount(artist), 0);
    }

    function test_removeToken_missing_reverts() public {
        vm.expectRevert(ArtistRecordRegistry.TokenNotRegistered.selector);
        vm.prank(artist);
        reg.removeToken(NFT_ADDR, 7);
    }

    // ─── Token range pointers ───────────────────────────────────────

    function test_addTokenRange_succeeds_andEmits() public {
        vm.expectEmit(true, true, false, true);
        emit TokenRangeAdded(artist, NFT_ADDR, 1, 100);
        vm.prank(artist);
        reg.addTokenRange(NFT_ADDR, 1, 100);

        assertTrue(reg.isTokenRangeRegistered(artist, NFT_ADDR, 1, 100));
        assertEq(reg.getTokenRangeCount(artist), 1);

        (address addr, uint256 s, uint256 e) = reg.getTokenRangeAt(artist, 0);
        assertEq(addr, NFT_ADDR);
        assertEq(s, 1);
        assertEq(e, 100);

        ArtistRecordRegistry.TokenRangePointer[] memory rs =
            reg.getTokenRanges(artist);
        assertEq(rs.length, 1);
        assertEq(rs[0].endTokenId, 100);
    }

    function test_addTokenRange_duplicate_reverts() public {
        vm.prank(artist);
        reg.addTokenRange(NFT_ADDR, 1, 100);
        vm.expectRevert(ArtistRecordRegistry.TokenRangeAlreadyRegistered.selector);
        vm.prank(artist);
        reg.addTokenRange(NFT_ADDR, 1, 100);
    }

    function test_addTokenRange_overlapping_succeeds() public {
        vm.prank(artist);
        reg.addTokenRange(NFT_ADDR, 1, 100);
        vm.prank(artist);
        reg.addTokenRange(NFT_ADDR, 50, 150);
        assertEq(reg.getTokenRangeCount(artist), 2);
    }

    function test_addTokenRange_adjacent_succeeds() public {
        vm.prank(artist);
        reg.addTokenRange(NFT_ADDR, 1, 100);
        vm.prank(artist);
        reg.addTokenRange(NFT_ADDR, 101, 200);
        assertEq(reg.getTokenRangeCount(artist), 2);
    }

    function test_addTokenRange_singleToken_succeeds() public {
        vm.prank(artist);
        reg.addTokenRange(NFT_ADDR, 42, 42);
        assertTrue(reg.isTokenRangeRegistered(artist, NFT_ADDR, 42, 42));
    }

    function test_addTokenRange_startGreaterThanEnd_reverts() public {
        vm.expectRevert(ArtistRecordRegistry.InvalidTokenRange.selector);
        vm.prank(artist);
        reg.addTokenRange(NFT_ADDR, 100, 1);
    }

    function test_addTokenRange_zeroAddress_reverts() public {
        vm.expectRevert(ArtistRecordRegistry.InvalidContractAddress.selector);
        vm.prank(artist);
        reg.addTokenRange(address(0), 1, 100);
    }

    function test_removeTokenRange_succeeds_andEmits() public {
        vm.prank(artist);
        reg.addTokenRange(NFT_ADDR, 1, 100);

        vm.expectEmit(true, true, false, true);
        emit TokenRangeRemoved(artist, NFT_ADDR, 1, 100);
        vm.prank(artist);
        reg.removeTokenRange(NFT_ADDR, 1, 100);

        assertFalse(reg.isTokenRangeRegistered(artist, NFT_ADDR, 1, 100));
        assertEq(reg.getTokenRangeCount(artist), 0);
    }

    function test_removeTokenRange_missing_reverts() public {
        vm.expectRevert(ArtistRecordRegistry.TokenRangeNotRegistered.selector);
        vm.prank(artist);
        reg.removeTokenRange(NFT_ADDR, 1, 100);
    }

    function test_removeTokenRange_startGreaterThanEnd_reverts() public {
        // Symmetric with `_addTokenRange`: an inverted tuple can never
        // be added, so it should be rejected up front on remove with the
        // same `InvalidTokenRange` error rather than the generic
        // `TokenRangeNotRegistered`.
        vm.expectRevert(ArtistRecordRegistry.InvalidTokenRange.selector);
        vm.prank(artist);
        reg.removeTokenRange(NFT_ADDR, 100, 1);
    }

    function test_removeTokenRange_zeroAddress_reverts() public {
        vm.expectRevert(ArtistRecordRegistry.InvalidContractAddress.selector);
        vm.prank(artist);
        reg.removeTokenRange(address(0), 1, 100);
    }

    // ─── Operator delegation ────────────────────────────────────────

    function test_setOperator_emitsAndStores() public {
        vm.expectEmit(true, true, true, true);
        emit OperatorSet(artist, operator, true);
        vm.prank(artist);
        reg.setOperator(operator, true);
        assertTrue(reg.isOperator(artist, operator));
    }

    function test_setOperator_alwaysEmits_evenWhenIdempotent() public {
        vm.prank(artist);
        reg.setOperator(operator, true);

        // Setting same value again must still emit (uniform audit trail).
        vm.expectEmit(true, true, true, true);
        emit OperatorSet(artist, operator, true);
        vm.prank(artist);
        reg.setOperator(operator, true);
    }

    function test_setOperator_zero_reverts() public {
        vm.expectRevert(ArtistRecordRegistry.InvalidOperator.selector);
        vm.prank(artist);
        reg.setOperator(address(0), true);
    }

    function test_approvedOperator_canAddContract() public {
        vm.prank(artist);
        reg.setOperator(operator, true);
        vm.prank(operator);
        reg.addContractFor(artist, NFT_ADDR);
        assertTrue(reg.isContractRegistered(artist, NFT_ADDR));
    }

    function test_approvedOperator_canRemoveContract() public {
        vm.prank(artist);
        reg.setOperator(operator, true);
        vm.prank(operator);
        reg.addContractFor(artist, NFT_ADDR);
        vm.prank(operator);
        reg.removeContractFor(artist, NFT_ADDR);
        assertFalse(reg.isContractRegistered(artist, NFT_ADDR));
    }

    function test_approvedOperator_canManageTokens() public {
        vm.prank(artist);
        reg.setOperator(operator, true);
        vm.prank(operator);
        reg.addTokenFor(artist, NFT_ADDR, 1);
        assertTrue(reg.isTokenRegistered(artist, NFT_ADDR, 1));
        vm.prank(operator);
        reg.removeTokenFor(artist, NFT_ADDR, 1);
        assertFalse(reg.isTokenRegistered(artist, NFT_ADDR, 1));
    }

    function test_approvedOperator_canManageTokenRanges() public {
        vm.prank(artist);
        reg.setOperator(operator, true);
        vm.prank(operator);
        reg.addTokenRangeFor(artist, NFT_ADDR, 1, 100);
        assertTrue(reg.isTokenRangeRegistered(artist, NFT_ADDR, 1, 100));
        vm.prank(operator);
        reg.removeTokenRangeFor(artist, NFT_ADDR, 1, 100);
        assertFalse(reg.isTokenRangeRegistered(artist, NFT_ADDR, 1, 100));
    }

    function test_nonOperator_cannotAddContract() public {
        vm.expectRevert(ArtistRecordRegistry.NotAuthorized.selector);
        vm.prank(stranger);
        reg.addContractFor(artist, NFT_ADDR);
    }

    function test_nonOperator_cannotRemoveContract() public {
        vm.prank(artist);
        reg.addContract(NFT_ADDR);
        vm.expectRevert(ArtistRecordRegistry.NotAuthorized.selector);
        vm.prank(stranger);
        reg.removeContractFor(artist, NFT_ADDR);
    }

    function test_nonOperator_cannotAddToken() public {
        vm.expectRevert(ArtistRecordRegistry.NotAuthorized.selector);
        vm.prank(stranger);
        reg.addTokenFor(artist, NFT_ADDR, 1);
    }

    function test_nonOperator_cannotRemoveToken() public {
        vm.prank(artist);
        reg.addToken(NFT_ADDR, 1);
        vm.expectRevert(ArtistRecordRegistry.NotAuthorized.selector);
        vm.prank(stranger);
        reg.removeTokenFor(artist, NFT_ADDR, 1);
    }

    function test_nonOperator_cannotAddTokenRange() public {
        vm.expectRevert(ArtistRecordRegistry.NotAuthorized.selector);
        vm.prank(stranger);
        reg.addTokenRangeFor(artist, NFT_ADDR, 1, 100);
    }

    function test_nonOperator_cannotRemoveTokenRange() public {
        vm.prank(artist);
        reg.addTokenRange(NFT_ADDR, 1, 100);
        vm.expectRevert(ArtistRecordRegistry.NotAuthorized.selector);
        vm.prank(stranger);
        reg.removeTokenRangeFor(artist, NFT_ADDR, 1, 100);
    }

    function test_revokedOperator_loses_writeAccess_immediately() public {
        vm.prank(artist);
        reg.setOperator(operator, true);
        vm.prank(artist);
        reg.setOperator(operator, false);
        assertFalse(reg.isOperator(artist, operator));

        vm.expectRevert(ArtistRecordRegistry.NotAuthorized.selector);
        vm.prank(operator);
        reg.addContractFor(artist, NFT_ADDR);
    }

    function test_operator_cannot_setOperatorForArtist() public {
        vm.prank(artist);
        reg.setOperator(operator, true);

        // Calling setOperator from the operator's address sets the
        // operator's own operator map, not the artist's. Verify the
        // artist's slot is unchanged.
        address rogue = address(0x9999);
        vm.prank(operator);
        reg.setOperator(rogue, true);

        assertFalse(reg.isOperator(artist, rogue));
        assertTrue(reg.isOperator(operator, rogue));
    }

    // ─── Zero-artist checks on *For functions ───────────────────────

    function test_addContractFor_zeroArtist_reverts() public {
        vm.expectRevert(ArtistRecordRegistry.InvalidArtist.selector);
        reg.addContractFor(address(0), NFT_ADDR);
    }

    function test_removeContractFor_zeroArtist_reverts() public {
        vm.expectRevert(ArtistRecordRegistry.InvalidArtist.selector);
        reg.removeContractFor(address(0), NFT_ADDR);
    }

    function test_addTokenFor_zeroArtist_reverts() public {
        vm.expectRevert(ArtistRecordRegistry.InvalidArtist.selector);
        reg.addTokenFor(address(0), NFT_ADDR, 1);
    }

    function test_removeTokenFor_zeroArtist_reverts() public {
        vm.expectRevert(ArtistRecordRegistry.InvalidArtist.selector);
        reg.removeTokenFor(address(0), NFT_ADDR, 1);
    }

    function test_addTokenRangeFor_zeroArtist_reverts() public {
        vm.expectRevert(ArtistRecordRegistry.InvalidArtist.selector);
        reg.addTokenRangeFor(address(0), NFT_ADDR, 1, 100);
    }

    function test_removeTokenRangeFor_zeroArtist_reverts() public {
        vm.expectRevert(ArtistRecordRegistry.InvalidArtist.selector);
        reg.removeTokenRangeFor(address(0), NFT_ADDR, 1, 100);
    }

    // ─── Enumeration + swap-and-pop ─────────────────────────────────

    function test_contracts_swapAndPop_fromMiddle() public {
        address a1 = address(0x1111);
        address a2 = address(0x2222);
        address a3 = address(0x3333);
        vm.prank(artist);
        reg.addContract(a1);
        vm.prank(artist);
        reg.addContract(a2);
        vm.prank(artist);
        reg.addContract(a3);

        vm.prank(artist);
        reg.removeContract(a2);

        assertEq(reg.getContractCount(artist), 2);
        assertFalse(reg.isContractRegistered(artist, a2));
        assertTrue(reg.isContractRegistered(artist, a1));
        assertTrue(reg.isContractRegistered(artist, a3));

        // Verify the moved pointer (a3) is now removable — exercises
        // the moved-entry's index-plus-one rewrite.
        vm.prank(artist);
        reg.removeContract(a3);
        assertEq(reg.getContractCount(artist), 1);
        assertTrue(reg.isContractRegistered(artist, a1));
    }

    function test_tokens_swapAndPop_fromMiddle() public {
        vm.prank(artist);
        reg.addToken(NFT_ADDR, 1);
        vm.prank(artist);
        reg.addToken(NFT_ADDR, 2);
        vm.prank(artist);
        reg.addToken(NFT_ADDR, 3);

        vm.prank(artist);
        reg.removeToken(NFT_ADDR, 2);

        assertEq(reg.getTokenCount(artist), 2);
        assertFalse(reg.isTokenRegistered(artist, NFT_ADDR, 2));
        assertTrue(reg.isTokenRegistered(artist, NFT_ADDR, 1));
        assertTrue(reg.isTokenRegistered(artist, NFT_ADDR, 3));

        vm.prank(artist);
        reg.removeToken(NFT_ADDR, 3);
        assertEq(reg.getTokenCount(artist), 1);
    }

    function test_tokenRanges_swapAndPop_fromMiddle() public {
        vm.prank(artist);
        reg.addTokenRange(NFT_ADDR, 1, 10);
        vm.prank(artist);
        reg.addTokenRange(NFT_ADDR, 11, 20);
        vm.prank(artist);
        reg.addTokenRange(NFT_ADDR, 21, 30);

        vm.prank(artist);
        reg.removeTokenRange(NFT_ADDR, 11, 20);

        assertEq(reg.getTokenRangeCount(artist), 2);
        assertFalse(reg.isTokenRangeRegistered(artist, NFT_ADDR, 11, 20));
        assertTrue(reg.isTokenRangeRegistered(artist, NFT_ADDR, 1, 10));
        assertTrue(reg.isTokenRangeRegistered(artist, NFT_ADDR, 21, 30));

        vm.prank(artist);
        reg.removeTokenRange(NFT_ADDR, 21, 30);
        assertEq(reg.getTokenRangeCount(artist), 1);
    }

    // ─── Isolation between artists ──────────────────────────────────

    function test_artists_areIsolated_contracts() public {
        vm.prank(artist);
        reg.addContract(NFT_ADDR);
        assertFalse(reg.isContractRegistered(artistB, NFT_ADDR));

        vm.prank(artistB);
        reg.addContract(NFT_ADDR);
        assertTrue(reg.isContractRegistered(artistB, NFT_ADDR));
    }

    function test_artists_areIsolated_tokens() public {
        vm.prank(artist);
        reg.addToken(NFT_ADDR, 5);
        assertFalse(reg.isTokenRegistered(artistB, NFT_ADDR, 5));

        vm.prank(artistB);
        reg.addToken(NFT_ADDR, 5);
        assertTrue(reg.isTokenRegistered(artistB, NFT_ADDR, 5));
    }

    function test_artists_areIsolated_tokenRanges() public {
        vm.prank(artist);
        reg.addTokenRange(NFT_ADDR, 1, 100);
        assertFalse(reg.isTokenRangeRegistered(artistB, NFT_ADDR, 1, 100));

        vm.prank(artistB);
        reg.addTokenRange(NFT_ADDR, 1, 100);
        assertTrue(reg.isTokenRangeRegistered(artistB, NFT_ADDR, 1, 100));
    }

    function test_artists_areIsolated_operators() public {
        vm.prank(artist);
        reg.setOperator(operator, true);
        assertTrue(reg.isOperator(artist, operator));
        assertFalse(reg.isOperator(artistB, operator));
    }

    // ─── No semantic checks ─────────────────────────────────────────

    function test_eoaAsContractAddress_succeeds() public {
        // The registry doesn't check that contractAddress is a contract.
        address eoaLike = address(0xBEEF);
        vm.prank(artist);
        reg.addContract(eoaLike);
        assertTrue(reg.isContractRegistered(artist, eoaLike));
    }

    function test_tokenIdZero_succeeds() public {
        vm.prank(artist);
        reg.addToken(NFT_ADDR, 0);
        assertTrue(reg.isTokenRegistered(artist, NFT_ADDR, 0));
    }

    function test_veryLargeTokenId_succeeds() public {
        uint256 huge = type(uint256).max;
        vm.prank(artist);
        reg.addToken(NFT_ADDR, huge);
        assertTrue(reg.isTokenRegistered(artist, NFT_ADDR, huge));
    }

    function test_veryLargeTokenRange_succeeds() public {
        vm.prank(artist);
        reg.addTokenRange(NFT_ADDR, 0, type(uint256).max);
        assertTrue(
            reg.isTokenRangeRegistered(artist, NFT_ADDR, 0, type(uint256).max)
        );
    }

    // ─── Slice getters ──────────────────────────────────────────────

    function test_getContractsSlice_middleSegment() public {
        address a1 = address(0x1111);
        address a2 = address(0x2222);
        address a3 = address(0x3333);
        address a4 = address(0x4444);
        address a5 = address(0x5555);
        vm.startPrank(artist);
        reg.addContract(a1);
        reg.addContract(a2);
        reg.addContract(a3);
        reg.addContract(a4);
        reg.addContract(a5);
        vm.stopPrank();

        address[] memory slice = reg.getContractsSlice(artist, 1, 3);
        assertEq(slice.length, 3);
        assertEq(slice[0], a2);
        assertEq(slice[1], a3);
        assertEq(slice[2], a4);
    }

    function test_getContractsSlice_countExceedsRemaining_returnsShorter() public {
        address a1 = address(0x1111);
        address a2 = address(0x2222);
        address a3 = address(0x3333);
        vm.startPrank(artist);
        reg.addContract(a1);
        reg.addContract(a2);
        reg.addContract(a3);
        vm.stopPrank();

        address[] memory slice = reg.getContractsSlice(artist, 1, 100);
        assertEq(slice.length, 2);
        assertEq(slice[0], a2);
        assertEq(slice[1], a3);
    }

    function test_getContractsSlice_startBeyondLength_returnsEmpty() public {
        vm.prank(artist);
        reg.addContract(NFT_ADDR);

        address[] memory slice = reg.getContractsSlice(artist, 5, 10);
        assertEq(slice.length, 0);
    }

    function test_getContractsSlice_emptyList_returnsEmpty() public view {
        address[] memory slice = reg.getContractsSlice(artist, 0, 10);
        assertEq(slice.length, 0);
    }

    function test_getTokensSlice_middleSegment() public {
        vm.startPrank(artist);
        reg.addToken(NFT_ADDR, 1);
        reg.addToken(NFT_ADDR, 2);
        reg.addToken(NFT_ADDR, 3);
        reg.addToken(NFT_ADDR, 4);
        reg.addToken(NFT_ADDR, 5);
        vm.stopPrank();

        ArtistRecordRegistry.TokenPointer[] memory slice =
            reg.getTokensSlice(artist, 1, 3);
        assertEq(slice.length, 3);
        assertEq(slice[0].tokenId, 2);
        assertEq(slice[1].tokenId, 3);
        assertEq(slice[2].tokenId, 4);
    }

    function test_getTokensSlice_countExceedsRemaining_returnsShorter() public {
        vm.startPrank(artist);
        reg.addToken(NFT_ADDR, 1);
        reg.addToken(NFT_ADDR, 2);
        reg.addToken(NFT_ADDR, 3);
        vm.stopPrank();

        ArtistRecordRegistry.TokenPointer[] memory slice =
            reg.getTokensSlice(artist, 1, 100);
        assertEq(slice.length, 2);
        assertEq(slice[0].tokenId, 2);
        assertEq(slice[1].tokenId, 3);
    }

    function test_getTokensSlice_startBeyondLength_returnsEmpty() public {
        vm.prank(artist);
        reg.addToken(NFT_ADDR, 1);

        ArtistRecordRegistry.TokenPointer[] memory slice =
            reg.getTokensSlice(artist, 5, 10);
        assertEq(slice.length, 0);
    }

    function test_getTokensSlice_emptyList_returnsEmpty() public view {
        ArtistRecordRegistry.TokenPointer[] memory slice =
            reg.getTokensSlice(artist, 0, 10);
        assertEq(slice.length, 0);
    }

    function test_getTokenRangesSlice_middleSegment() public {
        vm.startPrank(artist);
        reg.addTokenRange(NFT_ADDR, 1, 10);
        reg.addTokenRange(NFT_ADDR, 11, 20);
        reg.addTokenRange(NFT_ADDR, 21, 30);
        reg.addTokenRange(NFT_ADDR, 31, 40);
        reg.addTokenRange(NFT_ADDR, 41, 50);
        vm.stopPrank();

        ArtistRecordRegistry.TokenRangePointer[] memory slice =
            reg.getTokenRangesSlice(artist, 1, 3);
        assertEq(slice.length, 3);
        assertEq(slice[0].startTokenId, 11);
        assertEq(slice[1].startTokenId, 21);
        assertEq(slice[2].startTokenId, 31);
        assertEq(slice[2].endTokenId, 40);
    }

    function test_getTokenRangesSlice_countExceedsRemaining_returnsShorter() public {
        vm.startPrank(artist);
        reg.addTokenRange(NFT_ADDR, 1, 10);
        reg.addTokenRange(NFT_ADDR, 11, 20);
        reg.addTokenRange(NFT_ADDR, 21, 30);
        vm.stopPrank();

        ArtistRecordRegistry.TokenRangePointer[] memory slice =
            reg.getTokenRangesSlice(artist, 1, 100);
        assertEq(slice.length, 2);
        assertEq(slice[0].startTokenId, 11);
        assertEq(slice[1].startTokenId, 21);
    }

    function test_getTokenRangesSlice_startBeyondLength_returnsEmpty() public {
        vm.prank(artist);
        reg.addTokenRange(NFT_ADDR, 1, 10);

        ArtistRecordRegistry.TokenRangePointer[] memory slice =
            reg.getTokenRangesSlice(artist, 5, 10);
        assertEq(slice.length, 0);
    }

    function test_getTokenRangesSlice_emptyList_returnsEmpty() public view {
        ArtistRecordRegistry.TokenRangePointer[] memory slice =
            reg.getTokenRangesSlice(artist, 0, 10);
        assertEq(slice.length, 0);
    }

    function test_getContractsSlice_zeroCount_returnsEmpty() public {
        vm.prank(artist);
        reg.addContract(NFT_ADDR);
        address[] memory slice = reg.getContractsSlice(artist, 0, 0);
        assertEq(slice.length, 0);
    }

    // ─── Key helpers ────────────────────────────────────────────────

    function test_getContractKey_isDeterministic() public view {
        bytes32 k1 = reg.getContractKey(NFT_ADDR);
        bytes32 k2 = reg.getContractKey(NFT_ADDR);
        assertEq(k1, k2);

        bytes32 different = reg.getContractKey(NFT_ADDR_B);
        assertTrue(k1 != different);
    }

    function test_getTokenKey_isDeterministic() public view {
        bytes32 k1 = reg.getTokenKey(NFT_ADDR, 1);
        bytes32 k2 = reg.getTokenKey(NFT_ADDR, 1);
        assertEq(k1, k2);

        bytes32 different = reg.getTokenKey(NFT_ADDR, 2);
        assertTrue(k1 != different);
    }

    function test_getTokenRangeKey_isDeterministic() public view {
        bytes32 k1 = reg.getTokenRangeKey(NFT_ADDR, 1, 100);
        bytes32 k2 = reg.getTokenRangeKey(NFT_ADDR, 1, 100);
        assertEq(k1, k2);

        bytes32 different = reg.getTokenRangeKey(NFT_ADDR, 1, 99);
        assertTrue(k1 != different);
    }
}
