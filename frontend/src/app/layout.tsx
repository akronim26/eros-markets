import type { Metadata, Viewport } from "next";
import { GeistMono } from "geist/font/mono";
import { SiteFooter } from "@/components/site-footer";
import { CookieBanner } from "@/components/cookie-banner";
import { Providers } from "@/components/providers";
import { TopBar, TestnetStrip } from "@/components/shell";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Eros Markets — Perpetual Futures on Events", template: "%s · Eros Markets" },
  description: "Trade your view on what happens next. Eros Markets brings long and short positions to event probabilities with perpetual futures on Monad. Explore the testnet.",
};

export const viewport: Viewport = { themeColor: "#000000", colorScheme: "dark" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={GeistMono.variable}>
      <body>
        <Providers>
          <TopBar />
          <TestnetStrip />
          {children}
          <SiteFooter />
          <CookieBanner />
        </Providers>
      </body>
    </html>
  );
}
