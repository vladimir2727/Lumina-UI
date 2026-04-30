export const config = { 
  runtime: "edge",
};

const BACKEND_SERVER = (process.env.BACKEND_SERVER || "").replace(/\/$/, "");

const BLOCKED_HEADERS = new Set([
  "host", "connection", "keep-alive", "proxy-authenticate",
  "proxy-authorization", "te", "trailer", "transfer-encoding",
  "upgrade", "forwarded", "x-forwarded-host", "x-forwarded-proto"
]);

export default async function handler(req) {
  if (!BACKEND_SERVER) {
    return new Response("API Backend under maintenance", { status: 503 });
  }

  try {
    const urlObj = new URL(req.url);
    const targetUrl = BACKEND_SERVER + (urlObj.pathname || "/") + urlObj.search;

    const headers = new Headers();
    let forwardedIp = null;

    for (const [key, value] of req.headers) {
      const lowerKey = key.toLowerCase();

      if (BLOCKED_HEADERS.has(lowerKey)) continue;
      if (lowerKey.startsWith("x-vercel-")) continue;

      if (lowerKey === "x-real-ip" || lowerKey === "x-forwarded-for") {
        if (!forwardedIp) forwardedIp = value;
        continue;
      }

      headers.set(key, value);
    }

    if (forwardedIp) {
      headers.set("x-forwarded-for", forwardedIp);
    }

    const hasBody = req.method !== "GET" && req.method !== "HEAD";

    const response = await fetch(targetUrl, {
      method: req.method,
      headers: headers,
      body: hasBody ? req.body : undefined,
      duplex: "half",
      redirect: "manual",
    });

    return new Response(response.body, {
      status: response.status,
      headers: response.headers,
    });

  } catch (err) {
    console.error("Gateway processing error:", err);
    return new Response("Upstream connection timeout", { status: 502 });
  }
}
