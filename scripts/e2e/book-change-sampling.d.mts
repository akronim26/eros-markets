export const BOOK_CHANGE_SCAN_MS: number;
export const BOOK_CHANGE_MAX_RANGE: bigint;
export const BOOK_CHANGE_MIN_SAMPLE_MS: number;
export class BookChangeWatch {
  constructor(options: { client: { getLogs(args: { address: string; fromBlock: bigint; toBlock: bigint }): Promise<any[]> };
    engine: string; decode: (log: any) => string | undefined; now?: () => number });
  captured(captureBlock: bigint): void;
  scan(head: bigint | (() => Promise<bigint>)): Promise<bigint | undefined>;
  due(): boolean;
  triggered(): void;
}
