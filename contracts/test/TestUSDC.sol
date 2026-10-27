// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "../utils/ERC20.sol";

/**
 * @title Test USDC
 * @notice Test-only six-decimal source asset. It has no real collateral value.
 */
contract TestUSDC is ERC20 {
    address public immutable deployer;

    constructor() ERC20(6) {
        deployer = msg.sender;
    }

    function name() external pure override returns (string memory) {
        return "Test USDC";
    }

    function symbol() external pure override returns (string memory) {
        return "tUSDC";
    }

    function mint(address account, uint256 amount) external {
        require(msg.sender == deployer, "TestUSDC: only deployer");
        _mint(account, amount);
    }
}
