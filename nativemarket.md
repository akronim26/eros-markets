I want you to act as a protocol architect and perform a deep architecture review of my current Eros Market project.

The project already has an existing codebase and architecture. Do NOT rely on a predefined architecture description from me unless something is genuinely missing.

Your first task is to inspect the current state of the repository thoroughly and reconstruct how the system works today.

Then design the best architecture for ADDING an Eros-native prediction market alongside the existing external-market integrations.

The native market is an addition, not a replacement.

## Important scope constraint: this is a hackathon project

This is currently a hackathon project, not a production protocol.

Therefore, do NOT over-engineer the solution.

The architecture should be:

- technically sound
- demonstrable end-to-end
- reasonably secure for a hackathon deployment
- modular enough to evolve later
- implementable within limited hackathon time

But it does NOT need to be fully production-ready.

When evaluating design choices, prioritize:

1. reuse of the existing codebase
2. minimum number of invasive changes
3. fastest path to a credible working demo
4. simplicity of contracts and off-chain infrastructure
5. architectural cleanliness
6. ability to upgrade toward a production design later

Do not require production-grade complexity unless it is necessary for the hackathon demo to function correctly.

Examples of things that MAY be simplified for the hackathon include:

- decentralized observer networks
- multiple independent oracle signers
- fully permissionless market making
- sophisticated source-weighting algorithms
- complex governance
- production-grade upgrade mechanisms
- extensive redundancy
- highly optimized gas architecture
- multi-region infrastructure
- generalized support for every future execution venue
- fully decentralized keeper infrastructure

If a simpler centralized or semi-trusted component is acceptable for the hackathon, explicitly say so.

For every major component classify it as:

MUST BUILD NOW  
NICE TO HAVE FOR HACKATHON  
PRODUCTION LATER

Whenever you identify a production-grade improvement, do not automatically include it in the MVP.

Instead present:

Hackathon implementation:
the simplest credible implementation we should build now.

Production evolution:
how this component should be upgraded later.

The most important objective is to build a working architecture that demonstrates the Eros thesis clearly, not to prematurely build a production-grade protocol.

You have full access to the repository. Do not ask me to describe the existing architecture unless the answer cannot be determined from the code, tests, documentation, configuration, or git state.

## Phase 1 — Understand the current project first

Before proposing anything, inspect the repository in depth.

Analyze:

- contracts/
- src/
- workers/
- scripts/
- tests/
- deployment files
- config files
- documentation
- interfaces
- libraries
- pricing code
- market creation logic
- oracle / observation logic
- risk engine
- perpetual engine
- settlement
- resolution
- external integrations
- Polymarket-related code
- Kuru-related code, if any
- UMA-related code, if any

Trace actual execution paths instead of inferring from filenames.

Identify:

- how a market is created
- how market IDs are represented
- how external markets are mapped
- how prices enter the system
- how observations are validated
- how INDEX is constructed
- how MARK is constructed
- how PERP/BASIS pricing works
- how history/TWAP windows work
- how bootstrap and rollover work
- how funding works
- how margin works
- how liquidation works
- how resolution works
- how settlement works
- what off-chain workers currently exist
- what assumptions are embedded in the current contracts

For every major architectural claim, point to the relevant files/functions.

Produce a reconstructed architecture diagram of the CURRENT system before suggesting changes.

Do not redesign anything yet.

## Phase 2 — Identify extension points

Determine where a native prediction market can be introduced with the least disruption.

The native market must coexist with existing external sources.

The architecture should support cases such as:

- external market only
- native market only
- native + external market
- multiple external sources in the future

Find the smallest useful abstraction boundary.

Specifically determine whether the current architecture already supports, or minimally needs, abstractions such as:

- PriceSource
- MarketAdapter
- ObservationSource
- ExecutionVenue
- SourceRegistry
- PriceRouter
- ResolutionProvider

Do not introduce abstractions merely because they would look cleaner in an ideal production system.

For the hackathon, prefer a small abstraction that solves the immediate problem.

Preserve working components wherever possible.

## Phase 3 — Research the native-market design

Perform current research on:

- Monad
- Kuru
- UMA
- Polymarket architecture
- Gnosis Conditional Tokens where useful
- relevant prediction-market CLOB/AMM designs

Use primary sources where possible.

Clearly distinguish:

VERIFIED FACT  
DESIGN RECOMMENDATION  
ASSUMPTION

Do not research for completeness alone. Focus on information that materially affects what we should build during the hackathon.

## Core design question

I want to add a first-party Eros prediction market.

For a binary event such as:

"Will event X happen?"

the system should support:

- YES/NO exposure
- collateralization
- mint/split
- merge
- trading
- liquidity
- price discovery
- resolution
- redemption

The native market should also be able to act as a price source for Eros event perpetuals.

Conceptually:

External venues ──────┐
                      │
Eros native market ───┼→ validated price layer
                      │
Future venues ────────┘
                              ↓
                          Eros INDEX
                              ↓
                      MARK / Risk / Perps

But derive the final architecture from the existing repository rather than assuming this structure.

## Outcome-token architecture

Compare:

- separate ERC-20 YES/NO tokens
- ERC-1155 conditional-token design
- minimal custom outcome-token implementation

For the hackathon, strongly consider implementation simplicity and Kuru compatibility.

Recommend the simplest architecture that preserves correct collateral accounting.

## Native execution venue

I am considering Kuru.

Research whether Kuru can practically serve as the native execution venue for this hackathon.

Determine:

