// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {ERC1155} from "openzeppelin-contracts/contracts/token/ERC1155/ERC1155.sol";
import {IERC1155Receiver} from "openzeppelin-contracts/contracts/token/ERC1155/IERC1155Receiver.sol";
import {SovereignAuctionHouseV2_1} from "../src/SovereignAuctionHouseV2_1.sol";
import {SovereignAuctionHouseV2_1Factory} from "../src/SovereignAuctionHouseV2_1Factory.sol";
import {ISovereignAuctionHouseV2} from "../src/ISovereignAuctionHouseV2.sol";
import {ISovereignAuctionHouseV2_1} from "../src/ISovereignAuctionHouseV2_1.sol";
import {MockERC721} from "./MockERC721.sol";
import {PausableNFT} from "./PausableNFT.sol";
import {PausableERC1155} from "./PausableERC1155.sol";
import {MutableERC721} from "./SovereignAuctionHouseV2.t.sol";

contract V21Mock1155 is ERC1155 {
    constructor() ERC1155("") {}

    function mint(address to, uint256 id, uint256 amount) external {
        _mint(to, id, amount, "");
    }
}

/// @dev Contract bidder that accepts ERC1155 delivery only while its owner
///      has switched acceptance on, and only inside a transaction its owner
///      started. Models a winner that chooses when (and whether) to take
///      delivery after the hammer.
contract OptionBidder {
    address internal immutable _owner;
    bool public accept;

    constructor() {
        _owner = msg.sender;
    }

    function bid(address house, uint256 auctionId) external payable {
        SovereignAuctionHouseV2_1(payable(house)).createBid{value: msg.value}(auctionId);
    }

    function setAccept(bool value) external {
        require(msg.sender == _owner, "owner");
        accept = value;
    }

    function claim(address house, uint256 auctionId, address to) external {
        require(msg.sender == _owner, "owner");
        accept = true;
        SovereignAuctionHouseV2_1(payable(house)).claimLot(auctionId, to);
    }

    function withdrawTo(address house, address payable to) external {
        require(msg.sender == _owner, "owner");
        SovereignAuctionHouseV2_1(payable(house)).withdrawRefundTo(to);
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external view returns (bytes4) {
        require(accept && tx.origin == _owner, "not now");
        return IERC1155Receiver.onERC1155Received.selector;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external view returns (bytes4) {
        require(accept && tx.origin == _owner, "not now");
        return this.onERC721Received.selector;
    }
}

/// @dev Contract bidder whose ERC1155 hook spends all the gas it is given.
contract GasBurningBidder {
    function bid(address house, uint256 auctionId) external payable {
        SovereignAuctionHouseV2_1(payable(house)).createBid{value: msg.value}(auctionId);
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        while (true) {}
        return bytes4(0);
    }
}

/// @dev Contract bidder whose ERC1155 hook reverts with a large payload.
contract LargeRevertBidder {
    function bid(address house, uint256 auctionId) external payable {
        SovereignAuctionHouseV2_1(payable(house)).createBid{value: msg.value}(auctionId);
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        assembly {
            revert(0, 100000)
        }
    }
}

/// @dev ERC1155 whose outbound transfers (house to anyone) can be made to
///      revert with the house's LotTransferable selector, to show the probe
///      result cannot be produced by token revert data.
contract ForgingERC1155 is ERC1155 {
    bool public forge;

    constructor() ERC1155("") {}

    function mint(address to, uint256 id, uint256 amount) external {
        _mint(to, id, amount, "");
    }

    function setForge(bool value) external {
        forge = value;
    }

    function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes memory data)
        public
        override
    {
        if (forge && from == msg.sender) {
            bytes4 sel = SovereignAuctionHouseV2_1.LotTransferable.selector;
            assembly {
                mstore(0, sel)
                revert(0, 4)
            }
        }
        super.safeTransferFrom(from, to, id, value, data);
    }
}

/// @dev Seller wallet (a contract) that owns a V2.1 house and lists from it,
///      and rejects every inbound ERC1155 after listing. Used to show the
///      seller's own receiver plays no part in the transferability probe.
contract RejectingSellerWallet {
    SovereignAuctionHouseV2_1 public house;
    bool public rejectInbound;

    function setUp(SovereignAuctionHouseV2_1Factory factory, V21Mock1155 token) external {
        house = SovereignAuctionHouseV2_1(payable(factory.createAuctionHouse()));
        token.setApprovalForAll(address(house), true);
    }

    function list(address token, uint256 id, uint256 quantity, uint256 duration, uint256 reserve)
        external
        returns (uint256)
    {
        uint256 auctionId = house.create1155Auction(id, token, quantity, duration, reserve, 0);
        rejectInbound = true;
        return auctionId;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external view returns (bytes4) {
        require(!rejectInbound, "seller rejects");
        return IERC1155Receiver.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert("no batch");
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == type(IERC1155Receiver).interfaceId || id == 0x01ffc9a7;
    }
}

contract SovereignAuctionHouseV2_1Test is Test {
    SovereignAuctionHouseV2_1Factory internal factory;
    SovereignAuctionHouseV2_1 internal house;
    V21Mock1155 internal token;

    address internal artist = makeAddr("artist");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal bidderOwner = makeAddr("bidderOwner");
    address payable internal treasury = payable(makeAddr("treasury"));

    uint256 internal constant ID = 7;
    uint256 internal constant QUANTITY = 5;
    uint256 internal constant RESERVE = 1 ether;
    uint256 internal constant DURATION = 1 days;
    uint16 internal constant FEE_BPS = 250;

    function setUp() public {
        SovereignAuctionHouseV2_1 impl = new SovereignAuctionHouseV2_1();
        factory = new SovereignAuctionHouseV2_1Factory(address(impl), treasury, FEE_BPS);
        token = new V21Mock1155();
        token.mint(artist, ID, QUANTITY);
        vm.startPrank(artist);
        house = SovereignAuctionHouseV2_1(payable(factory.createAuctionHouse()));
        token.setApprovalForAll(address(house), true);
        vm.stopPrank();
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(bidderOwner, 100 ether);
    }

    // ---------------------------------------------------------------- helpers

    function _fee(uint256 amount) internal pure returns (uint256) {
        return (amount * FEE_BPS) / 10_000;
    }

    function _list1155() internal returns (uint256 auctionId) {
        vm.prank(artist);
        auctionId = house.create1155Auction(ID, address(token), QUANTITY, DURATION, RESERVE, 0);
    }

    function _optionBidder() internal returns (OptionBidder ob) {
        vm.prank(bidderOwner);
        ob = new OptionBidder();
    }

    function _bidAs(OptionBidder ob, uint256 auctionId, uint256 amount) internal {
        vm.prank(bidderOwner, bidderOwner);
        ob.bid{value: amount}(address(house), auctionId);
    }

    function _assertConserved(address[] memory touched) internal view {
        uint256 sum;
        for (uint256 i; i < touched.length; ++i) {
            sum += house.pendingRefunds(touched[i]);
        }
        assertEq(address(house).balance, sum, "ETH conservation invariant violated");
    }

    // ------------------------------------------------------------ identity

    function test_VersionAndTupleLayoutVersion() public view {
        assertEq(house.version(), "2.1.0");
        assertEq(house.auctionVersion(), 2, "tuple layout is V2's");
        assertEq(house.owner(), artist);
        assertEq(house.protocolFeeBps(), FEE_BPS);
        assertEq(house.DELIVERY_PROBE_RECIPIENT().code.length, 0);
    }

    function test_FactoryPredictsAndRejectsSecondHouse() public {
        assertEq(factory.predictHouseAddress(artist), address(house));
        assertTrue(factory.isHouse(address(house)));
        assertEq(factory.totalHouses(), 1);
        vm.expectRevert("House already exists");
        vm.prank(artist);
        factory.createAuctionHouse();
    }

    function test_ImplementationCannotBeInitialized() public {
        SovereignAuctionHouseV2_1 impl = SovereignAuctionHouseV2_1(payable(factory.implementation()));
        vm.expectRevert();
        impl.initialize(alice, treasury, 0);
    }

    /// @dev EIP-170 gate: the implementation must stay deployable with room
    ///      for small follow-up changes.
    function test_RuntimeSizeUnderEip170WithHeadroom() public {
        uint256 size = address(new SovereignAuctionHouseV2_1()).code.length;
        assertLt(size, 24_576 - 1_024, "V2.1 runtime within 1 KiB of the EIP-170 limit");
    }

    function test_SelfCallTargetsAreSelfOnly() public {
        vm.expectRevert(SovereignAuctionHouseV2_1.OnlySelf.selector);
        house.probeTransfer(address(token), ID, QUANTITY, ISovereignAuctionHouseV2.TokenStandard.ERC1155);
        vm.expectRevert(SovereignAuctionHouseV2_1.OnlySelf.selector);
        house.deliverERC1155(address(token), ID, QUANTITY, alice);
    }

    // --------------------------------------------- audit finding 1 (PoCs)

    /// @dev Regression for the 1155 refuse-then-unwind case. An honest bid is
    ///      displaced by a contract bidder that refuses delivery. In V2 it
    ///      could wait out the timeout and take a full refund. In V2.1 the
    ///      sale settles at endAuction: the seller and protocol are paid,
    ///      the lot is held for the winner, and no refund path exists.
    function test_PoC_1155RefuseThenUnwind_PaysSellerAndHoldsLot() public {
        uint256 id = _list1155();
        vm.prank(alice, alice);
        house.createBid{value: 2 ether}(id);

        OptionBidder ob = _optionBidder();
        _bidAs(ob, id, 10 ether);
        assertEq(alice.balance, 100 ether, "outbid bidder refunded");

        vm.warp(block.timestamp + DURATION + 1);
        uint256 artistBefore = artist.balance;

        vm.expectEmit(true, true, false, true, address(house));
        emit ISovereignAuctionHouseV2.AuctionEnded(id, artist, address(ob), 10 ether - _fee(10 ether), _fee(10 ether));
        vm.expectEmit(true, true, false, false, address(house));
        emit ISovereignAuctionHouseV2_1.LotHeldForWinner(id, address(ob));
        house.endAuction(id);

        assertEq(artist.balance - artistBefore, 10 ether - _fee(10 ether), "seller paid at the hammer");
        assertEq(treasury.balance, _fee(10 ether), "protocol fee paid at the hammer");
        assertTrue(house.heldForWinner(id));
        assertFalse(house.pendingDelivery(id));
        assertEq(token.balanceOf(address(house), ID), QUANTITY, "lot held in escrow for the winner");
        assertEq(token.balanceOf(house.DELIVERY_PROBE_RECIPIENT(), ID), 0, "probe left no trace");

        // Keepers cannot force delivery while the winner refuses, but no
        // refund ever becomes available.
        vm.expectRevert();
        house.claimLot(id, address(0));
        vm.warp(block.timestamp + 30 days + 1);
        vm.expectRevert(SovereignAuctionHouseV2_1.NoPendingDelivery.selector);
        house.unwindStuckLot(id);
        assertEq(house.pendingRefunds(address(ob)), 0);
        vm.expectRevert("No refund available");
        vm.prank(bidderOwner, bidderOwner);
        ob.withdrawTo(address(house), payable(bidderOwner));

        // The winner can still take the lot whenever it wants, anywhere.
        vm.prank(bidderOwner, bidderOwner);
        ob.claim(address(house), id, carol);
        assertEq(token.balanceOf(carol, ID), QUANTITY);
        assertFalse(house.heldForWinner(id));
        assertEq(artist.balance - artistBefore, 10 ether - _fee(10 ether), "seller is not paid twice");
        (bool exists,) = house.getAuctionFor(address(token), ID);
        assertFalse(exists, "token index cleared after the claim");

        address[] memory touched = new address[](4);
        touched[0] = address(ob);
        touched[1] = artist;
        touched[2] = treasury;
        touched[3] = alice;
        _assertConserved(touched);
        assertEq(address(house).balance, 0);
    }

    /// @dev Regression for the option-exercise case: the winner takes
    ///      delivery late, on its own terms, but it has already paid; there
    ///      is no outcome in which it gets the bid back instead.
    function test_PoC_1155OptionExercise_NoRefundPossible() public {
        uint256 id = _list1155();
        OptionBidder ob = _optionBidder();
        _bidAs(ob, id, 1 ether);
        vm.warp(block.timestamp + DURATION + 1);
        house.endAuction(id);
        assertEq(artist.balance, 1 ether - _fee(1 ether), "seller paid at the hammer");
        assertTrue(house.heldForWinner(id));

        vm.warp(block.timestamp + 29 days);
        vm.prank(bidderOwner, bidderOwner);
        ob.claim(address(house), id, address(0));
        assertEq(token.balanceOf(address(ob), ID), QUANTITY);
        assertEq(artist.balance, 1 ether - _fee(1 ether), "no second payment");
        assertEq(house.pendingRefunds(address(ob)), 0);
        assertEq(address(house).balance, 0);
    }

    /// @dev A held lot has no deadline: the winner can claim years later.
    function test_HeldLotHasNoDeadline() public {
        uint256 id = _list1155();
        OptionBidder ob = _optionBidder();
        _bidAs(ob, id, 1 ether);
        vm.warp(block.timestamp + DURATION + 1);
        house.endAuction(id);

        vm.warp(block.timestamp + 5 * 365 days);
        vm.prank(bidderOwner, bidderOwner);
        ob.claim(address(house), id, bob);
        assertEq(token.balanceOf(bob, ID), QUANTITY);
    }

    // ------------------------------------- genuine stuck lot (issue #289)

    /// @dev A collection paused at the hammer: nothing can move, so V2's
    ///      behaviour is kept. Nobody is paid, the lot is deferred, and after
    ///      the timeout the winner is refunded in full; the lot is returned
    ///      once the collection allows it.
    function test_GenuineStuck1155_PausedCollection_StillRefunds() public {
        PausableERC1155 paused = new PausableERC1155();
        paused.mint(artist, ID, QUANTITY);
        vm.prank(artist);
        paused.setApprovalForAll(address(house), true);
        vm.prank(artist);
        uint256 id = house.create1155Auction(ID, address(paused), QUANTITY, DURATION, RESERVE, 0);
        vm.prank(alice, alice);
        house.createBid{value: RESERVE}(id);
        paused.pause();
        vm.warp(block.timestamp + DURATION + 1);

        vm.expectEmit(true, true, false, false, address(house));
        emit ISovereignAuctionHouseV2.DeliveryDeferred(id, alice);
        house.endAuction(id);
        assertTrue(house.pendingDelivery(id));
        assertFalse(house.heldForWinner(id));
        assertEq(artist.balance, 0, "nobody paid on a genuinely stuck lot");

        vm.expectRevert(SovereignAuctionHouseV2_1.UnwindTooEarly.selector);
        house.unwindStuckLot(id);

        vm.warp(block.timestamp + house.PENDING_DELIVERY_TIMEOUT() + 1);
        vm.expectEmit(true, true, false, true, address(house));
        emit ISovereignAuctionHouseV2.LotUnwound(id, alice, RESERVE, artist);
        house.unwindStuckLot(id);

        assertEq(house.pendingRefunds(alice), RESERVE, "winner refunded in full");
        assertTrue(house.pendingReturn(id), "return deferred while the collection is paused");
        assertEq(artist.balance, 0);
        assertEq(treasury.balance, 0);

        paused.unpause();
        house.returnUnwoundLot(id);
        assertEq(paused.balanceOf(artist, ID), QUANTITY);

        vm.prank(alice);
        house.withdrawRefund();
        assertEq(alice.balance, 100 ether);
        assertEq(address(house).balance, 0);
    }

    function test_GenuineStuck721_PausedCollection_StillRefunds() public {
        PausableNFT nft = new PausableNFT();
        nft.mint(artist, 1);
        vm.prank(artist);
        nft.setApprovalForAll(address(house), true);
        vm.prank(artist);
        uint256 id = house.createAuction(1, address(nft), DURATION, RESERVE, 0);
        vm.prank(alice, alice);
        house.createBid{value: RESERVE}(id);
        nft.pause();
        vm.warp(block.timestamp + DURATION + 1);
        house.endAuction(id);
        assertTrue(house.pendingDelivery(id));

        vm.warp(block.timestamp + house.PENDING_DELIVERY_TIMEOUT() + 1);
        house.unwindStuckLot(id);
        assertEq(house.pendingRefunds(alice), RESERVE);
        assertTrue(house.pendingReturn(id));
        nft.unpause();
        house.returnUnwoundLot(id);
        assertEq(nft.ownerOf(1), artist);
    }

    /// @dev A lot that can reach the seller but not a fresh address (a
    ///      receiver allowlist, for example) is not transferable in the
    ///      probe's sense: the winner is refunded after the timeout and the
    ///      lot goes straight back to the seller in the same call.
    function test_LotMovableOnlyToSeller_RefundsAndReturnsInline() public {
        MutableERC721 bad = new MutableERC721();
        bad.mint(artist, 1);
        vm.prank(artist);
        bad.setApprovalForAll(address(house), true);
        vm.prank(artist);
        uint256 id = house.createAuction(1, address(bad), DURATION, RESERVE, 0);
        vm.prank(alice, alice);
        house.createBid{value: RESERVE}(id);
        bad.setBlockedRecipient(alice, true);
        bad.setBlockedRecipient(house.DELIVERY_PROBE_RECIPIENT(), true);
        vm.warp(block.timestamp + DURATION + 1);
        house.endAuction(id);
        assertTrue(house.pendingDelivery(id));

        vm.warp(block.timestamp + house.PENDING_DELIVERY_TIMEOUT() + 1);
        house.unwindStuckLot(id);
        assertEq(bad.ownerOf(1), artist);
        assertFalse(house.pendingReturn(id));
        assertEq(house.pendingRefunds(alice), RESERVE);
    }

    /// @dev Paused at the hammer, unpaused before the timeout, winner still
    ///      refusing: unwindStuckLot (callable any time) settles the sale and
    ///      holds the lot for the winner instead of waiting for, or ever
    ///      reaching, a refund.
    function test_UnpausedMidWindow_RefusingWinner_SettlesWithoutRefund() public {
        PausableERC1155 paused = new PausableERC1155();
        paused.mint(artist, ID, QUANTITY);
        vm.prank(artist);
        paused.setApprovalForAll(address(house), true);
        vm.prank(artist);
        uint256 id = house.create1155Auction(ID, address(paused), QUANTITY, DURATION, RESERVE, 0);
        OptionBidder ob = _optionBidder();
        _bidAs(ob, id, RESERVE);
        paused.pause();
        vm.warp(block.timestamp + DURATION + 1);
        house.endAuction(id);
        assertTrue(house.pendingDelivery(id));

        vm.warp(block.timestamp + 3 days);
        paused.unpause();

        vm.expectEmit(true, true, false, false, address(house));
        emit ISovereignAuctionHouseV2_1.LotHeldForWinner(id, address(ob));
        vm.prank(bob);
        house.unwindStuckLot(id);

        assertTrue(house.heldForWinner(id));
        assertFalse(house.pendingDelivery(id));
        assertEq(house.deliveryDeferredAt(id), 0);
        assertEq(artist.balance, RESERVE - _fee(RESERVE));
        assertEq(house.pendingRefunds(address(ob)), 0);

        vm.prank(bidderOwner, bidderOwner);
        ob.claim(address(house), id, address(0));
        assertEq(paused.balanceOf(address(ob), ID), QUANTITY);
    }

    /// @dev Audit finding 3 (documented trade-off, unchanged from V2): the
    ///      party that controls the collection can block every transfer after
    ///      the hammer and, once the timeout has passed, have the sale
    ///      unwound. The winner gets its full bid back; it loses only the
    ///      time its bid was locked.
    function test_CollectionControllerCanForceUnwindAfterTimeout() public {
        PausableERC1155 sellerToken = new PausableERC1155();
        sellerToken.mint(artist, ID, QUANTITY);
        vm.prank(artist);
        sellerToken.setApprovalForAll(address(house), true);
        vm.prank(artist);
        uint256 id = house.create1155Auction(ID, address(sellerToken), QUANTITY, DURATION, RESERVE, 0);
        vm.prank(alice, alice);
        house.createBid{value: RESERVE}(id);
        vm.warp(block.timestamp + DURATION + 1);

        sellerToken.pause();
        house.endAuction(id);
        vm.warp(block.timestamp + house.PENDING_DELIVERY_TIMEOUT() + 1);
        house.unwindStuckLot(id);
        sellerToken.unpause();
        house.returnUnwoundLot(id);

        assertEq(sellerToken.balanceOf(artist, ID), QUANTITY);
        assertEq(house.pendingRefunds(alice), RESERVE, "winner made whole");
        assertEq(artist.balance, 0, "seller unpaid");
    }

    // ------------------------------------------------- probe robustness

    /// @dev A token cannot fake a transferable result by reverting with the
    ///      probe's success selector: every token call in the probe is
    ///      caught, so the lot is treated as stuck and nobody is paid.
    function test_ProbeResultCannotBeForgedByTokenRevertData() public {
        ForgingERC1155 forging = new ForgingERC1155();
        forging.mint(artist, ID, QUANTITY);
        vm.prank(artist);
        forging.setApprovalForAll(address(house), true);
        vm.prank(artist);
        uint256 id = house.create1155Auction(ID, address(forging), QUANTITY, DURATION, RESERVE, 0);
        vm.prank(alice, alice);
        house.createBid{value: RESERVE}(id);
        forging.setForge(true);
        vm.warp(block.timestamp + DURATION + 1);

        house.endAuction(id);
        assertTrue(house.pendingDelivery(id), "treated as not transferable");
        assertFalse(house.heldForWinner(id));
        assertEq(artist.balance, 0);
    }

    /// @dev A winner hook that reverts with a large payload pays for that
    ///      payload inside the capped delivery frame; the outer frame copies
    ///      none of it (try/catch with an empty catch, and a four-byte read
    ///      of the probe result), so settlement still completes.
    function test_LargeRevertPayloadFromWinnerKeepsEndAuctionBounded() public {
        uint256 id = _list1155();
        LargeRevertBidder b = new LargeRevertBidder();
        vm.deal(address(b), RESERVE);
        b.bid{value: RESERVE}(address(house), id);
        vm.warp(block.timestamp + DURATION + 1);

        uint256 g = gasleft();
        house.endAuction(id);
        uint256 used = g - gasleft();
        assertTrue(house.heldForWinner(id));
        assertLt(used, 1_300_000, "settlement cost bounded by the capped calls");
    }

    /// @dev A gas-starved endAuction must revert rather than run the probe
    ///      under its stipend and misclassify the lot as stuck.
    function test_EndAuctionRevertsWhenGasBelowProbeHeadroom() public {
        uint256 id = _list1155();
        GasBurningBidder b = new GasBurningBidder();
        vm.deal(address(b), RESERVE);
        b.bid{value: RESERVE}(address(house), id);
        vm.warp(block.timestamp + DURATION + 1);

        (bool ok, bytes memory ret) =
            address(house).call{gas: 800_000}(abi.encodeCall(house.endAuction, (id)));
        assertFalse(ok, "starved call reverts");
        assertEq(bytes4(ret), SovereignAuctionHouseV2_1.InsufficientGas.selector);
        assertFalse(house.pendingDelivery(id));
        assertFalse(house.heldForWinner(id));

        house.endAuction(id);
        assertTrue(house.heldForWinner(id), "with full gas the lot is classified transferable");
    }

    /// @dev The seller's own receiver is not consulted by the probe, so a
    ///      seller wallet that rejects inbound ERC1155 cannot turn a
    ///      winner-side refusal into a refund.
    function test_SellerReceiverPlaysNoPartInProbe() public {
        RejectingSellerWallet wallet = new RejectingSellerWallet();
        token.mint(address(wallet), ID + 1, QUANTITY);
        wallet.setUp(factory, token);
        uint256 id = wallet.list(address(token), ID + 1, QUANTITY, DURATION, RESERVE);
        SovereignAuctionHouseV2_1 h = wallet.house();

        vm.prank(bidderOwner);
        OptionBidder ob = new OptionBidder();
        vm.prank(bidderOwner, bidderOwner);
        ob.bid{value: RESERVE}(address(h), id);
        vm.warp(block.timestamp + DURATION + 1);

        h.endAuction(id);
        assertTrue(h.heldForWinner(id));
        assertEq(h.pendingRefunds(address(wallet)), RESERVE - _fee(RESERVE), "contract seller credited");
    }

    // ----------------------------------------------- held-state lock-down

    function test_HeldLotIsLockedAgainstEveryOtherEntryPoint() public {
        uint256 id = _list1155();
        OptionBidder ob = _optionBidder();
        _bidAs(ob, id, RESERVE);
        vm.warp(block.timestamp + DURATION + 1);
        house.endAuction(id);
        assertTrue(house.heldForWinner(id));

        vm.expectRevert(SovereignAuctionHouseV2_1.AuctionAlreadySettled.selector);
        house.endAuction(id);
        vm.expectRevert(SovereignAuctionHouseV2_1.NoPendingDelivery.selector);
        house.unwindStuckLot(id);
        vm.expectRevert(SovereignAuctionHouseV2_1.NoPendingReturn.selector);
        house.returnUnwoundLot(id);
        vm.expectRevert(SovereignAuctionHouseV2_1.AuctionExpired.selector);
        vm.prank(alice);
        house.createBid{value: 2 ether}(id);
        vm.expectRevert(SovereignAuctionHouseV2_1.AuctionAlreadyStarted.selector);
        vm.prank(artist);
        house.cancelAuction(id);
        vm.expectRevert(SovereignAuctionHouseV2_1.AuctionNotEnded.selector);
        house.expireAuction(id);
        vm.expectRevert(SovereignAuctionHouseV2_1.AuctionAlreadyExistsForToken.selector);
        vm.prank(artist);
        house.recoverStuckERC1155(address(token), ID, QUANTITY, artist);

        token.mint(artist, ID, QUANTITY);
        vm.expectRevert(SovereignAuctionHouseV2_1.AuctionAlreadyExistsForToken.selector);
        vm.prank(artist);
        house.create1155Auction(ID, address(token), QUANTITY, DURATION, RESERVE, 0);

        // Only the winner may redirect; nobody may send it to the house.
        vm.expectRevert(SovereignAuctionHouseV2_1.NotWinner.selector);
        vm.prank(bob);
        house.claimLot(id, bob);
        vm.expectRevert(SovereignAuctionHouseV2_1.DeliveryFailed.selector);
        vm.prank(address(ob));
        house.claimLot(id, address(house));

        // A third party can deliver to the winner once it accepts.
        vm.prank(bidderOwner);
        ob.setAccept(true);
        vm.expectEmit(true, true, false, true, address(house));
        emit ISovereignAuctionHouseV2.LotClaimed(id, address(ob), address(ob));
        vm.prank(bob, bidderOwner);
        house.claimLot(id, address(0));
        assertEq(token.balanceOf(address(ob), ID), QUANTITY);
        vm.expectRevert(SovereignAuctionHouseV2_1.NoPendingDelivery.selector);
        house.claimLot(id, address(0));
    }

    // ---------------------------------------------------- ERC-721 parity

    /// @dev ERC721 delivery has no receiver hook, but a collection can still
    ///      refuse a specific recipient. The lot is transferable, so the sale
    ///      settles and the winner redirects to an address it controls.
    function test_721RecipientSpecificBlock_SettlesAndWinnerRedirects() public {
        MutableERC721 bad = new MutableERC721();
        bad.mint(artist, 1);
        vm.prank(artist);
        bad.setApprovalForAll(address(house), true);
        vm.prank(artist);
        uint256 id = house.createAuction(1, address(bad), DURATION, RESERVE, 0);
        vm.prank(alice, alice);
        house.createBid{value: RESERVE}(id);
        bad.setBlockedRecipient(alice, true);
        vm.warp(block.timestamp + DURATION + 1);

        house.endAuction(id);
        assertTrue(house.heldForWinner(id));
        assertEq(artist.balance, RESERVE - _fee(RESERVE));
        assertEq(bad.ownerOf(1), address(house));

        vm.prank(alice);
        house.claimLot(id, carol);
        assertEq(bad.ownerOf(1), carol);
        assertEq(address(house).balance, 0);
    }

    function test_721HappyPathUnchanged() public {
        MockERC721 nft = new MockERC721();
        nft.mint(artist, 1);
        vm.prank(artist);
        nft.setApprovalForAll(address(house), true);
        vm.prank(artist);
        uint256 id = house.createAuction(1, address(nft), DURATION, RESERVE, 0);
        vm.prank(alice, alice);
        house.createBid{value: RESERVE}(id);
        vm.warp(block.timestamp + DURATION + 1);
        house.endAuction(id);
        assertEq(nft.ownerOf(1), alice);
        assertFalse(house.heldForWinner(id));
        assertEq(artist.balance, RESERVE - _fee(RESERVE));
    }
}
