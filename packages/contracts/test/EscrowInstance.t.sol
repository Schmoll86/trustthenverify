// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./helpers/TestSetup.sol";

contract EscrowInstanceTest is TestSetup {
    EscrowInstance public instance;

    function setUp() public override {
        super.setUp();
        instance = _deployEscrow();
    }

    // ── Funding ───────────────────────────────────────────────────────────

    function test_fund_buyer() public {
        vm.startPrank(buyerAddr);
        usdc.approve(address(instance), AMOUNT);
        instance.fund();
        vm.stopPrank();

        assertEq(uint256(instance.state()), uint256(EscrowInstance.State.BuyerFunded));
        assertEq(usdc.balanceOf(address(instance)), AMOUNT);
    }

    function test_fund_reverts_not_buyer() public {
        vm.prank(sellerAddr);
        vm.expectRevert("EscrowInstance: not buyer");
        instance.fund();
    }

    function test_fundSeller_activates() public {
        _fundBoth(instance);
        assertEq(uint256(instance.state()), uint256(EscrowInstance.State.Active));
        assertEq(usdc.balanceOf(address(instance)), AMOUNT + COLLATERAL);
    }

    function test_fundSeller_reverts_before_buyer() public {
        vm.startPrank(sellerAddr);
        usdc.approve(address(instance), COLLATERAL);
        vm.expectRevert("EscrowInstance: buyer must fund first");
        instance.fundSeller();
        vm.stopPrank();
    }

    function test_fundSeller_zero_collateral() public {
        // Deploy escrow with 0 collateral
        uint256 deadline = block.timestamp + DEADLINE_OFFSET;
        bytes32 id2 = keccak256("escrow-zero-collateral");
        address addr = factory.create(id2, buyerAddr, sellerAddr, AMOUNT, 0, deadline);
        EscrowInstance inst = EscrowInstance(addr);

        vm.startPrank(buyerAddr);
        usdc.approve(addr, AMOUNT);
        inst.fund();
        vm.stopPrank();

        vm.startPrank(sellerAddr);
        inst.fundSeller(); // 0 collateral, no transfer needed
        vm.stopPrank();

        assertEq(uint256(inst.state()), uint256(EscrowInstance.State.Active));
    }

    // ── Delivery + Release ────────────────────────────────────────────────

    function test_submit_deliverable() public {
        _fundBoth(instance);

        bytes32 resultHash = keccak256("deliverable");
        vm.prank(sellerAddr);
        instance.submitDeliverable(resultHash);

        assertEq(uint256(instance.state()), uint256(EscrowInstance.State.Delivered));
        assertEq(instance.resultHash(), resultHash);
    }

    function test_submit_reverts_not_active() public {
        vm.prank(sellerAddr);
        vm.expectRevert("EscrowInstance: not active");
        instance.submitDeliverable(keccak256("x"));
    }

    function test_submit_reverts_past_deadline() public {
        _fundBoth(instance);
        vm.warp(block.timestamp + DEADLINE_OFFSET + 1);

        vm.prank(sellerAddr);
        vm.expectRevert("EscrowInstance: past deadline");
        instance.submitDeliverable(keccak256("x"));
    }

    function test_confirm_delivery_buyer() public {
        _fundBoth(instance);

        vm.prank(sellerAddr);
        instance.submitDeliverable(keccak256("deliverable"));

        uint256 sellerBefore = usdc.balanceOf(sellerAddr);
        vm.prank(buyerAddr);
        instance.confirmDelivery();

        assertEq(uint256(instance.state()), uint256(EscrowInstance.State.Released));
        assertEq(usdc.balanceOf(sellerAddr), sellerBefore + AMOUNT + COLLATERAL);
        assertEq(usdc.balanceOf(address(instance)), 0);
    }

    function test_confirm_reverts_not_buyer() public {
        _fundBoth(instance);
        vm.prank(sellerAddr);
        instance.submitDeliverable(keccak256("x"));

        vm.prank(sellerAddr);
        vm.expectRevert("EscrowInstance: not buyer");
        instance.confirmDelivery();
    }

    // ── Gateway Release ───────────────────────────────────────────────────

    function test_gateway_release() public {
        _fundBoth(instance);

        bytes32 resultDigest = keccak256("result");
        vm.prank(sellerAddr);
        instance.submitDeliverable(resultDigest);

        (uint8 v, bytes32 r, bytes32 s) = _signGatewayRelease(ESCROW_ID, resultDigest, address(instance));

        uint256 sellerBefore = usdc.balanceOf(sellerAddr);
        instance.gatewayRelease(ESCROW_ID, resultDigest, v, r, s);

        assertEq(uint256(instance.state()), uint256(EscrowInstance.State.Released));
        assertEq(usdc.balanceOf(sellerAddr), sellerBefore + AMOUNT + COLLATERAL);
    }

    function test_gateway_release_reverts_bad_sig() public {
        _fundBoth(instance);
        vm.prank(sellerAddr);
        instance.submitDeliverable(keccak256("result"));

        // Sign with wrong key
        (, uint256 fakeKey) = makeAddrAndKey("fake");
        bytes32 messageHash = keccak256(abi.encodePacked(ESCROW_ID, keccak256("result"), address(instance)));
        bytes32 ethSignedHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(fakeKey, ethSignedHash);

        vm.expectRevert("EscrowInstance: invalid gateway signature");
        instance.gatewayRelease(ESCROW_ID, keccak256("result"), v, r, s);
    }

    // ── Gateway Fail ──────────────────────────────────────────────────────

    function test_gateway_fail() public {
        _fundBoth(instance);

        bytes32 resultDigest = keccak256("result");
        vm.prank(sellerAddr);
        instance.submitDeliverable(resultDigest);

        (uint8 v, bytes32 r, bytes32 s) = _signGatewayFail(ESCROW_ID, resultDigest, address(instance));

        uint256 buyerBefore = usdc.balanceOf(buyerAddr);
        uint256 treasuryBefore = usdc.balanceOf(treasury);
        instance.gatewayFail(ESCROW_ID, resultDigest, v, r, s);

        assertEq(uint256(instance.state()), uint256(EscrowInstance.State.Failed));
        assertEq(usdc.balanceOf(buyerAddr), buyerBefore + AMOUNT);
        assertEq(usdc.balanceOf(treasury), treasuryBefore + COLLATERAL);
    }

    // ── Dispute ───────────────────────────────────────────────────────────

    function test_dispute_active() public {
        _fundBoth(instance);

        uint256 treasuryBefore = usdc.balanceOf(treasury);
        vm.prank(buyerAddr);
        instance.dispute(keccak256("bad service"));

        assertEq(uint256(instance.state()), uint256(EscrowInstance.State.Burned));
        assertEq(usdc.balanceOf(treasury), treasuryBefore + AMOUNT + COLLATERAL);
        assertEq(usdc.balanceOf(address(instance)), 0);
    }

    function test_dispute_delivered() public {
        _fundBoth(instance);
        vm.prank(sellerAddr);
        instance.submitDeliverable(keccak256("x"));

        vm.prank(sellerAddr);
        instance.dispute(keccak256("dispute reason"));

        assertEq(uint256(instance.state()), uint256(EscrowInstance.State.Burned));
    }

    function test_dispute_reverts_wrong_state() public {
        // Still Created, not active
        vm.prank(buyerAddr);
        vm.expectRevert("EscrowInstance: invalid state for dispute");
        instance.dispute(keccak256("x"));
    }

    function test_dispute_reverts_non_party() public {
        _fundBoth(instance);

        vm.prank(makeAddr("random"));
        vm.expectRevert("EscrowInstance: not party");
        instance.dispute(keccak256("x"));
    }

    // ── Timeout ───────────────────────────────────────────────────────────

    function test_timeout_created() public {
        vm.warp(block.timestamp + DEADLINE_OFFSET + 1);
        instance.timeout();
        assertEq(uint256(instance.state()), uint256(EscrowInstance.State.Expired));
    }

    function test_timeout_buyer_funded() public {
        vm.startPrank(buyerAddr);
        usdc.approve(address(instance), AMOUNT);
        instance.fund();
        vm.stopPrank();

        uint256 buyerBefore = usdc.balanceOf(buyerAddr);
        vm.warp(block.timestamp + DEADLINE_OFFSET + 1);
        instance.timeout();

        assertEq(uint256(instance.state()), uint256(EscrowInstance.State.Expired));
        assertEq(usdc.balanceOf(buyerAddr), buyerBefore + AMOUNT);
    }

    function test_timeout_active() public {
        _fundBoth(instance);

        uint256 buyerBefore = usdc.balanceOf(buyerAddr);
        uint256 treasuryBefore = usdc.balanceOf(treasury);
        vm.warp(block.timestamp + DEADLINE_OFFSET + 1);
        instance.timeout();

        assertEq(uint256(instance.state()), uint256(EscrowInstance.State.Expired));
        assertEq(usdc.balanceOf(buyerAddr), buyerBefore + AMOUNT);
        assertEq(usdc.balanceOf(treasury), treasuryBefore + COLLATERAL);
    }

    function test_timeout_reverts_not_past_deadline() public {
        vm.expectRevert("EscrowInstance: not past deadline");
        instance.timeout();
    }

    function test_timeout_reverts_delivered() public {
        _fundBoth(instance);
        vm.prank(sellerAddr);
        instance.submitDeliverable(keccak256("x"));

        vm.warp(block.timestamp + DEADLINE_OFFSET + 1);
        vm.expectRevert("EscrowInstance: invalid state for timeout");
        instance.timeout();
    }

    // ── Terminal state checks ─────────────────────────────────────────────

    function test_released_is_terminal() public {
        _fundBoth(instance);
        vm.prank(sellerAddr);
        instance.submitDeliverable(keccak256("x"));
        vm.prank(buyerAddr);
        instance.confirmDelivery();

        // Cannot dispute after release
        vm.prank(buyerAddr);
        vm.expectRevert("EscrowInstance: invalid state for dispute");
        instance.dispute(keccak256("x"));
    }
}
