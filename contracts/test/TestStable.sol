// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "../utils/ERC20.sol";

/**
 * @title TestStable — DogeForex test stablecoin (testnet only).
 * @notice Per-currency source stablecoin for the StablecoinBridge bootstrap simulation (G1):
 * the DogeOS stand-in for the XCHF-style rail Frankencoin bootstrapped from. 18 decimals,
 * 1 unit = 1 fiat unit by convention, deployer-gated mint (MOFX pattern, contracts/test/MOFX.sol).
 * One deploy per K9 currency; each instance's bridge locks/mints 1:1 against its own unit.
 */
contract TestStable is ERC20 {
    address public immutable deployer;
    string private _name;
    string private _symbol;

    constructor(string memory name_, string memory symbol_) ERC20(18) {
        deployer = msg.sender;
        _name = name_;
        _symbol = symbol_;
        _mint(msg.sender, 1_000_000 * 1e18);
    }

    function name() external view override returns (string memory) {
        return _name;
    }

    function symbol() external view override returns (string memory) {
        return _symbol;
    }

    function mint(address account, uint256 amount) external {
        require(msg.sender == deployer, "TestStable: only deployer");
        _mint(account, amount);
    }
}
