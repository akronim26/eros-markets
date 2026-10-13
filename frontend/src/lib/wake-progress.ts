/**
 * Progress shown while a testnet market's workers wake after a visit: price (INDEX window), then
 * trading (MARK), then the full leverage the deployment allows. Read-only presentation of chain
 * state; it never enables an action the contract would refuse.
 */
export type WakeInput = {
  active: boolean; halted: boolean; archived?: boolean; accountingState: number;
  indexAvailable: boolean; markAvailable: boolean; longCap: bigint; shortCap: bigint; deploymentCapX: bigint;
};
export type WakeStep = { label: "Price" | "Trading" | "Full leverage"; done: boolean };

export function wakeProgress(m: WakeInput): { steps: WakeStep[]; detail: string } | undefined {
  if (!m.active || m.halted || m.archived) return undefined;
  const leverage = m.longCap >= m.deploymentCapX && m.shortCap >= m.deploymentCapX;
  if (m.indexAvailable && m.markAvailable && leverage) return undefined;
  const steps: WakeStep[] = [
    { label: "Price", done: m.indexAvailable },
    { label: "Trading", done: m.indexAvailable && m.markAvailable },
    { label: "Full leverage", done: m.indexAvailable && m.markAvailable && leverage },
  ];
  const detail = m.accountingState !== 0 ? "Processing the hourly update first."
    : !m.indexAvailable ? "Fresh prices usually arrive within a minute or two."
    : !m.markAvailable ? "The mark needs a full minute of order-book samples."
    : "Leverage returns once the mark has been stable.";
  return { steps, detail };
}