- how markets are created
- supported token pairs
- relevant contracts
- whether YES/USDC and NO/USDC can be created
- how the book can be read
- how trades can be observed
- what APIs/indexers are available
- whether a market maker is necessary
- how difficult integration would actually be

Then compare it against:

- building an Eros CLOB
- using an AMM
- hybrid approaches

For the hackathon, explicitly penalize architectures that require implementing a complex exchange from scratch unless that work is central to the demo.

## YES/NO economics

Analyze:

P(YES) + P(NO) ≈ 1

If independent books exist, explain split/merge arbitrage with a numerical example.

Use examples such as:

YES = 0.70  
NO = 0.40

and:

YES = 0.45  
NO = 0.45

Explain who performs the arbitrage and which contract calls are required.

For the hackathon, determine whether this arbitrage must be automated or whether demonstrating that the mechanism exists is sufficient.

## Native price feed

Design the simplest credible mechanism for turning native trading activity into an Eros price observation.

Compare:

- last trade
- midpoint
- depth-weighted midpoint
- TWAP
- simple hybrid approaches

Avoid designing a complex oracle network unless required.

For the hackathon, determine the minimum safe checks needed, such as:

- book has both bid and ask
- maximum spread
- minimum liquidity
- freshness
- minimum observation spacing
- crossed-book rejection
- stale data rejection

Clearly separate:

checks required for hackathon correctness

from

checks needed for production manipulation resistance.

## External + native sources

The native market must coexist with current external feeds.

For the hackathon, research whether the simplest architecture should be:

- source chosen per market
- primary + fallback
- native only when explicitly configured
- basic aggregation

Do not build sophisticated multi-source consensus unless there is a compelling reason.

For example, if:

Polymarket = 0.64  
Eros native = 0.61

the hackathon implementation does not necessarily need a complex weighted oracle.

It may be enough to configure:

primary source = native

or

primary source = Polymarket  
fallback = native

if that keeps the architecture simpler.

Recommend the simplest credible approach.

## Critical anti-circularity requirement

Avoid:

Eros-controlled market maker
→ creates trades
→ Eros considers those trades independent market information
→ risk engine consumes that price

A protocol market maker may provide liquidity.

But explain the minimum separation required during the hackathon between:

- liquidity provision
- user trades
- observed market price
- Eros INDEX

Do not over-engineer this separation, but do not ignore the circularity problem.

## Resolution

Keep resolution separate from price discovery.

Trading price represents market belief.

Resolution determines event truth.

Research the minimum UMA integration necessary for a functioning hackathon demo.

If a mocked or simplified resolution path is appropriate initially, explicitly say so.

## Perpetual integration

Trace the actual current code path from price source to:

INDEX
→ MARK
→ funding
→ margin
→ liquidation
→ settlement

Determine the smallest changes required for native-market observations to enter this existing pipeline.

Reuse existing components aggressively.

## Monad-specific considerations

Only include Monad-specific optimizations that materially matter for the hackathon.

Do not redesign the system solely to optimize parallel execution unless current state contention would realistically affect the demo.

Mention production improvements separately.

## Threat model

Focus first on threats that could actually break or invalidate the hackathon demo:

- incorrect collateral accounting
- unauthorized minting
- stale prices
- empty books
- obvious price manipulation
- broken market mapping
- bad resolution
- failed Kuru integration
- worker failure
- incorrect perp settlement

Then separately list production-grade threats that can be deferred.

For each risk classify:

BLOCKER FOR HACKATHON  
ACCEPTABLE HACKATHON RISK  
PRODUCTION CONCERN

## Architecture alternatives

Produce at least three realistic alternatives.

Do not include architectures that are academically interesting but unrealistic to build within the hackathon.

For each evaluate:

- amount of new code
- reuse of current code
- integration difficulty
- demo quality
- security
- time risk
- external dependencies
- future extensibility

Create a weighted decision matrix where hackathon feasibility carries significant weight.

## Final recommendation

Give two architectures:

### Architecture to build NOW

This should be the specific architecture you recommend implementing during the hackathon.

Be opinionated.

Do not add unnecessary components.

Specify:

- exactly what to build
- exactly what existing code to reuse
- exactly what to mock or simplify
- exactly what NOT to build yet

### Production evolution

Show how the hackathon architecture can later evolve into a stronger production system.

Avoid proposing an MVP that must later be completely discarded.

## Implementation roadmap

Create a highly practical implementation sequence.

Optimize for getting an end-to-end vertical slice working early.

For example, prefer something like:

Phase 1:
outcome tokens + collateral vault

Phase 2:
create one native market

Phase 3:
execute a real trade

Phase 4:
read native market price

Phase 5:
feed native observation into existing Eros pricing

Phase 6:
open an Eros perp using native INDEX

Phase 7:
resolve event and settle

Only then add polish.

For every phase specify:

- files to modify
- files to add
- tests
- mocks
- dependencies
- demo milestone
- definition of done

## Final deliverable

End the report with a table containing:

Component | Hackathon decision | Build now? | Simplification | Production upgrade

Examples:

Native outcome tokens  
Kuru integration  
Market maker  
Price observer  
Source aggregation  
UMA resolution  
Keeper decentralization  
Oracle signer network  
Governance  
Index redundancy

The final answer should make it immediately obvious what we need to implement for the hackathon and what we should deliberately postpone.

The objective is not to design the theoretically perfect protocol.

The objective is to build the smallest technically credible Eros-native market architecture that integrates cleanly with the existing project, demonstrates the idea convincingly, and gives us a strong path toward a production design later.