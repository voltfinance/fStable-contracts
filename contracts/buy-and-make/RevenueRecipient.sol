// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.6;

import { IRevenueRecipient } from "../interfaces/IRevenueRecipient.sol";
import { IBPool } from "./IBPool.sol";
import { ImmutableModule } from "../shared/ImmutableModule.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title   RevenueRecipient
 * @author  mStable
 * @notice  Simply receives fAssets and then deposits to a pre-defined Balancer
 *          Bpool.
 * @dev     VERSION: 2.0
 *          DATE:    2021-04-06
 */
contract RevenueRecipient is IRevenueRecipient, ImmutableModule {
    using SafeERC20 for IERC20;

    event RevenueReceived(address indexed fAsset, uint256 amountIn);
    event RevenueDeposited(address indexed fAsset, uint256 amountIn, uint256 amountOut);

    // BPT To which all revenue should be deposited
    IBPool public immutable mBPT;
    IERC20 public immutable BAL;

    // Minimum output units per 1e18 input units
    mapping(address => uint256) public minOut;

    /**
     * @dev Creates the RevenueRecipient contract
     * @param _nexus      mStable system Nexus address
     * @param _targetPool Balancer pool to which all revenue should be deposited
     * @param _balToken   Address of $BAL
     * @param _assets     Initial list of supported fAssets
     * @param _minOut     Minimum BPT out per fAsset unit
     */
    constructor(
        address _nexus,
        address _targetPool,
        address _balToken,
        address[] memory _assets,
        uint256[] memory _minOut
    ) ImmutableModule(_nexus) {
        mBPT = IBPool(_targetPool);
        BAL = IERC20(_balToken);
        uint256 len = _assets.length;
        for (uint256 i = 0; i < len; i++) {
            minOut[_assets[i]] = _minOut[i];
            IERC20(_assets[i]).safeApprove(_targetPool, 2**256 - 1);
        }
    }

    /**
     * @dev Simply transfers the fAsset from the sender to here
     * @param _fAsset Address of fAsset
     * @param _amount Units of fAsset collected
     */
    function notifyRedistributionAmount(address _fAsset, uint256 _amount) external override {
        // Transfer from sender to here
        IERC20(_fAsset).safeTransferFrom(msg.sender, address(this), _amount);

        emit RevenueReceived(_fAsset, _amount);
    }

    /**
     * @dev Called by anyone to deposit to the balancer pool
     * @param _fAssets Addresses of assets to deposit
     * @param _percentages 1e18 scaled percentages of the current balance to deposit
     */
    function depositToPool(address[] calldata _fAssets, uint256[] calldata _percentages)
        external
        override
    {
        uint256 len = _fAssets.length;
        require(len > 0 && len == _percentages.length, "Invalid args");

        for (uint256 i = 0; i < len; i++) {
            uint256 pct = _percentages[i];
            require(pct > 1e15 && pct <= 1e18, "Invalid pct");
            address fAsset = _fAssets[i];
            uint256 bal = IERC20(fAsset).balanceOf(address(this));
            // e.g. 1 * 5e17 / 1e18 = 5e17
            uint256 deposit = (bal * pct) / 1e18;
            require(minOut[fAsset] > 0, "Invalid minout");
            uint256 minBPT = (deposit * minOut[fAsset]) / 1e18;
            uint256 poolAmountOut = mBPT.joinswapExternAmountIn(fAsset, deposit, minBPT);

            emit RevenueDeposited(fAsset, deposit, poolAmountOut);
        }
    }

    /**
     * @dev Simply approves spending of a given asset by BPT
     * @param asset Address of asset to approve
     */
    function approveAsset(address asset) external onlyGovernor {
        IERC20(asset).safeApprove(address(mBPT), 0);
        IERC20(asset).safeApprove(address(mBPT), 2**256 - 1);
    }

    /**
     * @dev Sets the minimum amount of BPT to receive for a given asset
     * @param _asset Address of fAsset
     * @param _minOut Scaled amount to receive per 1e18 fAsset units
     */
    function updateAmountOut(address _asset, uint256 _minOut) external onlyGovernor {
        minOut[_asset] = _minOut;
    }

    /**
     * @dev Migrates BPT and BAL to a new revenue recipient
     * @param _recipient Address of recipient
     */
    function migrate(address _recipient) external onlyGovernor {
        IERC20 mBPT_ = IERC20(address(mBPT));
        mBPT_.safeTransfer(_recipient, mBPT_.balanceOf(address(this)));
        BAL.safeTransfer(_recipient, BAL.balanceOf(address(this)));
    }

    /**
     * @dev Reinvests any accrued $BAL tokens back into the pool
     * @param _pool         Address of the bPool to swap into
     * @param _output       Token to receive out of the swap (must be in mBPT)
     * @param _minAmountOut TOTAL amount out for the $BAL -> _output swap
     * @param _maxPrice     MaxPrice for the output (req by bPool)
     * @param _pct          Percentage of all BAL held here to liquidate
     */
    function reinvestBAL(
        address _pool,
        address _output,
        uint256 _minAmountOut,
        uint256 _maxPrice,
        uint256 _pct
    ) external onlyGovernor {
        require(minOut[_output] > 0, "Invalid output");
        require(_pct > 1e15 && _pct <= 1e18, "Invalid pct");
        uint256 balance = BAL.balanceOf(address(this));
        uint256 balDeposit = (balance * _pct) / 1e18;
        // 1. Convert BAL to ETH
        BAL.approve(_pool, balDeposit);
        (uint256 tokenAmountOut, ) = IBPool(_pool).swapExactAmountIn(
            address(BAL),
            balDeposit,
            _output,
            _minAmountOut,
            _maxPrice
        );
        // 2. Deposit ETH to mBPT
        uint256 poolAmountOut = mBPT.joinswapExternAmountIn(
            _output,
            tokenAmountOut,
            (tokenAmountOut * minOut[_output]) / 1e18
        );

        emit RevenueDeposited(_output, tokenAmountOut, poolAmountOut);
    }
}
