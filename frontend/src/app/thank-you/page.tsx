import type { Metadata } from "next";
import { ThankYou } from "@/components/thank-you";
export const metadata: Metadata = { title: "Thank you", robots: { index: false, follow: false } };
export default async function ThankYouPage({ searchParams }: { searchParams: Promise<{ tx?: string | string[] }> }) {
  const { tx } = await searchParams;
  return <ThankYou hash={Array.isArray(tx) ? tx[0] : tx} />;
}
