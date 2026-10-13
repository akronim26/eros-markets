import { isAddress } from "viem";
import { marketByEngine } from "@/config/deployment";
import { nativeBinding } from "@/config/native";
import { kuruTrades } from "@/server/kuru-trades";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

/** Recent Kuru fills for a verified native market's YES/NO books; never for other engines. */
export async function GET(_request: Request, { params }: { params: Promise<{ engine: string }> }) {
  const { engine } = await params;
  const market = isAddress(engine) ? marketByEngine(engine) : undefined;
  if (!market || !nativeBinding(market.engine)) return Response.json({ error: "Unknown native market" }, { status: 404, headers });
  try { return Response.json(await kuruTrades(market.engine), { headers }); }
  catch { return Response.json({ error: "Kuru trades unavailable" }, { status: 503, headers }); }
}
