<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/eros-mark-on-dark.svg">
    <img src="docs/assets/eros-mark-on-light.svg" alt="Eros Markets logo" width="104" height="104">
  </picture>
</p>

<h1 align="center">Eros Markets</h1>

<p align="center">On-chain trading for the outcomes of real-world events.</p>

Eros Markets is building leveraged binary event markets on Monad. The goal is to let traders take long or short exposure to an event's outcome through an on-chain order book, with transparent collateral accounting, explicit risk controls and cash settlement.

Our current approach uses **Polymarket as an external price reference**. Eros maintains its own order book, liquidity and positions, connecting external event pricing to execution and risk management on Monad.

## What we're building

- **On-chain execution:** a central limit order book with price-time priority and atomic trade accounting.
- **Isolated market risk:** collateral allocation, margin checks, liquidation and reserve coverage within each market.
- **A complete event lifecycle:** authenticated price observations, market resolution, settlement and claims.
- **An accessible trading application:** wallet connection, market data, order management and transparent account state.

We are developing a testnet prototype that brings these components together into a usable trading experience.

## Development

**The most up-to-date implementation and technical documentation are on [`feat/pricefeed`](https://github.com/akronim26/eros-markets/tree/feat/pricefeed).**

Visit the [technical README](https://github.com/akronim26/eros-markets/blob/feat/pricefeed/README.md) for the architecture, local setup, pricing and risk policies, validation commands and integration guides. This page is the project overview.
