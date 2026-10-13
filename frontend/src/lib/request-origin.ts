/** Compare the browser's origin with the requested public authority. */
export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const target = new URL(request.url);
    // Next may construct request.url from its bind address (0.0.0.0).
    const host = request.headers.get("host") || target.host;
    const forwardedProtocol = request.headers.get("x-forwarded-proto");
    const protocol = forwardedProtocol === "https" || forwardedProtocol === "http" ? `${forwardedProtocol}:` : target.protocol;
    return origin === parsed.origin && parsed.host === host && parsed.protocol === protocol;
  } catch { return false; }
}
