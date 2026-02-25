// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/EscrowFactory.sol";

/// @notice Deploy EscrowFactory to Base L2.
/// Usage: forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast --verify
contract Deploy is Script {
    function run() external {
        address usdc = vm.envAddress("USDC_ADDRESS");
        address gateway = vm.envAddress("GATEWAY_ADDRESS");
        address treasury = vm.envAddress("TREASURY_ADDRESS");

        vm.startBroadcast();
        EscrowFactory factory = new EscrowFactory(usdc, gateway, treasury);
        vm.stopBroadcast();

        console.log("EscrowFactory deployed at:", address(factory));
        console.log("  USDC:", usdc);
        console.log("  Gateway:", gateway);
        console.log("  Treasury:", treasury);
    }
}
