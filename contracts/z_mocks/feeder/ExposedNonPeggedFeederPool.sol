// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.6;

import "../../fasset/FassetStructs.sol";
import { NonPeggedFeederPool } from "../../feeders/NonPeggedFeederPool.sol";

contract ExposedNonPeggedFeederPool is NonPeggedFeederPool {
    constructor(
        address _nexus,
        address _fAsset,
        address _fdAssetRedemptionPrice
    ) NonPeggedFeederPool(_nexus, _fAsset, _fdAssetRedemptionPrice) {}
}
