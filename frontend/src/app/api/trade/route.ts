import { apiError, authenticate, configured, jsonBody } from "@/server/privy";
import { delegatedTrade } from "@/server/trade";
export const runtime = "nodejs";
export async function POST(request: Request) {
  if (!configured("trade")) return Response.json({ error: "One-click trading is not configured." }, { status: 503 });
  try { const user = await authenticate(request); return Response.json({ hash: await delegatedTrade(user, await jsonBody(request)) }); }
  catch (e) { return apiError(e); }
}
