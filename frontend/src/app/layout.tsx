import type { Metadata, Viewport } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistPixelGrid } from "geist/font/pixel";
import { SiteFooter } from "@/components/site-footer";
import { CookieBanner } from "@/components/cookie-banner";
import { Providers } from "@/components/providers";
import { TopBar, TestnetStrip } from "@/components/shell";
import { ThemeProvider } from "@/components/theme-provider";
import { themeBootstrap } from "@/lib/theme-bootstrap";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Eros Markets — Perpetual Futures on Events", template: "%s · Eros Markets" },
  description: "Trade your view on what happens next. Eros Markets brings long and short positions to event probabilities with perpetual futures on Monad. Explore the testnet.",
};

export const viewport: Viewport = { themeColor: "#F2F1EC", colorScheme: "light dark" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${GeistMono.variable} ${GeistPixelGrid.variable}`}>
      <head><script dangerouslySetInnerHTML={{ __html: themeBootstrap }} /></head>
      <body>
        <ThemeProvider>
          <Providers>
            <TopBar />
            <TestnetStrip />
            {children}
            <SiteFooter />
            <CookieBanner />
          </Providers>
        </ThemeProvider>
      </body>
    </html>
  );
}
