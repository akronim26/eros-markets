import { parseAbi } from "viem";

/** Kuru OrderBook subset (kuru-sdk abi/OrderBook.json); units verified on a Monad-testnet fork (artifacts/native-market). */
export const kuruBookAbi = parseAbi([
  "function getMarketParams() view returns (uint32 pricePrecision, uint96 sizePrecision, address baseAsset, uint256 baseDecimals, address quoteAsset, uint256 quoteDecimals, uint32 tickSize, uint96 minSize, uint96 maxSize, uint256 takerFeeBps, uint256 makerFeeBps)",
  "function getL2Book() view returns (bytes)",
  "function s_orderIdCounter() view returns (uint40)",
  "function s_orders(uint40) view returns (address ownerAddress, uint96 size, uint40 prev, uint40 next, uint40 flippedId, uint32 price, uint32 flippedPrice, bool isBuy)",
  "function addBuyOrder(uint32 price, uint96 size, bool postOnly)",
  "function addSellOrder(uint32 price, uint96 size, bool postOnly)",
  "function batchCancelOrders(uint40[] orderIds)",
  "function placeAndExecuteMarketBuy(uint96 quoteSize, uint256 minAmountOut, bool isMargin, bool isFillOrKill) returns (uint256)",
  "function placeAndExecuteMarketSell(uint96 size, uint256 minAmountOut, bool isMargin, bool isFillOrKill) returns (uint256)",
  "error OrderAlreadyFilledOrCancelled()",
]);

/** Kuru MarginAccount: balances that back resting (limit) orders. */
export const kuruMarginAbi = parseAbi([
  "function deposit(address user, address token, uint256 amount)",
  "function withdraw(uint256 amount, address token)",
  "function getBalance(address user, address token) view returns (uint256)",
]);
export const KURU_MARGIN = "0xd029C2D98ff85D8F64799017fE00a59B1159CE02" as const;
