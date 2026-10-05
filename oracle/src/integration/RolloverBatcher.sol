// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface IRolloverTarget {
    function epoch() external view returns (uint64, uint64, uint64, uint64, uint64, int256, bool);
    function work() external view returns (uint8);
    function cursor() external view returns (uint256);
    function sweepCount() external view returns (uint256);
    function beginRollover() external;
    function rollPage(uint8 maximum) external returns (bool);
    function finishRollover() external;
}

/// @notice Permissionless bounded composition of an engine's existing rollover operations.
/// @dev Holds no funds or privileges. Every economic check remains in the target engine.
/// Callers must pin the helper and engine identities and measure the chosen batch's gas.
contract RolloverBatcher {
    error InvalidTarget();
    error InvalidBounds();
    error StaleSnapshot();
    error InvalidProgress();

    event RolloverAdvanced(
        address indexed engine, uint64 indexed epoch, uint256 cursor, uint256 count, uint8 pages, bool completed
    );

    function rollover(address engine, uint64 expectedEpoch, uint8 expectedWork, uint256 expectedCursor, uint8 maxPages)
        external
        returns (uint8 pages, bool completed)
    {
        if (engine.code.length == 0 || engine == address(this)) revert InvalidTarget();
        if (maxPages == 0 || maxPages > 32 || expectedWork > 1) revert InvalidBounds();
        IRolloverTarget target = IRolloverTarget(engine);
        (uint64 epochId,,,,,,) = target.epoch();
        if (epochId != expectedEpoch || target.work() != expectedWork || target.cursor() != expectedCursor) {
            revert StaleSnapshot();
        }
        if (expectedWork == 0) target.beginRollover();
        uint256 next = target.cursor();
        uint256 count = target.sweepCount();
        if (target.work() != 1 || count > 1024 || next > count) revert InvalidProgress();
        while (next < count && pages < maxPages) {
            uint256 wanted = next + 32;
            if (wanted > count) wanted = count;
            bool done = target.rollPage(32);
            next = target.cursor();
            if (next != wanted || target.sweepCount() != count || target.work() != 1 || done != (next == count)) {
                revert InvalidProgress();
            }
            ++pages;
        }
        if (next == count) {
            target.finishRollover();
            (uint64 opened,,,,,,) = target.epoch();
            if (opened != uint256(expectedEpoch) + 1 || target.work() != 0 || target.cursor() != count) {
                revert InvalidProgress();
            }
            completed = true;
        }
        emit RolloverAdvanced(engine, expectedEpoch, next, count, pages, completed);
    }
}
