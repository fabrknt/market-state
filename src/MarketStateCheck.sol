// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {MarketStateRegistry} from "./MarketStateRegistry.sol";

/// @title MarketStateCheck
/// @notice The reader's side of MarketStateRegistry, failing closed: a halted token, a state the guard
///         has not confirmed within `maxStateAge`, or a time before `resumeAfter` all revert.
library MarketStateCheck {
    error MarketHalted(uint8 reason);
    error MarketStateStale(uint64 updatedAt);
    error NotYetResumed(uint64 resumeAfter);

    function requireOpen(MarketStateRegistry registry, address token, uint256 maxStateAge) internal view {
        MarketStateRegistry.State memory s = registry.stateOf(token);
        if (s.halted) revert MarketHalted(s.reason);
        // a token the guard never wrote has updatedAt 0, so it is stale too
        if (uint256(s.updatedAt) + maxStateAge < block.timestamp) revert MarketStateStale(s.updatedAt);
        if (block.timestamp < s.resumeAfter) revert NotYetResumed(s.resumeAfter);
    }
}
