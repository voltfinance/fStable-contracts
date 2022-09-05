// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.6;

interface IRevenueRecipient {
    /** @dev Recipient */
    function notifyRedistributionAmount(address _fAsset, uint256 _amount) external;

    function depositToPool(address[] calldata _fAssets, uint256[] calldata _percentages) external;
}
