// Who is allowed to talk to Greg's server.
//
// Greg binds to 127.0.0.1, which keeps the network out but does NOT keep out a
// web page. A browser will happily send requests to localhost on behalf of any
// site you visit, and there are two ways that turns into a real problem:
//
//   DNS REBINDING, which is the serious one. A site re-points its own domain at
//   127.0.0.1, so the browser believes evil.example.com and Greg are the same
//   origin. Same-origin policy then protects nothing and the page can READ the
//   replies: /api/settings alone carries the user's city and coordinates, and
//   /api/chat can be driven into read_file, look_at_screen and
//   recall_conversation. The defence is to check the Host header, because a
//   rebound request still says "Host: evil.example.com".
//
//   CSRF, which is smaller but real. A cross-origin POST with a "simple"
//   content type needs no preflight, so it is delivered even though the reply
//   is unreadable. That is enough to make Greg act - take a screenshot, change
//   a setting, switch a channel - blind but genuine.
//
// Both checks are pure functions so they can be proven without a browser, which
// matters: neither is testable by clicking around, and both fail silently in
// the direction of being too permissive.

/** Names that really mean "this machine". */
const LOCAL = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0:0:0:0:0:0:0:1"]);

/** Split "host:port", coping with the brackets IPv6 needs. */
function splitHostPort(value) {
  const text = String(value).trim();
  if (text.startsWith("[")) {
    const close = text.indexOf("]");
    if (close === -1) return { name: "", port: "" };
    return { name: text.slice(0, close + 1), port: text.slice(close + 2) };
  }
  const colon = text.lastIndexOf(":");
  if (colon === -1) return { name: text, port: "" };
  return { name: text.slice(0, colon), port: text.slice(colon + 1) };
}

/**
 * Is this request addressed to us by a name that means this machine?
 *
 * A missing Host is refused: HTTP/1.1 requires one, so its absence is either a
 * broken client or somebody probing. Refusing is the safer way to be wrong,
 * since the only thing it costs is a request nobody legitimately makes.
 */
export function hostAllowed(host, port) {
  if (!host) return false;
  const { name, port: given } = splitHostPort(host);
  if (given && Number(given) !== Number(port)) return false;
  return LOCAL.has(name.toLowerCase());
}

/**
 * Is this request coming from a page we are willing to act for?
 *
 * An ABSENT Origin is allowed, deliberately. Browsers attach it to every
 * cross-origin request, so absence means a non-browser client — curl, a script,
 * another program on the machine — and refusing those would break using Greg
 * from a terminal, which the docs describe. The literal string "null" is NOT
 * absence: browsers send it for sandboxed iframes and file:// pages, which is
 * exactly the shape an attacker would like to have accepted.
 */
export function originAllowed(origin, port) {
  if (origin === undefined || origin === null || origin === "") return true;
  if (origin === "null") return false;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.port && Number(parsed.port) !== Number(port)) return false;
  return LOCAL.has(parsed.hostname.toLowerCase());
}

/** Requests that can change something, and so need the Origin check too. */
export const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * The whole decision for one request: null to proceed, or a reason to refuse.
 *
 * Returned as a reason rather than a boolean so the server can say WHICH check
 * failed. A blanket 403 on a local app is the kind of thing somebody spends an
 * evening on.
 */
export function refuseReason({ host, origin, method }, port) {
  if (!hostAllowed(host, port)) {
    return `Refused: this server only answers to localhost:${port}. A request arrived addressed to "${host ?? "(no Host header)"}", which is what a DNS-rebinding attack looks like.`;
  }
  if (WRITES.has(String(method).toUpperCase()) && !originAllowed(origin, port)) {
    return `Refused: a ${method} arrived from "${origin}", which is not this machine. Greg only accepts changes from his own page.`;
  }
  return null;
}
