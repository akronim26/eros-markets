import { parseAbiItem, type Address, type Hex } from "viem";
import { LOG_BLOCK_CAP } from "@/config/chain";
import { client } from "./public-client";

export type Point = { t: number; v: number; block: bigint };
export type Trade = { t: number; tick: number; size: bigint; block: bigint; tx: Hex };
export type LiveSeries = { index: Point[]; perp: Point[]; trades: Trade[]; since?: bigint; cursor?: bigint; cursorHash?: Hex; error?: string };
export const emptySeries = (): LiveSeries => ({ index: [], perp: [], trades: [] });
const OBS = parseAbiItem("event ObservationAccepted(bytes32 indexed sourceId, uint64 indexed sequence, uint64 observedAt, uint64 publishedAt, uint64 acceptedAt, uint256 priceWad, bool depthValid, bytes32 payloadDigest)");
const PERP = parseAbiItem("event PerpObservationRecorded(uint64 t, uint256 midWad, bool valid, int256 basisWad, bool basisValid)");
const FILL = parseAbiItem("event Fill(uint32 indexed makerOrder, uint32 maker, uint32 taker, uint16 tick, uint64 size, uint256 makerFeeQ, uint256 takerFeeQ)");

export async function readLiveSeries(engine: Address, head: bigint, previous: LiveSeries): Promise<LiveSeries> {
  let reset = previous.cursor === undefined || head < previous.cursor;
  if (!reset && previous.cursorHash) reset = (await client.getBlock({ blockNumber: previous.cursor! })).hash !== previous.cursorHash;
  const from = reset ? (head >= LOG_BLOCK_CAP ? head - LOG_BLOCK_CAP + 1n : 0n) : previous.cursor! > 20n ? previous.cursor! - 20n : 0n;
  const to = from + LOG_BLOCK_CAP - 1n < head ? from + LOG_BLOCK_CAP - 1n : head;
  const anchor = await client.getBlock({ blockNumber: to });
  const [obs, perp, fills] = await Promise.all([
    client.getLogs({ address: engine, event: OBS, fromBlock: from, toBlock: to }),
    client.getLogs({ address: engine, event: PERP, fromBlock: from, toBlock: to }),
    client.getLogs({ address: engine, event: FILL, fromBlock: from, toBlock: to }),
  ]);
  const timestamps = new Map(await Promise.all([...new Set(fills.map((l) => l.blockNumber!))].map(async (number) => {
    const b = await client.getBlock({ blockNumber: number });
    return [number, Number(b.timestamp)] as const;
  })));
  if ((await client.getBlock({ blockNumber: to })).hash !== anchor.hash) throw new Error("Chain reorganized during log read; refreshing");
  return {
    cursor: to, cursorHash: anchor.hash, since: reset ? from : previous.since ?? from,
    index: [...(reset ? [] : previous.index.filter((p) => p.block < from)), ...obs.filter((l) => l.args.depthValid).map((l) => ({ t: Number(l.args.observedAt), v: Number(l.args.priceWad! / 10n ** 12n) / 1e6, block: l.blockNumber! }))].slice(-2000),
    perp: [...(reset ? [] : previous.perp.filter((p) => p.block < from)), ...perp.filter((l) => l.args.valid).map((l) => ({ t: Number(l.args.t), v: Number(l.args.midWad! / 10n ** 12n) / 1e6, block: l.blockNumber! }))].slice(-2000),
    trades: [...(reset ? [] : previous.trades.filter((p) => p.block < from)), ...fills.map((l) => ({ t: timestamps.get(l.blockNumber!)!, tick: l.args.tick!, size: l.args.size!, block: l.blockNumber!, tx: l.transactionHash! }))].slice(-500),
  };
}
