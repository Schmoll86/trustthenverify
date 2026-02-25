// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./helpers/TestSetup.sol";

contract PaymentChannelTest is TestSetup {
    PaymentChannel public channel;
    uint256 public buyerPrivKey;
    uint256 public constant CHANNEL_DEPOSIT = 500e6; // 500 USDC

    function setUp() public override {
        super.setUp();

        // Create a buyer with known private key for signing
        (buyerAddr, buyerPrivKey) = makeAddrAndKey("channelBuyer");
        usdc.mint(buyerAddr, 10_000e6);

        uint256 expiry = block.timestamp + 1 days;
        channel = new PaymentChannel(address(usdc), buyerAddr, sellerAddr, expiry);

        // Buyer opens channel
        vm.startPrank(buyerAddr);
        usdc.approve(address(channel), CHANNEL_DEPOSIT);
        channel.open(CHANNEL_DEPOSIT);
        vm.stopPrank();
    }

    function _signPayment(uint256 paymentAmount) internal view returns (bytes memory) {
        bytes32 messageHash = keccak256(abi.encodePacked(address(channel), paymentAmount));
        bytes32 ethSignedHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerPrivKey, ethSignedHash);
        return abi.encodePacked(r, s, v);
    }

    // ── Open ──────────────────────────────────────────────────────────────

    function test_open_channel() public view {
        assertEq(channel.depositAmount(), CHANNEL_DEPOSIT);
        assertEq(usdc.balanceOf(address(channel)), CHANNEL_DEPOSIT);
    }

    function test_open_reverts_not_buyer() public {
        PaymentChannel ch2 = new PaymentChannel(address(usdc), buyerAddr, sellerAddr, block.timestamp + 1 days);
        vm.prank(sellerAddr);
        vm.expectRevert("PaymentChannel: not buyer");
        ch2.open(100e6);
    }

    function test_open_reverts_already_opened() public {
        vm.prank(buyerAddr);
        vm.expectRevert("PaymentChannel: already opened");
        channel.open(100e6);
    }

    // ── Close ─────────────────────────────────────────────────────────────

    function test_close_full_amount() public {
        bytes memory sig = _signPayment(CHANNEL_DEPOSIT);

        uint256 sellerBefore = usdc.balanceOf(sellerAddr);
        vm.prank(sellerAddr);
        channel.close(CHANNEL_DEPOSIT, sig);

        assertTrue(channel.closed());
        assertEq(usdc.balanceOf(sellerAddr), sellerBefore + CHANNEL_DEPOSIT);
        assertEq(usdc.balanceOf(address(channel)), 0);
    }

    function test_close_partial_amount() public {
        uint256 payment = 200e6;
        bytes memory sig = _signPayment(payment);

        uint256 sellerBefore = usdc.balanceOf(sellerAddr);
        uint256 buyerBefore = usdc.balanceOf(buyerAddr);
        vm.prank(sellerAddr);
        channel.close(payment, sig);

        assertEq(usdc.balanceOf(sellerAddr), sellerBefore + payment);
        assertEq(usdc.balanceOf(buyerAddr), buyerBefore + (CHANNEL_DEPOSIT - payment));
    }

    function test_close_zero_amount() public {
        bytes memory sig = _signPayment(0);

        uint256 buyerBefore = usdc.balanceOf(buyerAddr);
        vm.prank(sellerAddr);
        channel.close(0, sig);

        assertEq(usdc.balanceOf(buyerAddr), buyerBefore + CHANNEL_DEPOSIT);
    }

    function test_close_reverts_not_seller() public {
        bytes memory sig = _signPayment(100e6);
        vm.prank(buyerAddr);
        vm.expectRevert("PaymentChannel: not seller");
        channel.close(100e6, sig);
    }

    function test_close_reverts_already_closed() public {
        bytes memory sig = _signPayment(100e6);
        vm.prank(sellerAddr);
        channel.close(100e6, sig);

        vm.prank(sellerAddr);
        vm.expectRevert("PaymentChannel: already closed");
        channel.close(100e6, sig);
    }

    function test_close_reverts_exceeds_deposit() public {
        bytes memory sig = _signPayment(CHANNEL_DEPOSIT + 1);
        vm.prank(sellerAddr);
        vm.expectRevert("PaymentChannel: amount exceeds deposit");
        channel.close(CHANNEL_DEPOSIT + 1, sig);
    }

    function test_close_reverts_invalid_signature() public {
        // Sign different amount
        bytes memory sig = _signPayment(100e6);
        vm.prank(sellerAddr);
        vm.expectRevert("PaymentChannel: invalid signature");
        channel.close(200e6, sig); // amount doesn't match signed amount
    }

    // ── Extend ────────────────────────────────────────────────────────────

    function test_extend() public {
        uint256 newExpiry = block.timestamp + 2 days;
        vm.prank(buyerAddr);
        channel.extend(newExpiry);
        assertEq(channel.expiration(), newExpiry);
    }

    function test_extend_reverts_backwards() public {
        vm.prank(buyerAddr);
        vm.expectRevert("PaymentChannel: must extend forward");
        channel.extend(block.timestamp);
    }

    // ── Timeout ───────────────────────────────────────────────────────────

    function test_claimTimeout() public {
        vm.warp(block.timestamp + 1 days + 1);

        uint256 buyerBefore = usdc.balanceOf(buyerAddr);
        vm.prank(buyerAddr);
        channel.claimTimeout();

        assertTrue(channel.closed());
        assertEq(usdc.balanceOf(buyerAddr), buyerBefore + CHANNEL_DEPOSIT);
    }

    function test_claimTimeout_reverts_not_expired() public {
        vm.prank(buyerAddr);
        vm.expectRevert("PaymentChannel: not expired");
        channel.claimTimeout();
    }

    function test_claimTimeout_reverts_not_buyer() public {
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(sellerAddr);
        vm.expectRevert("PaymentChannel: not buyer");
        channel.claimTimeout();
    }
}
