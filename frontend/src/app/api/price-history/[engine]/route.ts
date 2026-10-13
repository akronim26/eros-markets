import { isAddress } from "viem";
import { marketByEngine } from "@/config/deployment";
import { storedPrices } from "@/server/price-history";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

/** Stored INDEX/perp/fill events for a verified market's chart; never for unknown engines. */
export async function GET(_request: Request, { params }: { params: Promise<{ engine: string }> }) {
  const { engine } = await params;
  const market = isAddress(engine) ? marketByEngine(engine) : undefined;
  if (!market) return Response.json({ error: "Unknown market" }, { status: 404, headers });
  try { return Response.json(await storedPrices(market.engine), { headers }); }
  catch { return Response.json({ error: "Stored history unavailable" }, { status: 503, headers }); }
}
