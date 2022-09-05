// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.6;

import "../../fasset/FassetStructs.sol";
import { FeederPool } from "../../feeders/FeederPool.sol";

contract ExposedFeederPool is FeederPool {
    constructor(address _nexus, address _fAsset)
            FeederPool(_nexus, _fAsset) {}
}
