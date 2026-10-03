// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

// Oracle-side composition of B's REAL resolution modules + B's deterministic mocks for book/accounting
// (plan Appendix B.6). Imports only src/ and non-test mock files, so no foreign test suite is compiled.
import {SettlementController} from "@eros/settlement/SettlementController.sol";
import {IMarketConfig} from "@eros/interfaces/IMarketConfig.sol";
import {MarginMath} from "@eros/math/MarginMath.sol";
import {HorizonMath} from "@eros/math/HorizonMath.sol";
import {MockAccountingPort} from "@eros-test/mocks/B/MockAccountingPort.sol";
import {MockBookAdapter} from "@eros-test/mocks/B/MockBookAdapter.sol";
import {AdmissionMode} from "@eros-provisional/MathTypes.sol";
import {IMarketFactory} from "../../src/interfaces/IMarketFactory.sol";

/// @title EngineHarness
/// @notice B's real `SettlementController` (resolution ingress, halt, finality, INVALID price, settlement
///         jobs) with B's `MockBookAdapter` and `MockAccountingPort`, as B composes it in its own tests.
contract EngineHarness is SettlementController, MockBookAdapter, MockAccountingPort {
    function init(IMarketConfig.Listing memory l, MarginMath.RiskParams memory p) external {
        _initMarket(l, p);
    }

    function _liqSubmitIoc(OrderRequest memory req) internal override returns (uint64, uint256) {
        PlaceResult memory r = _mockPlaceWithMode(req, AdmissionMode.FORCED_REDUCTION);
        return (r.filledLots, lastExamined);
    }
}

/// @title SeamFactory
/// @notice The registry's factory for the seam: deploys one `EngineHarness` per market and initializes it
///         with the listing the registry built (its seam fields bound) and the seam risk profile, so the
///         registry's handshake (`listingHash`, not halted) runs against the real engine.
contract SeamFactory is IMarketFactory {
    error OnlyRegistry();

    address public registry;
    mapping(bytes32 marketId => address) public engineOf;

    function setRegistry(address r) external {
        if (registry != address(0)) revert OnlyRegistry();
        registry = r;
    }

    function deployMarket(IMarketConfig.Listing calldata listing, bytes calldata) external returns (address engine) {
        if (msg.sender != registry) revert OnlyRegistry();
        EngineHarness e = new EngineHarness();
        e.init(listing, SeamFixture.profile());
        engine = address(e);
        engineOf[listing.marketId] = engine;
    }
}

/// @notice Listing pack and risk profile for the seam (plan B.6). The registry overwrites the seam fields
///         (marketId, registry, resolutionAuthority, monitor, scheduledT, listedAt, sourceHash, rulesHash,
///         invalidRule); the rest are the engine's own.
library SeamFixture {
    function pack(address token, address gov) internal pure returns (IMarketConfig.Listing memory l) {
        l.token = token;
        l.governance = gov;
        l.template = MarginMath.Template.SCHEDULED;
        l.deploymentCapX = 1;
        l.maxTraders = 1024;
        l.indexSourceId = keccak256("index-source");
        l.indexSigner = address(0x51);
        l.indexRulesHash = keccak256("index-rules");
        l.depthNLots = 500;
        l.maxSpreadWad = 5e16;
        l.bootstrapBandWad = 5e16;
        l.minOrderLots = 1;
        l.maxOrderLots = uint64(type(uint32).max);
        l.maxLiqLotsPerBlock = 0;
        l.fundingEnabled = false;
    }

    function profile() internal pure returns (MarginMath.RiskParams memory p) {
        p.h0Secs = 300;
        p.absorptionClaimsPerMin = 1000;
        p.hazard0WadPerDay = 1e14;
        p.hazard1WadPerDay = 1e14;
        p.epsilonWad = 1e16;
        p.gammaWad = 15e17;
        p.sWad = 5e15;
        p.lambdaWadPerClaim = 1e12;
        p.template = MarginMath.Template.SCHEDULED;
        p.calibrated = false;
        p.deploymentCapX = 1;
        HorizonMath.Envelope memory e;
        e.hSecs = new uint64[](1);
        e.sigmaWad = new uint256[](1);
        e.hSecs[0] = 1e12;
        e.validUntil = type(uint64).max;
        p.realized = e;
        p.templateEnv = e;
    }
}
