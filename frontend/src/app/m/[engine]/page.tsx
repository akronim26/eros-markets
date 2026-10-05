import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { marketByEngine } from "@/config/deployment";
import { Terminal } from "@/components/terminal";

export async function generateMetadata({ params }: { params: Promise<{ engine: string }> }): Promise<Metadata> {
  const m = marketByEngine((await params).engine);
  return { title: m ? m.short : "Market" };
}

export default async function MarketPage({ params }: { params: Promise<{ engine: string }> }) {
  const manifest = marketByEngine((await params).engine);
  if (!manifest) notFound();
  return <Terminal manifest={manifest} />;
}
