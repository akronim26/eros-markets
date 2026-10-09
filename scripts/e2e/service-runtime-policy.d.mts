export function serviceRuntime(env?: Record<string, string | undefined>, defaultDuration?: string, now?: number, minimumDuration?: number): {
  mode: 'bounded' | 'persistent'; durationSeconds: number; end: number;
};
export function liquidationPolicy(env: Record<string, string | undefined>, measuredGas?: number): { enabled: boolean; intervalMs: number };
export function keeperActions(options: { liquidationEnabled: boolean; nextLiquidationAt: number; now?: number }): ('rollover' | 'sample' | 'liquidate')[];
export function transientServiceRead(error: unknown): boolean;
