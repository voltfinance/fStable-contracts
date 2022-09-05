// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.6;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { IBoostedVaultWithLockup } from "../../interfaces/IBoostedVaultWithLockup.sol";
import { IFeederPool } from "../../interfaces/IFeederPool.sol";
import { IFasset } from "../../interfaces/IFasset.sol";
import { ISavingsContractV4 } from "../../interfaces/ISavingsContract.sol";
import { IUniswapV2Router02 } from "../../peripheral/Uniswap/IUniswapV2Router02.sol";
import { IBasicToken } from "../../shared/IBasicToken.sol";
import { ImmutableModule } from "../../shared/ImmutableModule.sol";

// FLOWS
// 0 - fAsset -> Savings Vault
// 1 - bAsset -> Save/Savings Vault via Mint
// 2 - fdAsset -> Save/Savings Vault via Feeder Pool
// 3 - ETH    -> Save/Savings Vault via Uniswap
contract SaveWrapper is ImmutableModule {
    using SafeERC20 for IERC20;

    constructor(address _nexus) ImmutableModule(_nexus) {}

    /**
     * @dev 0. Simply saves an fAsset and then into the vault
     * @param _fAsset   fAsset address
     * @param _save     Save address
     * @param _vault    Boosted Savings Vault address
     * @param _amount   Units of fAsset to deposit to savings
     */
    function saveAndStake(
        address _fAsset,
        address _save,
        address _vault,
        uint256 _amount
    ) external {
        _saveAndStake(_fAsset, _save, _vault, _amount, true, address(0));
    }

    /**
     * @dev 0. Simply saves an fAsset and then into the vault
     * @param _fAsset   fAsset address
     * @param _save     Save address
     * @param _vault    Boosted Savings Vault address
     * @param _amount   Units of fAsset to deposit to savings
     * @param _referrer Referrer address for this deposit.
     */
    function saveAndStake(
        address _fAsset,
        address _save,
        address _vault,
        uint256 _amount,
        address _referrer
    ) external {
        _saveAndStake(_fAsset, _save, _vault, _amount, true, _referrer);
    }

    /**
     * @dev 1. Mints an fAsset and then deposits to Save/Savings Vault
     * @param _fAsset       fAsset address
     * @param _bAsset       bAsset address
     * @param _save         Save address
     * @param _vault        Boosted Savings Vault address
     * @param _amount       Amount of bAsset to mint with
     * @param _minOut       Min amount of fAsset to get back
     * @param _stake        Add the ifAsset to the Boosted Savings Vault?
     */
    function saveViaMint(
        address _fAsset,
        address _save,
        address _vault,
        address _bAsset,
        uint256 _amount,
        uint256 _minOut,
        bool _stake
    ) external {
        _saveViaMint(_fAsset, _save, _vault, _bAsset, _amount, _minOut, _stake, address(0));
    }

    /**
     * @dev 1. Mints an fAsset and then deposits to Save/Savings Vault
     * @param _fAsset       fAsset address
     * @param _bAsset       bAsset address
     * @param _save         Save address
     * @param _vault        Boosted Savings Vault address
     * @param _amount       Amount of bAsset to mint with
     * @param _minOut       Min amount of fAsset to get back
     * @param _stake        Add the ifAsset to the Boosted Savings Vault?
     * @param _referrer     Referrer address for this deposit.
     */
    function saveViaMint(
        address _fAsset,
        address _save,
        address _vault,
        address _bAsset,
        uint256 _amount,
        uint256 _minOut,
        bool _stake,
        address _referrer
    ) external {
        _saveViaMint(_fAsset, _save, _vault, _bAsset, _amount, _minOut, _stake, _referrer);
    }

    /**
     * @dev 2. Swaps fdAsset for fAsset and then deposits to Save/Savings Vault
     * @param _fAsset             fAsset address
     * @param _save               Save address
     * @param _vault              Boosted Savings Vault address
     * @param _feeder             Feeder Pool address
     * @param _fdAsset             fdAsset address
     * @param _fdAssetQuantity     Quantity of fdAsset sent
     * @param _minOutputQuantity  Min amount of fAsset to be swapped and deposited
     * @param _stake              Deposit the ifAsset in the Savings Vault?
     */
    function saveViaSwap(
        address _fAsset,
        address _save,
        address _vault,
        address _feeder,
        address _fdAsset,
        uint256 _fdAssetQuantity,
        uint256 _minOutputQuantity,
        bool _stake
    ) external {
        _saveViaSwap(
            _fAsset,
            _save,
            _vault,
            _feeder,
            _fdAsset,
            _fdAssetQuantity,
            _minOutputQuantity,
            _stake,
            address(0)
        );
    }

    /**
     * @dev 2. Swaps fdAsset for fAsset and then deposits to Save/Savings Vault
     * @param _fAsset             fAsset address
     * @param _save               Save address
     * @param _vault              Boosted Savings Vault address
     * @param _feeder             Feeder Pool address
     * @param _fdAsset             fdAsset address
     * @param _fdAssetQuantity     Quantity of fdAsset sent
     * @param _minOutputQuantity  Min amount of fAsset to be swapped and deposited
     * @param _stake              Deposit the ifAsset in the Savings Vault?
     * @param _referrer       Referrer address for this deposit.
     */
    function saveViaSwap(
        address _fAsset,
        address _save,
        address _vault,
        address _feeder,
        address _fdAsset,
        uint256 _fdAssetQuantity,
        uint256 _minOutputQuantity,
        bool _stake,
        address _referrer
    ) external {
        _saveViaSwap(
            _fAsset,
            _save,
            _vault,
            _feeder,
            _fdAsset,
            _fdAssetQuantity,
            _minOutputQuantity,
            _stake,
            _referrer
        );
    }

    /**
     * @dev 3. Buys a bAsset on Uniswap with ETH, then mints ifAsset via fAsset,
     *         optionally staking in the Boosted Savings Vault
     * @param _fAsset         fAsset address
     * @param _save           Save address
     * @param _vault          Boosted vault address
     * @param _uniswap        Uniswap router address
     * @param _amountOutMin   Min uniswap output in bAsset units
     * @param _path           Sell path on Uniswap (e.g. [WETH, DAI])
     * @param _minOutMStable  Min amount of fAsset to receive
     * @param _stake          Add the ifAsset to the Savings Vault?
     */
    function saveViaUniswapETH(
        address _fAsset,
        address _save,
        address _vault,
        address _uniswap,
        uint256 _amountOutMin,
        address[] calldata _path,
        uint256 _minOutMStable,
        bool _stake
    ) external payable {
        _saveViaUniswapETH(
            _fAsset,
            _save,
            _vault,
            _uniswap,
            _amountOutMin,
            _path,
            _minOutMStable,
            _stake,
            address(0)
        );
    }

    /**
     * @dev 3. Buys a bAsset on Uniswap with ETH, then mints ifAsset via fAsset,
     *         optionally staking in the Boosted Savings Vault
     * @param _fAsset         fAsset address
     * @param _save           Save address
     * @param _vault          Boosted vault address
     * @param _uniswap        Uniswap router address
     * @param _amountOutMin   Min uniswap output in bAsset units
     * @param _path           Sell path on Uniswap (e.g. [WETH, DAI])
     * @param _minOutMStable  Min amount of fAsset to receive
     * @param _stake          Add the ifAsset to the Savings Vault?
     * @param _referrer       Referrer address for this deposit.
     */
    function saveViaUniswapETH(
        address _fAsset,
        address _save,
        address _vault,
        address _uniswap,
        uint256 _amountOutMin,
        address[] calldata _path,
        uint256 _minOutMStable,
        bool _stake,
        address _referrer
    ) external payable {
        _saveViaUniswapETH(
            _fAsset,
            _save,
            _vault,
            _uniswap,
            _amountOutMin,
            _path,
            _minOutMStable,
            _stake,
            _referrer
        );
    }

    /**
     * @dev Gets estimated fAsset output from a WETH > bAsset > fAsset trade
     * @param _fAsset       fAsset address
     * @param _uniswap      Uniswap router address
     * @param _ethAmount    ETH amount to sell
     * @param _path         Sell path on Uniswap (e.g. [WETH, DAI])
     */
    function estimate_saveViaUniswapETH(
        address _fAsset,
        address _uniswap,
        uint256 _ethAmount,
        address[] calldata _path
    ) external view returns (uint256 out) {
        require(_fAsset != address(0), "Invalid fAsset");
        require(_uniswap != address(0), "Invalid uniswap");

        uint256 estimatedBasset = _getAmountOut(_uniswap, _ethAmount, _path);
        return IFasset(_fAsset).getMintOutput(_path[_path.length - 1], estimatedBasset);
    }

    /**
     * @dev 0. Simply saves an fAsset and then into the vault
     * @param _fAsset   fAsset address
     * @param _save     Save address
     * @param _vault    Boosted Savings Vault address
     * @param _amount   Units of fAsset to deposit to savings
     * @param _referrer Referrer address for this deposit.
     */
    function _saveAndStake(
        address _fAsset,
        address _save,
        address _vault,
        uint256 _amount,
        bool _stake,
        address _referrer
    ) internal {
        require(_fAsset != address(0), "Invalid fAsset");
        require(_save != address(0), "Invalid save");
        require(_vault != address(0), "Invalid vault");

        // 1. Get the input fAsset
        IERC20(_fAsset).safeTransferFrom(msg.sender, address(this), _amount);

        // 2. Mint ifAsset and stake in vault
        _depositAndStake(_save, _vault, _amount, _stake, _referrer);
    }

    /** @dev Internal func to deposit into Save and optionally stake in the vault
     * @param _save       Save address
     * @param _vault      Boosted vault address
     * @param _amount     Amount of fAsset to deposit
     * @param _stake      Add the ifAsset to the Savings Vault?
     * @param _referrer   Referrer address for this deposit, if any.
     */
    function _depositAndStake(
        address _save,
        address _vault,
        uint256 _amount,
        bool _stake,
        address _referrer
    ) internal {
        if (_stake && _referrer != address(0)) {
            uint256 credits = ISavingsContractV4(_save).depositSavings(
                _amount,
                address(this),
                _referrer
            );
            IBoostedVaultWithLockup(_vault).stake(msg.sender, credits);
        } else if (_stake && _referrer == address(0)) {
            uint256 credits = ISavingsContractV4(_save).depositSavings(_amount, address(this));
            IBoostedVaultWithLockup(_vault).stake(msg.sender, credits);
        } else if (!_stake && _referrer != address(0)) {
            ISavingsContractV4(_save).depositSavings(_amount, msg.sender, _referrer);
        } else {
            ISavingsContractV4(_save).depositSavings(_amount, msg.sender);
        }
    }

    /**
     * @dev 1. Mints an fAsset and then deposits to Save/Savings Vault
     * @param _fAsset       fAsset address
     * @param _bAsset       bAsset address
     * @param _save         Save address
     * @param _vault        Boosted Savings Vault address
     * @param _amount       Amount of bAsset to mint with
     * @param _minOut       Min amount of fAsset to get back
     * @param _stake        Add the ifAsset to the Boosted Savings Vault?
     * @param _referrer     Referrer address for this deposit.
     */
    function _saveViaMint(
        address _fAsset,
        address _save,
        address _vault,
        address _bAsset,
        uint256 _amount,
        uint256 _minOut,
        bool _stake,
        address _referrer
    ) internal {
        require(_fAsset != address(0), "Invalid fAsset");
        require(_save != address(0), "Invalid save");
        require(_vault != address(0), "Invalid vault");
        require(_bAsset != address(0), "Invalid bAsset");

        // 1. Get the input bAsset
        IERC20(_bAsset).safeTransferFrom(msg.sender, address(this), _amount);

        // 2. Mint
        uint256 fassetsMinted = IFasset(_fAsset).mint(_bAsset, _amount, _minOut, address(this));

        // 3. Mint ifAsset and optionally stake in vault
        _depositAndStake(_save, _vault, fassetsMinted, _stake, _referrer);
    }

    /**
     * @dev 2. Swaps fdAsset for fAsset and then deposits to Save/Savings Vault
     * @param _fAsset             fAsset address
     * @param _save               Save address
     * @param _vault              Boosted Savings Vault address
     * @param _feeder             Feeder Pool address
     * @param _fdAsset             fdAsset address
     * @param _fdAssetQuantity     Quantity of fdAsset sent
     * @param _minOutputQuantity  Min amount of fAsset to be swapped and deposited
     * @param _stake              Deposit the ifAsset in the Savings Vault?
     * @param _referrer           Referrer address for this deposit.
     */
    function _saveViaSwap(
        address _fAsset,
        address _save,
        address _vault,
        address _feeder,
        address _fdAsset,
        uint256 _fdAssetQuantity,
        uint256 _minOutputQuantity,
        bool _stake,
        address _referrer
    ) internal {
        require(_feeder != address(0), "Invalid feeder");
        require(_fAsset != address(0), "Invalid fAsset");
        require(_save != address(0), "Invalid save");
        require(_vault != address(0), "Invalid vault");
        require(_fdAsset != address(0), "Invalid input");

        // 0. Transfer the fdAsset here
        IERC20(_fdAsset).safeTransferFrom(msg.sender, address(this), _fdAssetQuantity);

        // 1. Swap the fdAsset for fAsset with the feeder pool
        uint256 fAssetQuantity = IFeederPool(_feeder).swap(
            _fdAsset,
            _fAsset,
            _fdAssetQuantity,
            _minOutputQuantity,
            address(this)
        );

        // 2. Deposit the fAsset into Save and optionally stake in the vault
        _depositAndStake(_save, _vault, fAssetQuantity, _stake, _referrer);
    }

    /**
     * @dev 3. Buys a bAsset on Uniswap with ETH, then mints ifAsset via fAsset,
     *         optionally staking in the Boosted Savings Vault
     * @param _fAsset         fAsset address
     * @param _save           Save address
     * @param _vault          Boosted vault address
     * @param _uniswap        Uniswap router address
     * @param _amountOutMin   Min uniswap output in bAsset units
     * @param _path           Sell path on Uniswap (e.g. [WETH, DAI])
     * @param _minOutMStable  Min amount of fAsset to receive
     * @param _stake          Add the ifAsset to the Savings Vault?
     * @param _referrer       Referrer address for this deposit.
     */
    function _saveViaUniswapETH(
        address _fAsset,
        address _save,
        address _vault,
        address _uniswap,
        uint256 _amountOutMin,
        address[] calldata _path,
        uint256 _minOutMStable,
        bool _stake,
        address _referrer
    ) internal {
        require(_fAsset != address(0), "Invalid fAsset");
        require(_save != address(0), "Invalid save");
        require(_vault != address(0), "Invalid vault");
        require(_uniswap != address(0), "Invalid uniswap");

        // 1. Get the bAsset
        uint256[] memory amounts = IUniswapV2Router02(_uniswap).swapExactETHForTokens{
            value: msg.value
        }(_amountOutMin, _path, address(this), block.timestamp + 1000);

        // 2. Purchase fAsset
        uint256 fassetsMinted = IFasset(_fAsset).mint(
            _path[_path.length - 1],
            amounts[amounts.length - 1],
            _minOutMStable,
            address(this)
        );

        // 3. Mint ifAsset and optionally stake in vault
        _depositAndStake(_save, _vault, fassetsMinted, _stake, _referrer);
    }

    /** @dev Internal func to get estimated Uniswap output from WETH to token trade */
    function _getAmountOut(
        address _uniswap,
        uint256 _amountIn,
        address[] memory _path
    ) internal view returns (uint256) {
        uint256[] memory amountsOut = IUniswapV2Router02(_uniswap).getAmountsOut(_amountIn, _path);
        return amountsOut[amountsOut.length - 1];
    }

    /**
     * @dev Approve fAsset and bAssets, Feeder Pools and fdAssets, and Save/vault
     */
    function approve(
        address _fAsset,
        address[] calldata _bAssets,
        address[] calldata _fPools,
        address[] calldata _fdAssets,
        address _save,
        address _vault
    ) external onlyKeeperOrGovernor {
        _approve(_fAsset, _save);
        _approve(_save, _vault);
        _approve(_bAssets, _fAsset);

        require(_fPools.length == _fdAssets.length, "Mismatching fPools/fdAssets");
        for (uint256 i = 0; i < _fPools.length; i++) {
            _approve(_fdAssets[i], _fPools[i]);
        }
    }

    /**
     * @dev Approve one token/spender
     */
    function approve(address _token, address _spender) external onlyKeeperOrGovernor {
        _approve(_token, _spender);
    }

    /**
     * @dev Approve multiple tokens/one spender
     */
    function approve(address[] calldata _tokens, address _spender) external onlyKeeperOrGovernor {
        _approve(_tokens, _spender);
    }

    function _approve(address _token, address _spender) internal {
        require(_spender != address(0), "Invalid spender");
        require(_token != address(0), "Invalid token");
        IERC20(_token).safeApprove(_spender, 2**256 - 1);
    }

    function _approve(address[] calldata _tokens, address _spender) internal {
        require(_spender != address(0), "Invalid spender");
        for (uint256 i = 0; i < _tokens.length; i++) {
            require(_tokens[i] != address(0), "Invalid token");
            IERC20(_tokens[i]).safeApprove(_spender, 2**256 - 1);
        }
    }
}
