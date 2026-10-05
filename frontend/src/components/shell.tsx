"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useHead } from "@/lib/reads";
import { WalletButton } from "./wallet";
import { cx } from "./ui";
import { BrandImage } from "./brand-image";
import { ThemeSwitcher } from "./theme-switcher";

const NAV = [
  { href: "/markets", label: "Markets", match: "/m/" },
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
          down || stale ? "shadow-[inset_0_0_0_1px_var(--color-line-strong)]" : "bg-signal",
          down && "after:absolute after:inset-x-[-1px] after:top-1/2 after:h-px after:-rotate-45 after:bg-fg",
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
      <div className="frame grid h-12 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-x-4 bg-ground px-4 max-md:h-auto max-md:grid-cols-[minmax(0,1fr)_auto] max-md:gap-x-2 max-md:px-3 max-md:pt-1">
        <Link href="/" className="flex w-full min-w-0 max-w-[120px] items-center justify-self-start" aria-label="Eros Markets home">
          <BrandImage className="w-full" />
        </Link>
        <nav
          className="flex h-full items-stretch max-md:col-span-2 max-md:row-start-2 max-md:-mx-3 max-md:mt-1 max-md:grid max-md:h-10 max-md:w-[calc(100%+1.5rem)] max-md:grid-cols-3 max-md:shadow-[inset_0_1px_0_var(--color-line-strong)] md:justify-self-center"
          aria-label="Primary"
        >
          {NAV.map((n) => {
            const active = path === n.href || (n.match ? path.startsWith(n.match) : false);
            return (
              <Link
                key={n.label}
                href={n.href}
                aria-current={active ? (path === n.href ? "page" : "location") : undefined}
                className={cx("label relative flex items-center justify-center px-3 transition-colors duration-150 max-md:px-1", active ? "text-fg" : "text-fg-3 hover:text-fg")}
              >
                {n.label}
                {active && <span className="absolute inset-x-3 bottom-0 h-[2px] bg-signal" aria-hidden />}
              </Link>
            );
          })}
        </nav>
        <div className="relative flex items-center justify-self-end gap-2 max-md:col-start-2 max-md:row-start-1 lg:gap-3">
          <HeadIndicator />
          <ThemeSwitcher />
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
