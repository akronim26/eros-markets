"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useHead } from "@/lib/reads";
import { markets } from "@/config/deployment";
import { WalletButton } from "./wallet";
import { cx } from "./ui";

const NAV = [
  { href: "/markets", label: "Markets" },
  { href: `/m/${markets[0].engine}`, label: "Trade", match: "/m/" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/resolution", label: "Resolution" },
];

function HeadIndicator() {
  const head = useHead();
  const stale = head.data ? Date.now() - head.data.at > 10_000 : false;
  const down = head.isError && !head.data;
  return (
    <div className="label hidden items-center gap-2 text-fg-3 lg:flex" title="Connection to Monad testnet">
      <span
        className={cx(
          "relative h-2 w-2",
          down || stale ? "shadow-[inset_0_0_0_1px_var(--color-ink)]" : "bg-signal",
          down && "after:absolute after:inset-x-[-1px] after:top-1/2 after:h-px after:-rotate-45 after:bg-ink",
        )}
        aria-hidden
      />
      <span>{down ? "RPC unreachable" : stale ? "RPC lagging" : "Monad testnet"}</span>
    </div>
  );
}

export function TopBar() {
  const path = usePathname();
  return (
    <header className="sticky top-0 z-30 bg-ground px-3 pt-3 max-md:px-2 max-md:pt-2">
      <div className="frame flex h-12 items-center gap-6 bg-ground px-4 max-md:h-auto max-md:flex-wrap max-md:gap-0 max-md:pt-2.5 md:grid md:grid-cols-[1fr_auto_1fr]">
        <Link href="/" className="flex shrink-0 items-center justify-self-start" aria-label="Eros Markets home">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/eros-markets-lockup-on-light.svg" alt="Eros Markets" className="h-[14px] w-auto" />
        </Link>
        <nav
          className="flex h-full items-stretch max-md:order-3 max-md:justify-center max-md:-mx-4 max-md:mt-2 max-md:h-10 max-md:w-[calc(100%+2rem)] max-md:overflow-x-auto max-md:shadow-[inset_0_1px_0_var(--color-ink)] md:justify-self-center"
          aria-label="Primary"
        >
          {NAV.map((n) => {
            const active = n.match ? path.startsWith(n.match) : path === n.href;
            return (
              <Link
                key={n.label}
                href={n.href}
                aria-current={active ? "page" : undefined}
                className={cx("label relative flex items-center px-3 transition-colors duration-150", active ? "text-fg" : "text-fg-3 hover:text-fg")}
              >
                {n.label}
                {active && <span className="absolute inset-x-3 bottom-0 h-[2px] bg-signal" aria-hidden />}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-5 max-md:order-2 md:ml-0 md:justify-self-end">
          <HeadIndicator />
          <WalletButton />
        </div>
      </div>
    </header>
  );
}

/** Testnet stand-ins are disclosed, never dressed up as production (frontend.md R11). */
export function TestnetStrip() {
  return (
    <div className="label flex flex-wrap items-center gap-x-4 gap-y-0.5 px-6 py-2 text-fg-3 max-md:px-4">
      <span className="font-semibold text-signal-text">// Testnet</span>
      <span>Collateral is a test token, not USDC</span>
      <span aria-hidden className="text-line max-md:hidden">/</span>
      <span>Fixture market resolves through a manual test authority</span>
      <span aria-hidden className="text-line max-md:hidden">/</span>
      <span>Risk profile uncalibrated: 1x fully backed</span>
    </div>
  );
}
