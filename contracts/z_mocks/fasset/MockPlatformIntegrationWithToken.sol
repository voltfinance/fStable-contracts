// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.6;

import { FassetHelpers } from "../../shared/FassetHelpers.sol";
import { MockPlatformIntegration } from "./MockPlatformIntegration.sol";

// Overrides approveRewardToken
contract MockPlatformIntegrationWithToken is MockPlatformIntegration {
    event RewardTokenApproved(address token, address spender);

    address rewardToken;

    constructor(
        address _nexus,
        address _platformAddress,
        address[] memory _bAssets,
        address[] memory _pTokens
    ) MockPlatformIntegration(_nexus, _platformAddress, _bAssets, _pTokens) {}

    // @override
    function approveRewardToken() external {
        address liquidator = nexus.getModule(keccak256("Liquidator"));
        require(liquidator != address(0), "Liquidator address cannot be zero");

        FassetHelpers.safeInfiniteApprove(rewardToken, liquidator);

        emit RewardTokenApproved(rewardToken, liquidator);
    }

    function setRewardToken(address _token) external {
        rewardToken = _token;
    }
}
