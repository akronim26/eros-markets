import type { Metadata, Viewport } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistPixelGrid } from "geist/font/pixel";
import { Providers } from "@/components/providers";
import { TopBar, TestnetStrip } from "@/components/shell";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Eros Markets — trade the outcome", template: "%s · Eros Markets" },
  description: "Binary event perpetuals on Monad: trade the probability of an outcome on a fully on-chain order book.",
};

export const viewport: Viewport = { themeColor: "#F2F1EC", colorScheme: "light" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistMono.variable} ${GeistPixelGrid.variable}`}>
      <body>
        <Providers>
          <TopBar />
          <TestnetStrip />
          {children}
        </Providers>
      </body>
    </html>
  );
}
