// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.6;

import { ISavingsManager } from "../interfaces/ISavingsManager.sol";
import { ImmutableModule } from "../shared/ImmutableModule.sol";

/**
 * @title Collector
 * @dev Distributes unallocated interest across multiple fAssets via savingsManager
 */
contract Collector is ImmutableModule {
    constructor(address _nexus) ImmutableModule(_nexus) {}

    /**
     * @dev Distributes the interest accrued across multiple fAssets, optionally
     * calling collectAndDistribute beforehand.
     */
    function distributeInterest(address[] calldata _fAssets, bool _collectFirst) external {
        ISavingsManager savingsManager = ISavingsManager(_savingsManager());
        uint256 len = _fAssets.length;
        require(len > 0, "Invalid inputs");
        for (uint256 i = 0; i < len; i++) {
            if (_collectFirst) savingsManager.collectAndDistributeInterest(_fAssets[i]);

            savingsManager.distributeUnallocatedInterest(_fAssets[i]);
        }
    }
}
