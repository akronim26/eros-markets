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
    address constant TAKER = address(0x104);

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
        uint64 indexInterval;
        uint64 fillAt; // seconds after launch; 0 = no taker fill
        bool bookChangeSampling; // keeper captures 2 s after any engine action
        uint64 sourceLag; // observedAt is this many seconds before inclusion
        uint64 horizon;
        bool earlyIndex; // publisher sends one early INDEX so a book-change capture can seal
        uint64 lastEarly;
        uint32 publishes;
        uint32 lostSecs; // seconds without MARK after the first MARK
        bool fastWarmup; // source-cadence publishing (12 s, 2 s lag) until the first MARK
        uint64 lastPublish;
    }

    /// Lower-cost testnet cadence: one publish about every 80 s and one sample per publish.
    uint64 constant SLOW_INTERVAL = 80;
    uint64 constant SLOW_LAG = 28; // oldest source age the publisher accepts before sending
    uint64 constant EARLY_MIN_GAP = 20; // at most one extra cycle per 20 s

    function _deployAt(uint64 at) internal {
        vm.warp(at);
        configuration.listedAt = at;
        configuration.scheduledT = at + 10 days;
        engine = new BookRiskEngine(vault, TREASURY, configuration);
        vault.registerEngine(address(engine));
        _fund(BUYER);
        _fund(SELLER);
        _fund(TAKER);
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
            Book.Place(IBookRiskHooks.OrderKind.POST_ONLY, true, false, tick - 10, 1000, 8, 0)
        );
        vm.prank(SELLER);
        uint32 ask = engine.placeOrder(
            Book.Place(IBookRiskHooks.OrderKind.POST_ONLY, false, false, tick + 10, 1000, 8, 0)
        );
        return bid != 0 && ask != 0;
    }

    function _epochEnd() internal view returns (uint64 end) {
        (,, end,,,,) = engine.epoch();
    }

    /// Runs one launch and returns seconds from service launch to the first finalized MARK.
    function _run(uint64 offset) internal returns (Sim memory s) {
        return _runWith(offset, INDEX_INTERVAL, 0, false);
    }

    function _runWith(uint64 offset, uint64 indexInterval, uint64 fillAt, bool bookChangeSampling)
        internal
        returns (Sim memory s)
    {
        (s.indexInterval, s.fillAt, s.bookChangeSampling) = (indexInterval, fillAt, bookChangeSampling);
        (s.sourceLag, s.horizon) = (SOURCE_LAG, HORIZON);
        return _simulate(offset, s);
    }

    function _runSlow(uint64 offset, uint64 fillAt, bool earlyIndex, uint64 horizon)
        internal
        returns (Sim memory s)
    {
        return _runSlowFrom(offset, fillAt, earlyIndex, horizon, true);
    }

    function _runSlowFrom(uint64 offset, uint64 fillAt, bool earlyIndex, uint64 horizon, bool fastWarmup)
        internal
        returns (Sim memory s)
    {
        vm.chainId(10143);
        s.fastWarmup = fastWarmup;
        (s.indexInterval, s.fillAt, s.bookChangeSampling) = (SLOW_INTERVAL, fillAt, fillAt != 0);
        (s.sourceLag, s.horizon, s.earlyIndex) = (SLOW_LAG, horizon, earlyIndex);
        s = _simulate(offset, s);
        console2.log("launch -> first MARK (s)", s.firstMark);
        console2.log("  publishes / rollovers", s.publishes, s.rollovers);
        console2.log("  seconds without MARK after first MARK", s.lostSecs);
    }

    function _simulate(uint64 offset, Sim memory s) internal returns (Sim memory) {
        s.launch = HOUR + offset;
        _deployAt(s.launch);
        s.nextIndex = s.launch + FIRST_INDEX_DELAY;
        for (uint64 t = s.launch; t <= s.launch + s.horizon; ++t) {
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
                bool warming = s.fastWarmup && s.firstMark == 0;
                _index(t - (warming ? SOURCE_LAG : s.sourceLag));
                ++s.publishes;
                s.lastPublish = t;
                s.nextIndex = t + (warming ? INDEX_INTERVAL : s.indexInterval);
                s.sampleAt = t + SAMPLE_DELAY;
                if (!s.quoted && s.quoteAt == 0) s.quoteAt = t + MAKER_NOTIFY;
            }
            if (t == s.quoteAt) {
                // Quotes stay unchanged until a rollover invalidates them. The keeper captures
                // the requote at its next INDEX-driven sample, as the sampler protocol requires.
                if (!_quote()) s.quoteAt = t + 1;
                else (s.quoteAt, s.quoted) = (0, true);
            }
            if (s.fillAt != 0 && t == s.launch + s.fillAt) {
                vm.prank(TAKER);
                engine.placeOrder(Book.Place(IBookRiskHooks.OrderKind.IOC, true, false, 999, 100, 8, 0));
                if (s.bookChangeSampling) s.sampleAt = t + SAMPLE_DELAY;
                if (s.earlyIndex && t >= s.lastEarly + EARLY_MIN_GAP) {
                    // The seal needs an observation newer than the capture at t + 2.
                    uint64 early = t + SAMPLE_DELAY + s.sourceLag + 1;
                    if (early < s.nextIndex) (s.nextIndex, s.lastEarly) = (early, t);
                }
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
                        // After warm-up the next publish is one slow cycle after the last one.
                        if (s.fastWarmup) s.nextIndex = s.lastPublish + s.indexInterval;
                    } catch {}
                }
            }
            if (s.firstMark != 0) {
                bool markOk = engine.riskContext().markOk;
                if (!markOk) ++s.lostSecs;
                if (!markOk && s.markLostAt == 0) s.markLostAt = t - s.launch;
                if (markOk && s.markLostAt != 0 && s.markRestoredAt == 0) s.markRestoredAt = t - s.launch;
            }
        }
        return s;
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

    /// Worst observed October 11 source cadence: 26 s between authenticated observations. A
    /// capture seals only on a later observation, so the 90 s book carry must bridge a capture
    /// interval plus the seal wait. MARK must not flap with no trading at all.
    function testSlowSourceKeepsMarkContinuous() public {
        vm.chainId(10143);
        Sim memory s = _runWith(600, 26, 0, false);
        assertGt(s.firstMark, 0);
        assertEq(s.markLostAt, 0, "MARK never lapses between seals");
    }

    /// A taker fill discards the unsealed capture; the keeper recaptures the new book at once.
    function testFillOnSlowSourceKeepsMarkWithBookChangeSampling() public {
        vm.chainId(10143);
        Sim memory s = _runWith(600, 26, 300, true);
        assertGt(s.firstMark, 0);
        assertEq(s.markLostAt, 0, "MARK stays available through the fill");
    }

    function testFillOnSlowSourceWithoutBookChangeSampling() public {
        vm.chainId(10143);
        Sim memory s = _runWith(600, 26, 300, false);
        console2.log("MARK lost after launch without book-change sampling (s)", s.markLostAt);
        assertGt(s.firstMark, 0);
    }

    /// 80 s publish cadence with the oldest accepted source age (28 s): each INDEX carries
    /// 120 s and each sealed book sample 300 s, so MARK never lapses with no trading, including
    /// across the hourly rollover that invalidates every resting quote.
    function testSlowCadenceKeepsMarkThroughHourlyRollover() public {
        Sim memory s = _runSlow(3000, 0, false, 1500);
        assertEq(s.rollovers, 1);
        assertGt(s.firstMark, 0);
        assertLe(s.firstMark, 180, "launch -> first MARK within 3 minutes");
        assertEq(s.lostSecs, 0, "MARK continuous through the rollover");
        assertLe(uint256(s.publishes), 30, "warm-up at source cadence, then one publish per 80 s");
    }

    /// A fill 3 s after a regular publish (publishes at +82, +162, ... +402) discards the unsealed
    /// capture. The keeper recaptures the new book and the publisher sends one early INDEX so
    /// that capture seals: at most one extra cycle per fill.
    function testSlowCadenceFillWithEarlyIndexKeepsMark() public {
        Sim memory s = _runSlow(600, 405, true, 900);
        assertGt(s.firstMark, 0);
        assertEq(s.lostSecs, 0, "MARK stays available through the fill");
        Sim memory without = _runSlow(600, 405, false, 900);
        assertGt(s.lastEarly, 0, "the fill triggered one early INDEX");
        assertLe(uint256(s.publishes), uint256(without.publishes) + 1, "at most one extra cycle for the fill");
    }

    /// Without the early INDEX the recapture waits for the regular cycle; the 300 s book
    /// carry still bridges it. Logged so the cost/benefit of the early cycle stays visible.
    function testSlowCadenceFillWithoutEarlyIndex() public {
        Sim memory s = _runSlow(600, 405, false, 900);
        assertGt(s.firstMark, 0);
        assertEq(s.lostSecs, 0, "the 300 s book carry bridges a regular-cycle seal");
    }

    /// Publishing only every 80 s from launch delays the first MARK past 3 minutes when warm-up
    /// crosses the hourly rollover. Recorded so the warm-up cadence choice stays visible.
    function testSlowCadenceFromLaunchIsSlowerToFirstMark() public {
        Sim memory s = _runSlowFrom(600, 0, false, 600, false);
        assertGt(s.firstMark, 120);
        s = _runSlowFrom(3480, 0, false, 600, false);
        assertGt(s.firstMark, 180);
    }

    /// Launch at different hour positions: source-cadence warm-up, then the slow cadence. First
    /// MARK stays within 3 minutes and MARK never lapses afterwards.
    function testSlowCadenceLaunchWithinThreeMinutes() public {
        uint64[6] memory offsets = [uint64(0), 1800, 3480, 3530, 3560, 3590];
        for (uint256 i; i < offsets.length; ++i) {
            Sim memory s = _runSlow(offsets[i], 0, false, 600);
            console2.log("offset within hour (s)", offsets[i]);
            assertGt(s.firstMark, 0);
            assertLe(s.firstMark, 180);
            assertEq(s.lostSecs, 0);
        }
    }
}
