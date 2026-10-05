import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { resolveMarket } from "@/lib/market-discovery";
import { Terminal } from "@/components/terminal";

export async function generateMetadata({ params }: { params: Promise<{ engine: string }> }): Promise<Metadata> {
  const m = await resolveMarket((await params).engine);
  return { title: m ? m.short : "Market" };
}

export default async function MarketPage({ params }: { params: Promise<{ engine: string }> }) {
  const manifest = await resolveMarket((await params).engine);
  if (!manifest) notFound();
  return <Terminal key={manifest.engine} manifest={manifest} />;
}
