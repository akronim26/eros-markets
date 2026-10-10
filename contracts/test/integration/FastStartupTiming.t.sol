pragma solidity ^0.8.30;

import {console2} from "forge-std/console2.sol";
import {BookRiskEngineFixture} from "./BookRiskEngine.t.sol";
import {Book} from "../../src/Book.sol";
import {BookRiskEngine} from "../../src/engine/BookRiskEngine.sol";
import {IBookRiskHooks} from "../../src/interfaces/IBookRiskHooks.sol";
import {IPriceSource} from "../../src/interfaces/IPriceSource.sol";
import {AccountingState, PricingMode} from "../../src/math/RiskTypes.sol";
import {RiskContext} from "../../src/pricing/RiskPricing.sol";

/// Launch -> first MARK on the real engine at different positions within the hour. The model
/// uses the measured October 9 cadence: first INDEX finalized 10 s after service launch, one
/// authenticated INDEX observation every 12 s (observed 2 s before inclusion), a keeper sample
/// 2 s after each observation, no sample in the last 8 s of an epoch, makers notified 5 s after
/// a reference appears, and keeper rollover 3 s after an epoch ends with maker requotes 3 s
/// later. Every price is an authenticated observation or an actual funded resting quote.
contract FastStartupTimingTest is BookRiskEngineFixture {
    uint64 constant HOUR = 1_000_800; // 278 * 3600
    uint64 constant FIRST_INDEX_DELAY = 10;
    uint64 constant INDEX_INTERVAL = 12;
    uint64 constant SOURCE_LAG = 2;
    uint64 constant SAMPLE_DELAY = 2;
    uint64 constant MAKER_NOTIFY = 5;
    uint64 constant SAMPLE_RESERVE = 8;
    uint64 constant ROLLOVER_DELAY = 3;
    uint64 constant HORIZON = 900;

    struct Sim {
        uint64 launch;
        uint64 nextIndex;
        uint64 sampleAt;
        uint64 quoteAt;
        uint64 rolloverAt;
        uint64 firstMark;
        uint64 markLostAt;
        uint64 markRestoredAt;
        uint32 rollovers;
        bool skipped;
        bool quoted;
    }

    function _deployAt(uint64 at) internal {
        vm.warp(at);
        configuration.listedAt = at;
        configuration.scheduledT = at + 10 days;
        engine = new BookRiskEngine(vault, TREASURY, configuration);
        vault.registerEngine(address(engine));
        _fund(BUYER);
        _fund(SELLER);
        vm.prank(GOVERNOR);
        engine.activateMarket();
    }

    function _index(uint64 observedAt) internal {
        IPriceSource.Observation memory o =
            _observation(engine.sourceState(configuration.indexSourceId).lastSequence + 1);
        o.observedAt = observedAt;
        engine.submitObservation(o, _signature(o, SIGNER_KEY));
    }

    function _quote() internal returns (bool) {
        (bool ok, uint256 centre) = engine.warmupIndex();
        if (!ok) {
            RiskContext memory c = engine.riskContext();
            (ok, centre) = (c.indexOk, c.indexWad);
        }
        if (!ok) return false;
        uint16 tick = uint16(centre / 1e15);
        vm.prank(BUYER);
        uint32 bid = engine.placeOrder(
            Book.Place(IBookRiskHooks.OrderKind.POST_ONLY, true, false, tick - 10, 500, 8, 0)
        );
        vm.prank(SELLER);
        uint32 ask = engine.placeOrder(
            Book.Place(IBookRiskHooks.OrderKind.POST_ONLY, false, false, tick + 10, 500, 8, 0)
        );
        return bid != 0 && ask != 0;
    }

    function _epochEnd() internal view returns (uint64 end) {
        (,, end,,,,) = engine.epoch();
    }

    /// Runs one launch and returns seconds from service launch to the first finalized MARK.
    function _run(uint64 offset) internal returns (Sim memory s) {
        s.launch = HOUR + offset;
        _deployAt(s.launch);
        s.nextIndex = s.launch + FIRST_INDEX_DELAY;
        for (uint64 t = s.launch; t <= s.launch + HORIZON; ++t) {
            vm.warp(t);
            vm.roll(block.number + 1);
            uint64 end = _epochEnd();
            if (t >= end && s.rolloverAt == 0) s.rolloverAt = end + ROLLOVER_DELAY;
            if (s.rolloverAt != 0 && t == s.rolloverAt) {
                engine.beginRollover();
                while (!engine.rollPage(32)) {}
                engine.finishRollover();
                s.rolloverAt = 0;
                ++s.rollovers;
                s.quoteAt = t + ROLLOVER_DELAY;
            }
            if (t == s.nextIndex) {
                _index(t - SOURCE_LAG);
                s.nextIndex = t + INDEX_INTERVAL;
                s.sampleAt = t + SAMPLE_DELAY;
                if (!s.quoted && s.quoteAt == 0) s.quoteAt = t + MAKER_NOTIFY;
            }
            if (t == s.quoteAt) {
                // Quotes stay unchanged until a rollover invalidates them. The keeper captures
                // the requote at its next INDEX-driven sample, as the sampler protocol requires.
                if (!_quote()) s.quoteAt = t + 1;
                else (s.quoteAt, s.quoted) = (0, true);
            }
            if (t == s.sampleAt) {
                // The keeper's existing funded two-sided depth precheck.
                BookRiskEngine.BookDepthQuote memory d = engine.bookDepth();
                bool funded =
                    d.bidDepthLots >= configuration.depthNLots && d.askDepthLots >= configuration.depthNLots;
                bool ready = funded && engine.accountingReady() && t + SAMPLE_RESERVE < _epochEnd();
                if (!ready) s.skipped = true;
                else engine.samplePerp();
                if (s.firstMark == 0 && engine.pricingMode() == PricingMode.BOOTSTRAP) {
                    try engine.activatePricing() {
                        s.firstMark = t - s.launch;
                    } catch {}
                }
            }
            if (s.firstMark != 0) {
                bool markOk = engine.riskContext().markOk;
                if (!markOk && s.markLostAt == 0) s.markLostAt = t - s.launch;
                if (markOk && s.markLostAt != 0 && s.markRestoredAt == 0) s.markRestoredAt = t - s.launch;
            }
        }
    }

    function _measure(uint64 offset) internal returns (Sim memory s) {
        vm.chainId(10143);
        s = _run(offset);
        console2.log("offset within hour (s)", offset);
        console2.log("  launch -> first MARK (s)", s.firstMark);
        console2.log("  rollovers before horizon", s.rollovers);
        console2.log("  MARK lost / restored after launch (s)", s.markLostAt, s.markRestoredAt);
        assertGt(s.firstMark, 0, "MARK must activate within the horizon");
    }

    /// 10 s to the first INDEX, 2 s observation lag, 60 s windows and one seal interval.
    function _assertTarget(Sim memory s) internal pure {
        assertLe(s.firstMark, 90, "60-90 s target with funded makers and healthy feeds");
        assertGe(s.firstMark, 70);
    }

    function testLaunchAtTopOfHour() public {
        _assertTarget(_measure(0));
    }

    function testLaunchAtTenMinutes() public {
        _assertTarget(_measure(600));
    }

    function testLaunchAtHalfHour() public {
        _assertTarget(_measure(1800));
    }

    function testLaunchAtFortyFiveMinutes() public {
        _assertTarget(_measure(2700));
    }

    /// Warm-up crossing the hourly rollover: the rollover invalidates every resting quote, so
    /// coverage restarts after the requote. History is rebuilt, never carried across it.
    function testLaunchTwoMinutesBeforeTheHour() public {
        Sim memory s = _measure(3480);
        assertEq(s.rollovers, 1);
        assertLe(s.firstMark, 210);
    }

    function testLaunchSeventySecondsBeforeTheHour() public {
        Sim memory s = _measure(3530);
        assertLe(s.firstMark, 210);
    }

    function testLaunchFortySecondsBeforeTheHour() public {
        Sim memory s = _measure(3560);
        assertLe(s.firstMark, 210);
    }

    function testLaunchTenSecondsBeforeTheHour() public {
        Sim memory s = _measure(3590);
        assertLe(s.firstMark, 210);
    }
}
