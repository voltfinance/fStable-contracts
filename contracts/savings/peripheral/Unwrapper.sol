// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.6;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ImmutableModule } from "../../shared/ImmutableModule.sol";

import { ISavingsContractV4 } from "../../interfaces/ISavingsContract.sol";
import { IUnwrapper } from "../../interfaces/IUnwrapper.sol";
import { IFasset } from "../../interfaces/IFasset.sol";
import { IFeederPool } from "../../interfaces/IFeederPool.sol";
import { IBoostedVaultWithLockup } from "../../interfaces/IBoostedVaultWithLockup.sol";
import { BassetPersonal } from "../../fasset/FassetStructs.sol";

/**
 * @title  Unwrapper
 * @author mStable
 * @notice Used to exchange interest-bearing fAssets or fAssets to base assets (bAssets) or Feeder Pool assets (fdAssets).
 * @dev    VERSION: 1.0
 *         DATE:    2022-01-31
 */
contract Unwrapper is IUnwrapper, ImmutableModule {
    using SafeERC20 for IERC20;

    constructor(address _nexus) ImmutableModule(_nexus) {}

    /**
     * @notice Query whether output address is a bAsset for given interest-bearing fAsset or fAsset. eg DAI is a bAsset of ifUSD.
     * @param _input          Address of either interest-bearing fAsset or fAsset. eg ifUSD or fUSD.
     * @param _inputIsCredit  `true` if `input` is an interest-bearing fAsset, eg ifUSD. `false` if `input` is an fAsset, eg fUSD.
     * @param _output         Address to test if a bAsset token of the `input`.
     * @return isBassetOut    `true` if `output` is a bAsset. `false` if `output` is not a bAsset.
     */
    function getIsBassetOut(
        address _input,
        bool _inputIsCredit,
        address _output
    ) external view override returns (bool isBassetOut) {
        address input = _inputIsCredit ? address(ISavingsContractV4(_input).underlying()) : _input;
        (BassetPersonal[] memory bAssets, ) = IFasset(input).getBassets();
        for (uint256 i = 0; i < bAssets.length; i++) {
            if (bAssets[i].addr == _output) return true;
        }
        return false;
    }

    /**
     * @notice Estimate units of bAssets or fdAssets in exchange for interest-bearing fAssets or fAssets.
     * @param _isBassetOut    `true` if `output` is a bAsset. `false` if `output` is a fdAsset.
     * @param _router         fAsset address if the `output` is a bAsset. Feeder Pool address if the `output` is a fdAsset.
     * @param _input          Token address of either fAsset or interest-bearing fAsset. eg fUSD, ifUSD, mBTC or imBTC.
     * @param _inputIsCredit  `true` if interest-beaing fAsset like ifUSD or imBTC. `false` if fAsset like fUSD or mBTC.
     * @param _output         Asset to receive in exchange for the `input` token. This can be a bAsset or a fdAsset. For example:
        - bAssets (USDC, DAI, sUSD or USDT) or fdAssets (GUSD, BUSD, alUSD, FEI or RAI) for fUSD.
        - bAssets (USDC, DAI or USDT) or fdAsset FRAX for Polygon fUSD.
        - bAssets (WBTC, sBTC or renBTC) or fdAssets (HBTC or TBTCV2) for mainnet mBTC.
     * @param _amount         Units of `input` token.
     * @return outputQuantity Units of bAssets or fdAssets received in exchange for inputs. This is to the same decimal places as the `output` token.
     */
    function getUnwrapOutput(
        bool _isBassetOut,
        address _router,
        address _input,
        bool _inputIsCredit,
        address _output,
        uint256 _amount
    ) external view override returns (uint256 outputQuantity) {
        uint256 amt = _inputIsCredit
            ? ISavingsContractV4(_input).creditsToUnderlying(_amount)
            : _amount;
        if (_isBassetOut) {
            outputQuantity = IFasset(_router).getRedeemOutput(_output, amt);
        } else {
            address input = _inputIsCredit
                ? address(ISavingsContractV4(_input).underlying())
                : _input;
            outputQuantity = IFeederPool(_router).getSwapOutput(input, _output, amt);
        }
    }

    /**
     * @notice Swaps fAssets for either bAssets or fdAssets.
     * Transfers fAssets to this Unwrapper contract and then either
     * 1. redeems fAsset tokens for bAsset tokens.
     * 2. Swaps fAsset tokens for fdAsset tokens using a Feeder Pool.
     * @param _isBassetOut    `true` if `output` is a bAsset. `false` if `output` is a fdAsset.
     * @param _router         fAsset address if the `output` is a bAsset. Feeder Pool address if the `output` is a fdAsset.
     * @param _input          fAsset address
     * @param _output         Asset to receive in exchange for the redeemed fAssets. This can be a bAsset or a fdAsset. For example:
        - bAssets (USDC, DAI, sUSD or USDT) or fdAssets (GUSD, BUSD, alUSD, FEI or RAI) for fUSD.
        - bAssets (USDC, DAI or USDT) or fdAsset FRAX for Polygon fUSD.
        - bAssets (WBTC, sBTC or renBTC) or fdAssets (HBTC or TBTCV2) for mainnet mBTC.
     * @param _amount         Units of fAssets that have been redeemed.
     * @param _minAmountOut   Minimum units of `output` tokens to be received by the beneficiary. This is to the same decimal places as the `output` token.
     * @param _beneficiary    Address to send `output` tokens to.
     * @return outputQuantity Units of `output` tokens sent to the `beneficiary`.
     */
    function unwrapAndSend(
        bool _isBassetOut,
        address _router,
        address _input,
        address _output,
        uint256 _amount,
        uint256 _minAmountOut,
        address _beneficiary
    ) external override returns (uint256 outputQuantity) {
        require(IERC20(_input).transferFrom(msg.sender, address(this), _amount), "Transfer input");

        if (_isBassetOut) {
            outputQuantity = IFasset(_router).redeem(_output, _amount, _minAmountOut, _beneficiary);
        } else {
            outputQuantity = IFeederPool(_router).swap(
                _input,
                _output,
                _amount,
                _minAmountOut,
                _beneficiary
            );
        }
    }

    /**
     * @notice Approve fAsset tokens to be transferred to fAsset or Feeder Pool contracts for `redeem` to bAssets or `swap` for fdAssets.
     * @param _spenders Address of fAssets and Feeder Pools that will `redeem` or `swap` the fAsset tokens.
     * @param _tokens   Address of the fAssets that will be redeemed or swapped.
     */
    function approve(address[] calldata _spenders, address[] calldata _tokens)
        external
        onlyGovernor
    {
        require(_spenders.length == _tokens.length, "Array mismatch");
        for (uint256 i = 0; i < _tokens.length; i++) {
            require(_tokens[i] != address(0), "Invalid token");
            require(_spenders[i] != address(0), "Invalid router");
            IERC20(_tokens[i]).safeApprove(_spenders[i], type(uint256).max);
        }
    }
}
