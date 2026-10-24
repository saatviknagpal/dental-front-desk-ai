/**
 * The visitor's IP, for rate limits and abuse limits.
 * CLIENT_IP_HEADER names a header the edge proxy sets and clients can't forge (on Render, Cloudflare's
 * cf-connecting-ip). Without it, use the last X-Forwarded-For entry, which our own proxy appends.
 */
export function clientIp(headers: Headers): string {
  const trusted = process.env.CLIENT_IP_HEADER?.trim();
  const fromEdge = trusted ? headers.get(trusted)?.trim() : undefined;
  return fromEdge || headers.get("x-forwarded-for")?.split(",").pop()?.trim() || "local";
}
