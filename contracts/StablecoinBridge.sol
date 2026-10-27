// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./interface/IERC20.sol";
import "./interface/IOracleFreeDollar.sol";

/**
 * @title Source Stablecoin Bridge
 * @notice Locks a trusted source stablecoin and mints an equal nominal number of local currency units.
 */
contract StablecoinBridge {
    IERC20 public immutable usd;
    IOracleFreeDollar public immutable ofd;

    /**
     * @notice The time horizon after which this bridge stops accepting new source deposits.
     */
    uint256 public immutable horizon;

    /**
     * @notice The multiplier from source-token raw units to 18-decimal local currency raw units.
     */
    uint256 public immutable decimalMultiplier;

    /**
     * @notice The maximum outstanding local currency amount attributable to this bridge, in 18 decimals.
     */
    uint256 public immutable limit;
    uint256 public minted;

    mapping(address => uint256) public credits;

    event Mint(address indexed target, uint256 amount);
    event Burn(address indexed holder, uint256 amount);
    event Credit(address indexed target, uint256 amount);
    event Payout(address indexed target, uint256 amount);

    error Limit(uint256 amount, uint256 limit);
    error Expired(uint256 time, uint256 expiration);

    /**
     * @dev The source token must have fixed decimals no greater than the local token's 18 decimals.
     * The limit and minted amount are denominated in local 18-decimal units.
     */
    constructor(address other, address ofdAddress, uint256 limit_) {
        usd = IERC20(other);
        ofd = IOracleFreeDollar(ofdAddress);
        horizon = block.timestamp + 52 weeks;
        decimalMultiplier = 10 ** (ofd.decimals() - usd.decimals());
        limit = limit_;
        minted = 0;
    }

    function mint(uint256 amount) external {
        mintTo(msg.sender, amount);
    }

    /**
     * @notice Locks raw source-token units and mints the corresponding 18-decimal local currency amount.
     */
    function mintTo(address target, uint256 amount) public {
        usd.transferFrom(msg.sender, address(this), amount);
        _mint(target, amount * decimalMultiplier);
    }

    function _mint(address target, uint256 amount) internal {
        if (block.timestamp > horizon) revert Expired(block.timestamp, horizon);
        ofd.mint(target, amount);
        minted += amount;
        if (minted > limit) revert Limit(amount, limit);
        emit Mint(target, amount);
    }

    function burn(uint256 amount) external {
        uint256 sourceAmount = amount / decimalMultiplier;
        _burn(msg.sender, sourceAmount * decimalMultiplier);
        usd.transfer(msg.sender, sourceAmount);
    }

    /**
     * @notice Burns local 18-decimal units, rounded down to a whole source-token unit, and sends source tokens.
     */
    function burnAndSend(address target, uint256 amount) external {
        uint256 sourceAmount = amount / decimalMultiplier;
        _burn(msg.sender, sourceAmount * decimalMultiplier);
        usd.transfer(target, sourceAmount);
    }

    /**
     * @notice Burns 18-decimal local units, rounded down to a whole source-token unit, and credits the raw source amount for a later permissionless payout.
     */
    function burnAndCredit(address target, uint256 amount) external {
        uint256 sourceAmount = amount / decimalMultiplier;
        _burn(msg.sender, sourceAmount * decimalMultiplier);
        credits[target] += sourceAmount;
        emit Credit(target, sourceAmount);
    }

    function balanceOf(address account) external view returns (uint256) {
        return credits[account];
    }

    function payoutCredit(address target) external {
        uint256 amount = credits[target];
        credits[target] = 0;
        usd.transfer(target, amount);
        emit Payout(target, amount);
    }

    function _burn(address holder, uint256 amount) internal {
        ofd.burnFrom(holder, amount);
        minted -= amount;
        emit Burn(holder, amount);
    }
}
