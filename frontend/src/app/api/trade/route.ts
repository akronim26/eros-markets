import { apiError, authenticate, jsonBody } from "@/server/privy";
import { delegatedTrade, TradeDeliveryError } from "@/server/trade";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try { const user = await authenticate(request); return Response.json({ hash: await delegatedTrade(user, await jsonBody(request)) }); }
  catch (e) {
    if (e instanceof TradeDeliveryError) return Response.json({ ...(await apiError(e.original).json()), delivery: e.delivery }, { status: e.delivery === "pending" ? 409 : 400 });
    return apiError(e);
  }
}
