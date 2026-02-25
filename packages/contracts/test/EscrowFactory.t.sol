// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./helpers/TestSetup.sol";

contract EscrowFactoryTest is TestSetup {
    function test_create_deploys_instance() public {
        uint256 deadline = block.timestamp + DEADLINE_OFFSET;
        address addr = factory.create(ESCROW_ID, buyerAddr, sellerAddr, AMOUNT, COLLATERAL, deadline);
        assertTrue(addr != address(0));
        assertEq(factory.escrows(ESCROW_ID), addr);
    }

    function test_create2_determinism() public {
        uint256 deadline = block.timestamp + DEADLINE_OFFSET;
        address predicted = factory.predictAddress(ESCROW_ID, buyerAddr, sellerAddr, AMOUNT, COLLATERAL, deadline);
        address actual = factory.create(ESCROW_ID, buyerAddr, sellerAddr, AMOUNT, COLLATERAL, deadline);
        assertEq(predicted, actual);
    }

    function test_create_reverts_duplicate() public {
        uint256 deadline = block.timestamp + DEADLINE_OFFSET;
        factory.create(ESCROW_ID, buyerAddr, sellerAddr, AMOUNT, COLLATERAL, deadline);

        vm.expectRevert("EscrowFactory: already deployed");
        factory.create(ESCROW_ID, buyerAddr, sellerAddr, AMOUNT, COLLATERAL, deadline);
    }

    function test_create_reverts_zero_address() public {
        uint256 deadline = block.timestamp + DEADLINE_OFFSET;
        vm.expectRevert("EscrowFactory: zero address");
        factory.create(ESCROW_ID, address(0), sellerAddr, AMOUNT, COLLATERAL, deadline);
    }

    function test_create_reverts_same_address() public {
        uint256 deadline = block.timestamp + DEADLINE_OFFSET;
        vm.expectRevert("EscrowFactory: same address");
        factory.create(ESCROW_ID, buyerAddr, buyerAddr, AMOUNT, COLLATERAL, deadline);
    }

    function test_create_reverts_zero_amount() public {
        uint256 deadline = block.timestamp + DEADLINE_OFFSET;
        vm.expectRevert("EscrowFactory: zero amount");
        factory.create(ESCROW_ID, buyerAddr, sellerAddr, 0, COLLATERAL, deadline);
    }

    function test_rotateGateway() public {
        address newGateway = makeAddr("newGateway");
        factory.rotateGateway(newGateway);
        assertEq(factory.authorizedGateway(), newGateway);
    }

    function test_rotateGateway_reverts_non_owner() public {
        vm.prank(buyerAddr);
        vm.expectRevert();
        factory.rotateGateway(makeAddr("newGateway"));
    }

    function test_rotateGateway_reverts_zero() public {
        vm.expectRevert("EscrowFactory: zero address");
        factory.rotateGateway(address(0));
    }

    function test_updateTreasury() public {
        address newTreasury = makeAddr("newTreasury");
        factory.updateTreasury(newTreasury);
        assertEq(factory.treasury(), newTreasury);
    }

    function test_different_escrowIds_different_addresses() public {
        uint256 deadline = block.timestamp + DEADLINE_OFFSET;
        bytes32 id1 = keccak256("escrow-001");
        bytes32 id2 = keccak256("escrow-002");

        address addr1 = factory.create(id1, buyerAddr, sellerAddr, AMOUNT, COLLATERAL, deadline);
        address addr2 = factory.create(id2, buyerAddr, sellerAddr, AMOUNT, COLLATERAL, deadline);
        assertTrue(addr1 != addr2);
    }
}
