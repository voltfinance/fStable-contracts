// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.6;

import { IRevenueRecipient } from "../interfaces/IRevenueRecipient.sol";
import { ImmutableModule } from "../shared/ImmutableModule.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title   GaugeBriber
 * @author  mStable
 * @notice  Collect system revenue in fUSD, converts to MTA, funds bribe on Votium
 * @dev     VERSION: 1.0
 *          DATE:    2021-10-19
 */
contract GaugeBriber is IRevenueRecipient, ImmutableModule {
    using SafeERC20 for IERC20;

    event RevenueReceived(address indexed fAsset, uint256 amountIn);
    event Withdrawn(uint256 amountOut, uint256 amountToChild);

    IERC20 public immutable fusd;

    address public immutable keeper;
    address public briber;

    IRevenueRecipient public childRecipient;
    uint256 public feeSplit;

    uint256[2] public available;

    constructor(
        address _nexus,
        address _fusd,
        address _keeper,
        address _briber,
        address _childRecipient
    ) ImmutableModule(_nexus) {
        fusd = IERC20(_fusd);
        keeper = _keeper;
        briber = _briber;
        childRecipient = IRevenueRecipient(_childRecipient);
    }

    modifier keeperOrGovernor() {
        require(msg.sender == keeper || msg.sender == _governor(), "Only keeper or governor");
        _;
    }

    /**
     * @dev Simply transfers the fAsset from the sender to here
     * @param _fAsset Address of fAsset
     * @param _amount Units of fAsset collected
     */
    function notifyRedistributionAmount(address _fAsset, uint256 _amount) external override {
        require(_fAsset == address(fusd), "This Recipient is only for fUSD");
        // Transfer from sender to here
        IERC20(_fAsset).safeTransferFrom(msg.sender, address(this), _amount);

        available[0] += ((_amount * (1e18 - feeSplit)) / 1e18);
        available[1] += ((_amount * feeSplit) / 1e18);

        emit RevenueReceived(_fAsset, _amount);
    }

    /**
     * @dev Withdraws to bribing capacity
     */
    function forward() external keeperOrGovernor {
        uint256 amt = available[0];
        available[0] = 0;
        fusd.safeTransfer(briber, amt);

        uint256 amtChild = available[1];
        if (amtChild > 0) {
            available[1] = 0;
            childRecipient.notifyRedistributionAmount(address(fusd), amtChild);
        }
        emit Withdrawn(amt, amtChild);
    }

    /**
     * @dev Sets fee split details for child revenue recipient
     * @param _briber new briber
     * @param _newRecipient Address of child RevenueRecipient
     * @param _feeSplit Percentage of total received that goes to child
     */
    function setConfig(
        address _briber,
        address _newRecipient,
        uint256 _feeSplit
    ) external onlyGovernor {
        require(_feeSplit <= 5e17, "Must be less than 50%");
        require(_briber != address(0), "Invalid briber");
        briber = _briber;
        childRecipient = IRevenueRecipient(_newRecipient);
        feeSplit = _feeSplit;
    }

    /**
     * @dev Abstract override
     */
    function depositToPool(
        address[] calldata, /* _fAssets */
        uint256[] calldata /* _percentages */
    ) external override {}
}
