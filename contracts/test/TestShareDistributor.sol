// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "../Equity.sol";

contract TestShareDistributor {
    function split(Equity equity, address twoPercentHolder, address remainderHolder) external {
        equity.invest(100 ether, 1000 ether);
        equity.transfer(twoPercentHolder, 20 ether);
        equity.transfer(remainderHolder, 980 ether);
    }
}
