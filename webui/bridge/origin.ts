// Local-origin gate for the browser-facing endpoints. The bridge can run an
// agent with full local access, so a page from anywhere on the internet must
// not reach it: a WS upgrade carries no CORS preflight, and 127.0.0.1 is
// reachable from any page the browser loads.
export type OriginDecision = { allowed: true } | { allowed: false; reason: string };

/** Host names that mean "this machine" for a page the bridge serves. */
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Accept a request whose `Origin` names a local page, and any request without
 * one (a non-browser client such as curl or a test has no origin to forge).
 * Ports are not compared: the dev setup serves the page from Vite on 5173 and
 * proxies to the bridge on 5174.
 */
export function checkOrigin(origin: string | undefined): OriginDecision {
  if (origin === undefined || origin === "") return { allowed: true };
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return { allowed: false, reason: "origin 无法解析" };
  }
  // "null" (sandboxed iframe, file://) and non-http schemes never name a page
  // this bridge serves.
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { allowed: false, reason: "origin 协议不受支持" };
  }
  if (!LOCAL_HOSTS.has(url.hostname)) {
    return { allowed: false, reason: "只允许本机页面连接" };
  }
  return { allowed: true };
}