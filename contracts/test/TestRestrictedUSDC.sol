// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./TestUSDC.sol";

/**
 * @title Restricted Test USDC
 * @notice Test-only source asset with transfer restrictions for bridge redemption-credit tests.
 */
contract TestRestrictedUSDC is TestUSDC {
    mapping(address => bool) public blocked;

    function setBlocked(address account, bool status) external {
        require(msg.sender == deployer, "TestUSDC: only deployer");
        blocked[account] = status;
    }

    function _transfer(address sender, address recipient, uint256 amount) internal override {
        require(!blocked[sender] && !blocked[recipient], "TestUSDC: restricted transfer");
        super._transfer(sender, recipient, amount);
    }
}
