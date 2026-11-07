// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/// @title MarketStateRegistry
/// @notice The off-chain guard (ts/guard.ts in this package) writes each token's market state here: halts on the
///         primary exchange, bad-print freezes, and closed sessions. Readers fail closed when the guard
///         goes quiet, so a stopped guard stops trading instead of letting it run unchecked.
contract MarketStateRegistry {
    uint8 public constant REASON_NONE = 0;
    uint8 public constant REASON_PRIMARY_HALT = 1; // halted or suspended on the primary listing exchange
    uint8 public constant REASON_BAD_PRINT = 2; // reference price moved outside the band
    uint8 public constant REASON_SESSION_CLOSED = 3; // scenario only trades during a session
    uint8 public constant REASON_CORPORATE_ACTION = 4; // issuer-announced pause around an action
    uint8 public constant REASON_MANUAL = 5;
    uint8 public constant REASON_ISSUER_PAUSED = 6;

    struct State {
        bool halted;
        uint8 reason;
        uint64 updatedAt; // last time the guard confirmed this state (heartbeat)
        uint64 resumeAfter; // even when not halted, no trading before this time
    }

    address public owner;
    mapping(address => bool) public isUpdater;
    mapping(address token => State) internal _states;

    event UpdaterSet(address indexed updater, bool allowed);
    event MarketStateChanged(address indexed token, bool halted, uint8 reason, uint64 resumeAfter);
    event OwnerTransferred(address indexed newOwner);

    error NotOwner();
    error NotUpdater();

    constructor(address owner_) {
        owner = owner_;
        emit OwnerTransferred(owner_);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyUpdater() {
        if (!isUpdater[msg.sender]) revert NotUpdater();
        _;
    }

    function transferOwner(address newOwner) external onlyOwner {
        owner = newOwner;
        emit OwnerTransferred(newOwner);
    }

    function setUpdater(address updater, bool allowed) external onlyOwner {
        isUpdater[updater] = allowed;
        emit UpdaterSet(updater, allowed);
    }

    /// @notice Sets the state; emits only when the state itself changes so the event log is the
    ///         machine-readable halt notice for participants.
    function setState(address token, bool halted, uint8 reason, uint64 resumeAfter) public onlyUpdater {
        State storage s = _states[token];
        bool changed = s.halted != halted || s.reason != reason || s.resumeAfter != resumeAfter;
        s.halted = halted;
        s.reason = halted ? reason : REASON_NONE;
        s.resumeAfter = resumeAfter;
        s.updatedAt = uint64(block.timestamp);
        if (changed) emit MarketStateChanged(token, halted, s.reason, resumeAfter);
    }

    /// @notice Confirms the current state of each token without changing it.
    function heartbeat(address[] calldata tokens) external onlyUpdater {
        for (uint256 i; i < tokens.length; ++i) {
            _states[tokens[i]].updatedAt = uint64(block.timestamp);
        }
    }

    function stateOf(address token) external view returns (State memory) {
        return _states[token];
    }
}
