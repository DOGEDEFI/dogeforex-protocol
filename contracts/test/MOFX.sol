// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "../utils/ERC20.sol";

/**
 * @title MOFX — DogeForex mock FX collateral (testnet only).
 * @notice One shared 18-decimals test token for all DogeForex instances with the canonical
 * convention 1 MOFX = $1 (runbook §0.6). Minting is deployer-gated. Mainnet collateral is
 * wDOGE only; MOFX exists so scripted positions can rehearse the MintingHub code path on
 * Chikyu within the faucet budget (runbook §4.1).
 */
contract MOFX is ERC20 {
    address public immutable deployer;

    constructor() ERC20(18) {
        deployer = msg.sender;
        _mint(msg.sender, 1_000_000 * 1e18);
    }

    function name() external pure override returns (string memory) {
        return "DogeForex Mock FX";
    }

    function symbol() external pure override returns (string memory) {
        return "MOFX";
    }

    function mint(address account, uint256 amount) external {
        require(msg.sender == deployer, "MOFX: only deployer");
        _mint(account, amount);
    }
}
