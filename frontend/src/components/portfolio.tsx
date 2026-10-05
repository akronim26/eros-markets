"use client";

import Link from "next/link";
import { useHead, useMarket, useTrader } from "@/lib/reads";
import { type MarketManifest } from "@/config/deployment";
import { useMarketList } from "@/lib/market-list";
import { atomsToUsdc, lotsToClaims, qToMoney } from "@/lib/units";
import { HEALTH } from "@/lib/enums";
import { chipFor } from "./market-parts";
import { useLoginAction, useOwner } from "./wallet";
import { Button, Chip, SectionRule } from "./ui";

const two = (s: string) => s.replace(/(\.\d{2})\d+$/, "$1");

function Line({ mk, owner, block }: { mk: MarketManifest; owner: `0x${string}`; block?: bigint }) {
  const m = useMarket(mk.engine, block);
  const t = useTrader(mk.engine, owner, block);
  const p = t.data?.account?.preview;
  const chip = m.data ? chipFor(m.data) : null;
  return (
    <tr className="hair-b">
      <td className="py-3 pr-6 pl-4"><Link href={`/m/${mk.engine}`} className="text-sm font-medium text-fg hover:underline">{mk.short}</Link></td>
      <td className="pr-6">{chip && <Chip tone={chip.tone}>{chip.label}</Chip>}{(m.isError || t.isError) && <p role="alert" className="mt-1 text-xs text-ask">Read failed. <button className="underline" onClick={() => { void m.refetch(); void t.refetch(); }}>Retry</button></p>}</td>
      <td className="tnum pr-6 text-right text-sm">{p ? `${lotsToClaims(p.positionLots)}` : <span className="text-fg-3">{t.isError ? "unavailable" : t.data ? "not funded" : "Reading…"}</span>}</td>
      <td className="tnum pr-6 text-right text-sm">{p ? two(qToMoney(p.cashQ).usdc) : "—"}</td>
      <td className="tnum pr-6 text-right text-sm">{p ? `${two(qToMoney(p.e1Q).usdc)} / ${two(qToMoney(p.e0Q).usdc)}` : "—"}</td>
      <td className="pr-6 text-sm text-fg-2">{p ? HEALTH[p.status] : "—"}</td>
      <td className="tnum pr-4 text-right text-sm">{p ? atomsToUsdc(p.usableReleaseAtoms, 2) : "—"}</td>
    </tr>
  );
}

function LoggedOut() {
  const login = useLoginAction();
  return (
    <div className="frame mt-4 flex flex-wrap items-center justify-between gap-4 p-6">
      <p className="max-w-[52ch] text-sm leading-relaxed text-fg-2">
        Log in to see your position, cash and what you can release in every market. Your wallet is your trading account.
      </p>
      <Button variant="primary" size="lg" arrow disabled={!login.ready} onClick={() => login.login()}>
        Log in
      </Button>
    </div>
  );
}

export function PortfolioPage() {
  const discovery = useMarketList();
  const { markets } = discovery;
  const owner = useOwner();
  const head = useHead();
  return (
    <main className="mx-auto w-full max-w-[1280px] px-4 pt-10 pb-16 md:px-8">
      <h1 className="pixel text-5xl leading-none text-fg uppercase">Portfolio</h1>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-fg-2">
        Your account in each market, read from the contracts. Markets are isolated: balances are never netted across them.
      </p>
      <div className="mt-10">
        <SectionRule name="POSITIONS" index={1} />
      </div>
      {(head.isError || discovery.isError) && <p role="alert" className="mt-4 text-xs text-ask">Some market data is unavailable. This list may be incomplete. <button className="underline" onClick={() => { void head.refetch(); void discovery.refetch(); }}>Retry</button></p>}
      {!owner.address ? (
        <LoggedOut />
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[820px] border-t border-line-strong frame text-left">
            <thead>
              <tr className="hair-b text-2xs text-fg-3">
                <th className="py-2.5 pr-6 pl-4 font-medium">Market</th>
                <th className="pr-6 font-medium">Status</th>
                <th className="pr-6 text-right font-medium">Position (claims)</th>
                <th className="pr-6 text-right font-medium">Cash</th>
                <th className="pr-6 text-right font-medium">Value if YES / NO</th>
                <th className="pr-6 font-medium">Health</th>
                <th className="pr-4 text-right font-medium">Releasable</th>
              </tr>
            </thead>
            <tbody>
              {markets.map((mk) => (
                <Line key={mk.engine} mk={mk} owner={owner.address!} block={head.data?.number} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
