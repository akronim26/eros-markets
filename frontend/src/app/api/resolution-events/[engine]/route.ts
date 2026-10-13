import { isAddress } from "viem";
import { marketByEngine } from "@/config/deployment";
import { resolutionEvents } from "@/server/resolution-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

/** Resolution timeline events for a verified market; never for unknown engines. */
export async function GET(_request: Request, { params }: { params: Promise<{ engine: string }> }) {
  const { engine } = await params;
  const market = isAddress(engine) ? marketByEngine(engine) : undefined;
  if (!market) return Response.json({ error: "Unknown market" }, { status: 404, headers });
  try { return Response.json(await resolutionEvents(market.engine), { headers }); }
  catch { return Response.json({ error: "Resolution history unavailable" }, { status: 503, headers }); }
}
