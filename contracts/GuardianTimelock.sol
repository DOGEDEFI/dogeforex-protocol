// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title GuardianTimelock
 * @notice Holds the guardian key (the 3-of-5 Ops Safe) for the DogeForex admission gate.
 * @dev Scope is deliberately narrow (see report/dogeos-tech-parts/02-deployment-architecture.md C.2/C.4):
 *
 *  - The guardian can PAUSE admissions instantly: while paused, `OracleFreeDollar.suggestMinter`,
 *    `MintingHub.openPosition`, and `MintingHub.clone` revert. Transfers, minting on existing
 *    positions, repayments, savings, challenges, and auctions are NEVER pausable.
 *  - Unpausing and guardian rotation require enqueueing + waiting the 72h TIMELOCK. 72h is strictly
 *    shorter than the 14-day minter application window and the 5-day position init period, so any
 *    guardian misuse must surface within those windows while emergency recovery stays fast.
 *
 * The protocol contracts (token + hub) hold only the guardian's address and read `paused()`;
 * all privileged logic lives here. If the guardian address is never set on the token, the gate
 * is open and behavior is identical to upstream Frankencoin/OFD.
 */
contract GuardianTimelock {
    uint256 public constant TIMELOCK = 72 hours;

    address public guardian; // the Ops Safe (3-of-5)
    bool public paused;

    uint256 public unpauseAvailableAt; // earliest timestamp a scheduled unpause may execute
    address public pendingGuardian; // next guardian after the timelock elapses
    uint256 public guardianChangeAvailableAt; // earliest timestamp the rotation may execute

    event Paused(address indexed by);
    event UnpauseScheduled(address indexed by, uint256 availableAt);
    event Unpaused(address indexed by);
    event GuardianRotationScheduled(address indexed currentGuardian, address indexed pendingGuardian, uint256 availableAt);
    event GuardianRotated(address indexed previousGuardian, address indexed newGuardian);

    error NotGuardian();
    error TimelockPending();
    error InvalidGuardian();

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian();
        _;
    }

    constructor(address guardian_) {
        if (guardian_ == address(0)) revert InvalidGuardian();
        guardian = guardian_;
    }

    /**
     * @notice Instantly pause new admissions. Callable only by the guardian.
     */
    function pause() external onlyGuardian {
        paused = true;
        emit Paused(msg.sender);
    }

    /**
     * @notice Start the 72h countdown after which the gate may be reopened.
     */
    function scheduleUnpause() external onlyGuardian {
        unpauseAvailableAt = block.timestamp + TIMELOCK;
        emit UnpauseScheduled(msg.sender, unpauseAvailableAt);
    }

    /**
     * @notice Reopen admissions after the 72h timelock has elapsed.
     */
    function unpause() external onlyGuardian {
        if (unpauseAvailableAt == 0 || block.timestamp < unpauseAvailableAt) revert TimelockPending();
        paused = false;
        unpauseAvailableAt = 0;
        emit Unpaused(msg.sender);
    }

    /**
     * @notice Propose a new guardian (e.g. Safe rotation). Takes effect only after 72h.
     */
    function scheduleGuardianRotation(address newGuardian) external onlyGuardian {
        if (newGuardian == address(0)) revert InvalidGuardian();
        pendingGuardian = newGuardian;
        guardianChangeAvailableAt = block.timestamp + TIMELOCK;
        emit GuardianRotationScheduled(guardian, newGuardian, guardianChangeAvailableAt);
    }

    /**
     * @notice Execute a previously scheduled guardian rotation after the timelock elapsed.
     * @dev Callable by the current guardian (the key being rotated out executes its own handover,
     * which is what makes the rotation reviewable on-chain before it takes effect).
     */
    function rotateGuardian() external onlyGuardian {
        if (pendingGuardian == address(0) || block.timestamp < guardianChangeAvailableAt) revert TimelockPending();
        emit GuardianRotated(guardian, pendingGuardian);
        guardian = pendingGuardian;
        pendingGuardian = address(0);
        guardianChangeAvailableAt = 0;
    }
}
