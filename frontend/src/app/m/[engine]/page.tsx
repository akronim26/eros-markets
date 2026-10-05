import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { resolveMarket } from "@/lib/market-discovery";
import { Terminal } from "@/components/terminal";
import { cache } from "react";

const getMarket = cache(resolveMarket);

export async function generateMetadata({ params }: { params: Promise<{ engine: string }> }): Promise<Metadata> {
  const m = await getMarket((await params).engine);
  return { title: m ? m.short : "Market" };
}

export default async function MarketPage({ params }: { params: Promise<{ engine: string }> }) {
  const manifest = await getMarket((await params).engine);
  if (!manifest) notFound();
  return <Terminal key={manifest.engine} manifest={manifest} />;
}
