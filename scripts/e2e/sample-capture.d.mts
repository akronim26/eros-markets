export type SampleCapture = {
  captureVersion: 1;
  sampledAt: string | null;
  sampledBlock: string | null;
  sampledBlockHash: string | null;
};
export function readCanonicalSampleCapture(input: {
  client: {
    getBlock(args: { blockNumber?: bigint; blockTag?: "finalized" }): Promise<{ number: bigint; timestamp: bigint; hash: string | null }>;
    getLogs(args: { address: string; event: unknown; fromBlock: bigint; toBlock: bigint }): Promise<unknown[]>;
  };
  engine: string;
  event: unknown;
  blockNumber: bigint | undefined;
  previous?: unknown;
}): Promise<SampleCapture>;
