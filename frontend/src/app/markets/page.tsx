import { MarketsIndex } from "@/components/markets-index";
import { Suspense } from "react";
import { LoadingPanel } from "@/components/feedback";
export const metadata = { title: "Markets" };
export default function Page() {
  return <Suspense fallback={<main className="mx-auto w-full max-w-[1280px] px-4 py-10 md:px-8"><LoadingPanel label="Loading markets" /></main>}><MarketsIndex /></Suspense>;
}
