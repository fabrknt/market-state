// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {MarketStateRegistry} from "../src/MarketStateRegistry.sol";
import {MarketStateCheck} from "../src/MarketStateCheck.sol";

contract Reader {
    function requireOpen(MarketStateRegistry r, address token, uint256 maxAge) external view {
        MarketStateCheck.requireOpen(r, token, maxAge);
    }
}

contract MarketStateRegistryTest is Test {
    MarketStateRegistry reg;
    Reader reader;
    address guard = address(0x6A);
    address token = address(0x70);

    function setUp() public {
        vm.warp(1_800_000_000);
        reg = new MarketStateRegistry(address(this));
        reg.setUpdater(guard, true);
        reader = new Reader();
    }

    function test_onlyOwnerSetsUpdaters() public {
        vm.prank(guard);
        vm.expectRevert(MarketStateRegistry.NotOwner.selector);
        reg.setUpdater(guard, false);
    }

    function test_onlyUpdaterWrites() public {
        vm.expectRevert(MarketStateRegistry.NotUpdater.selector);
        reg.setState(token, true, 1, 0);
        address[] memory ts = new address[](1);
        ts[0] = token;
        vm.expectRevert(MarketStateRegistry.NotUpdater.selector);
        reg.heartbeat(ts);
    }

    function test_neverWrittenIsStale() public {
        vm.expectRevert(abi.encodeWithSelector(MarketStateCheck.MarketStateStale.selector, uint64(0)));
        reader.requireOpen(reg, token, 300);
    }

    function test_openThenHalted() public {
        vm.prank(guard);
        reg.setState(token, false, 0, 0);
        reader.requireOpen(reg, token, 300);

        uint8 primaryHalt = reg.REASON_PRIMARY_HALT();
        vm.prank(guard);
        reg.setState(token, true, primaryHalt, 0);
        vm.expectRevert(abi.encodeWithSelector(MarketStateCheck.MarketHalted.selector, uint8(1)));
        reader.requireOpen(reg, token, 300);
    }

    function test_reasonClearedWhenNotHalted() public {
        vm.prank(guard);
        reg.setState(token, false, 5, 0);
        assertEq(reg.stateOf(token).reason, 0);
    }

    function test_quietGuardFailsClosed() public {
        vm.prank(guard);
        reg.setState(token, false, 0, 0);
        vm.warp(block.timestamp + 301);
        vm.expectRevert(
            abi.encodeWithSelector(MarketStateCheck.MarketStateStale.selector, uint64(block.timestamp - 301))
        );
        reader.requireOpen(reg, token, 300);

        address[] memory ts = new address[](1);
        ts[0] = token;
        vm.prank(guard);
        reg.heartbeat(ts);
        reader.requireOpen(reg, token, 300);
    }

    function test_resumeAfter() public {
        uint64 resume = uint64(block.timestamp + 600);
        vm.prank(guard);
        reg.setState(token, false, 0, resume);
        vm.expectRevert(abi.encodeWithSelector(MarketStateCheck.NotYetResumed.selector, resume));
        reader.requireOpen(reg, token, 300);
        vm.warp(resume);
        address[] memory ts = new address[](1);
        ts[0] = token;
        vm.prank(guard);
        reg.heartbeat(ts);
        reader.requireOpen(reg, token, 300);
    }

    function test_emitsOnlyOnChange() public {
        vm.recordLogs();
        vm.startPrank(guard);
        reg.setState(token, true, 1, 0);
        reg.setState(token, true, 1, 0);
        vm.stopPrank();
        assertEq(vm.getRecordedLogs().length, 1);
    }
}
