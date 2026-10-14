// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title GuardianTimelock interface
 * @notice Minimal surface the protocol contracts need: the paused flag. Everything else
 * (pause scheduling, guardian rotation) happens inside the GuardianTimelock.
 */
interface IGuardianTimelock {
    function paused() external view returns (bool);
}
