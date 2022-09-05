// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.6;

/**
 * @title ISavingsManager
 */
interface ISavingsManager {
    /** @dev Admin privs */
    function distributeUnallocatedInterest(address _fAsset) external;

    /** @dev Liquidator */
    function depositLiquidation(address _fAsset, uint256 _liquidation) external;

    /** @dev Liquidator */
    function collectAndStreamInterest(address _fAsset) external;

    /** @dev Public privs */
    function collectAndDistributeInterest(address _fAsset) external;

    /** @dev getter for public lastBatchCollected mapping */
    function lastBatchCollected(address _fAsset) external view returns (uint256);
}
