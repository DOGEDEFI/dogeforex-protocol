// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import './interface/IOracleFreeDollar.sol';

/**
 * @title GenesisBootstrapSale
 * @notice One-shot genesis minter for a DogeForex currency instance (K9USD...K9BRL).
 *
 * @dev Why this exists (the bootstrap problem): the MintingHub charges OPENING_FEE = 1,000 units
 * in currency to open the first position, `suggestMinter` costs >= 1,000 units, and the first
 * Equity deposit needs >= 1,000 units — but at genesis supply is 0 and nobody owns any units
 * (Frankencoin/OFD solved this with a source-stablecoin bridge registered at genesis; DogeOS has
 * no dollar rail, so the bridge role is played by this allocation minter instead).
 *
 * Registered as a minter through the token's deployer-gated `initialize()` at genesis (the
 * unavoidable bootstrap act — at supply 0 no veto is possible). Minter registrations are
 * permanent (`denyMinter` reverts TooLate once active), so safety comes from inertness by
 * construction: `execute()` mints the fixed genesis float exactly once and can never mint again.
 *
 * The float split (default 500k units per instance, see report/dogeos-tech-parts/03-collateral-
 * monetary.md §3.2): pool seed (Barkswap pool), equity (treasury tranche-1 investment), challenger
 * bounty, incentives. Recipients and amounts are immutable constructor parameters, so the only
 * trust assumption is the deployer who registers the contract — the same trust domain as the
 * genesis `initialize()` calls for Savings/PositionFactory/PositionRoller/MintingHub.
 *
 * If `execute()` never runs before `endTime`, the float is forfeited forever: with supply 0 the
 * 1,000-unit fees can never be paid, so no other minter can ever be suggested. This makes
 * endTime a hard deadline wired into the instance's genesis calendar.
 */
contract GenesisBootstrapSale {
    IOracleFreeDollar public immutable ofd;
    uint256 public immutable endTime;

    address public immutable poolSeedRecipient;
    address public immutable equityRecipient;
    address public immutable challengerBountyRecipient;
    address public immutable incentivesRecipient;

    uint256 public immutable poolSeedAmount; // e.g. 100_000e18
    uint256 public immutable equityAmount; // e.g. 250_000e18
    uint256 public immutable challengerBountyAmount; // e.g. 50_000e18
    uint256 public immutable incentivesAmount; // e.g. 100_000e18
    uint256 public immutable totalFloat; // sum of the four allocations

    bool public executed;

    event BootstrapExecuted(
        address indexed executor,
        address indexed poolSeedRecipient,
        uint256 poolSeedAmount,
        address indexed equityRecipient,
        uint256 equityAmount,
        address challengerBountyRecipient,
        uint256 challengerBountyAmount,
        address incentivesRecipient,
        uint256 incentivesAmount
    );

    error AlreadyExecuted();
    error SaleExpired();

    constructor(
        IOracleFreeDollar ofd_,
        uint256 endTime_,
        address poolSeedRecipient_,
        address equityRecipient_,
        address challengerBountyRecipient_,
        address incentivesRecipient_,
        uint256 poolSeedAmount_,
        uint256 equityAmount_,
        uint256 challengerBountyAmount_,
        uint256 incentivesAmount_
    ) {
        ofd = ofd_;
        endTime = endTime_;
        poolSeedRecipient = poolSeedRecipient_;
        equityRecipient = equityRecipient_;
        challengerBountyRecipient = challengerBountyRecipient_;
        incentivesRecipient = incentivesRecipient_;
        poolSeedAmount = poolSeedAmount_;
        equityAmount = equityAmount_;
        challengerBountyAmount = challengerBountyAmount_;
        incentivesAmount = incentivesAmount_;
        totalFloat = poolSeedAmount_ + equityAmount_ + challengerBountyAmount_ + incentivesAmount_;
    }

    /**
     * @notice Mint the genesis float once. Callable by anyone: recipients and amounts are
     * immutable, so the caller has no influence over the outcome.
     */
    function execute() external {
        if (executed) revert AlreadyExecuted();
        if (block.timestamp > endTime) revert SaleExpired();
        executed = true;
        ofd.mint(poolSeedRecipient, poolSeedAmount);
        ofd.mint(equityRecipient, equityAmount);
        ofd.mint(challengerBountyRecipient, challengerBountyAmount);
        ofd.mint(incentivesRecipient, incentivesAmount);
        emit BootstrapExecuted(
            msg.sender,
            poolSeedRecipient,
            poolSeedAmount,
            equityRecipient,
            equityAmount,
            challengerBountyRecipient,
            challengerBountyAmount,
            incentivesRecipient,
            incentivesAmount
        );
    }
}
