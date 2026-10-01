// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {QMath} from "./QMath.sol";
import {WAD, PAYOFF_Q_PER_LOT, MAX_ABS_POSITION_LOTS} from "./RiskTypes.sol";
import {HorizonMath} from "./HorizonMath.sol";
import {HazardMath} from "./HazardMath.sol";

/// @title MarginMath
/// @notice MM / IM, directional caps, explicit fullBackingRequired, account health and display
///         leverage (spec §4.2–4.3, DEC-09; reference/b/margin.py). Pure: reads no storage.
/// @dev Kernel money is computed directly in Q: one lot at a wad rate r is worth 1000 * r Q, so
///      |x| * r claims-USDC = lots * 1000 * rWad Q exactly. Requirements round UP. Nothing divides
///      by x or by equity; display leverage is the only equity division and is display-only.
library MarginMath {
    error BadUnits();

    enum Template {
        SCHEDULED,
        CONTINUOUS,
        DEADLINE,
        UNSCHEDULED
    }

    enum Status {
        FLAT,
        HEALTHY,
        BELOW_IM,
        BELOW_MM,
        NONPOSITIVE
    }

    uint8 internal constant R_OK = 0;
    uint8 internal constant R_FLAT = 1;
    uint8 internal constant R_CAP_1X = 2;
    uint8 internal constant R_HAZARD_DOMAIN = 3;
    uint8 internal constant R_MISSING_CALIBRATION = 4;
    uint8 internal constant R_IM_CAP_MEETS_LOSS = 5;

    int256 internal constant MAX_ABS_CASH_Q = int256(1 << 180);

    struct RiskParams {
        uint256 h0Secs;
        uint256 absorptionClaimsPerMin;
        uint256 queueSecs;
        uint256 hazard0WadPerDay;
        uint256 hazard1WadPerDay;
        uint256 epsilonWad;
        uint256 gammaWad;
        uint256 sWad;
        uint256 lambdaWadPerClaim; // USDC per claim^2, wad
        Template template;
        bool calibrated; // valid calibration + release evidence
        uint256 deploymentCapX; // manifest ceiling; initial deployment = 1
        HorizonMath.Envelope realized;
        HorizonMath.Envelope templateEnv;
    }

    struct Margin {
        uint256 mmQ;
        uint256 imQ;
        uint256 worstQ; // |x| * w exactly
        bool fullBacking;
        uint8 reason;
        uint256 capX;
    }

    struct Health {
        Status status;
        int256 e0Q;
        int256 e1Q;
        int256 markEquityQ;
        uint256 mmQ;
        uint256 imQ;
        bool fullBacking;
    }

    function directionalCap(Template t, bool isLong, bool calibrated, uint256 deploymentCapX)
        internal
        pure
        returns (uint256)
    {
        if (deploymentCapX == 0) revert BadUnits();
        if (!calibrated) return 1;
        uint256 c;
        if (t == Template.SCHEDULED) c = 5;
        else if (t == Template.CONTINUOUS) c = 3;
        else if (t == Template.DEADLINE) c = isLong ? 3 : 1;
        else c = 1;
        return QMath.min(c, deploymentCapX);
    }

    /// @notice Per-sign margin for |x| lots at mark q with T - t seconds left.
    function sideMargin(
        uint256 absLots,
        bool isLong,
        uint256 qWad,
        uint256 secsToT,
        uint256 nowTs,
        RiskParams memory p
    ) internal pure returns (Margin memory m) {
        if (absLots > MAX_ABS_POSITION_LOTS || qWad > WAD) revert BadUnits();
        uint256 w = isLong ? qWad : WAD - qWad;
        m.worstQ = absLots * 1000 * w;
        m.capX = directionalCap(p.template, isLong, p.calibrated, p.deploymentCapX);
        if (absLots == 0) {
            m.reason = R_FLAT;
            return m;
        }
        if (m.capX == 1) return _full(m, R_CAP_1X);
        if (qWad == 0 || qWad >= WAD) revert HorizonMath.PriceNotInterior();
        (uint8 reason, uint256 rate) = _rateWad(absLots, isLong, qWad, secsToT, nowTs, p);
        if (reason != R_OK) return _full(m, reason);
        uint256 mm = absLots * 1000 * rate + QMath.mulDivUp(p.lambdaWadPerClaim * absLots * absLots, 1, 2);
        m.mmQ = QMath.min(m.worstQ, mm);
        uint256 im = QMath.max(QMath.mulDivUp(p.gammaWad, m.mmQ, WAD), QMath.mulDivUp(m.worstQ, 1, m.capX));
        m.imQ = QMath.min(m.worstQ, im);
        if (m.imQ >= m.worstQ) {
            m.fullBacking = true;
            m.reason = R_IM_CAP_MEETS_LOSS;
        }
    }

    /// @dev Per-claim adverse move rate m + k sigma + s in wad, or a full-backing reason.
    function _rateWad(
        uint256 absLots,
        bool isLong,
        uint256 qWad,
        uint256 secsToT,
        uint256 nowTs,
        RiskParams memory p
    ) private pure returns (uint8 reason, uint256 rate) {
        uint256 h = HorizonMath.horizonWadUp(absLots, p.h0Secs, p.absorptionClaimsPerMin, p.queueSecs);
        uint256 a0 = HazardMath.hazardUpWad(p.hazard0WadPerDay, h);
        uint256 a1 = HazardMath.hazardUpWad(p.hazard1WadPerDay, h);
        HazardMath.Tail memory t = HazardMath.tail(a0, a1, isLong, p.epsilonWad);
        if (t.fullBacking) return (R_HAZARD_DOMAIN, 0);
        (, uint256 drift) = HazardMath.driftUp(qWad, a0, a1, isLong);
        uint256 sigma = _sigma(qWad, h, secsToT, nowTs, p);
        if (sigma == type(uint256).max) return (R_MISSING_CALIBRATION, 0);
        rate = drift + QMath.mulDivUp(t.kWad, sigma, WAD) + p.sWad;
    }

    /// @dev max(theory, realized, template) capped at 1; type(uint256).max when calibration is
    ///      missing. `hWad` is wad-seconds; envelope bins are looked up at ceil(h) seconds (step-up).
    function _sigma(uint256 qWad, uint256 hWad, uint256 secsToT, uint256 nowTs, RiskParams memory p)
        private
        pure
        returns (uint256)
    {
        uint256 hSecs = QMath.mulDivUp(hWad, 1, WAD);
        (bool okR, uint256 sR) = HorizonMath.envelopeAt(p.realized, hSecs, nowTs);
        (bool okT, uint256 sT) = HorizonMath.envelopeAt(p.templateEnv, hSecs, nowTs);
        if (!okR || !okT) return type(uint256).max;
        return HorizonMath.sigmaUpper(HorizonMath.sigmaTheoryUpWad(qWad, hWad, secsToT), sR, sT);
    }

    function _full(Margin memory m, uint8 reason) private pure returns (Margin memory) {
        m.mmQ = m.worstQ;
        m.imQ = m.worstQ;
        m.fullBacking = true;
        m.reason = reason;
        return m;
    }

    function checkAccount(int256 cashQ, int256 lots) internal pure {
        if (cashQ >= MAX_ABS_CASH_Q || cashQ <= -MAX_ABS_CASH_Q) revert BadUnits();
        if (lots > int256(MAX_ABS_POSITION_LOTS) || lots < -int256(MAX_ABS_POSITION_LOTS)) revert BadUnits();
    }

    /// @notice E0 = c, E1 = c + 1000 Q n.
    function endpoints(int256 cashQ, int256 lots) internal pure returns (int256 e0, int256 e1) {
        checkAccount(cashQ, lots);
        e0 = cashQ;
        e1 = cashQ + int256(PAYOFF_Q_PER_LOT) * lots;
    }

    /// @notice E(q) = c + 1000 n qWad; no second WAD division.
    function markEquityQ(int256 cashQ, int256 lots, uint256 qWad) internal pure returns (int256) {
        checkAccount(cashQ, lots);
        if (qWad > WAD) revert BadUnits();
        return cashQ + 1000 * lots * int256(qWad);
    }

    /// @notice Health from the account's side margin at the same q. Full backing compares the
    ///         exact endpoints instead of a rounded mark equity.
    function health(int256 cashQ, int256 lots, uint256 qWad, Margin memory m)
        internal
        pure
        returns (Health memory h)
    {
        (h.e0Q, h.e1Q) = endpoints(cashQ, lots);
        h.markEquityQ = markEquityQ(cashQ, lots, qWad);
        h.mmQ = m.mmQ;
        h.imQ = m.imQ;
        h.fullBacking = m.fullBacking;
        if (lots == 0) {
            h.status = cashQ >= 0 ? Status.FLAT : Status.NONPOSITIVE;
            return h;
        }
        if (m.fullBacking) {
            if (h.e0Q >= 0 && h.e1Q >= 0) h.status = Status.HEALTHY;
            else if (h.markEquityQ <= 0) h.status = Status.NONPOSITIVE;
            else h.status = Status.BELOW_MM;
            return h;
        }
        if (h.markEquityQ <= 0) h.status = Status.NONPOSITIVE;
        else if (uint256(h.markEquityQ) < m.mmQ) h.status = Status.BELOW_MM;
        else if (uint256(h.markEquityQ) < m.imQ) h.status = Status.BELOW_IM;
        else h.status = Status.HEALTHY;
    }

    /// @notice Display only (assumption M-1): floor(exposure * 1e4 / E) for E > 0.
    function displayLeverageBps(uint256 exposureQ, int256 equityQ)
        internal
        pure
        returns (bool available, uint256 bps)
    {
        if (equityQ <= 0) return (false, 0);
        return (true, QMath.mulDiv(exposureQ, 10_000, uint256(equityQ)));
    }
}
