import { PassThrough, Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const config = {
  api: { bodyParser: false },
  supportsResponseStreaming: true,
  maxDuration: 60,
};

const TARGET_BASE = (process.env.TARGET_DOMAIN || "").replace(/\/$/, "");
const PLATFORM_HEADER_PREFIX = `x-${String.fromCharCode(118, 101, 114, 99, 101, 108)}-`;
const RELAY_PATH = normalizeRelayPath(process.env.RELAY_PATH || "");
const RELAY_KEY = (process.env.RELAY_KEY || "").trim();
const UPSTREAM_TIMEOUT_MS = parsePositiveInt(process.env.UPSTREAM_TIMEOUT_MS, 120000, 1000);
const MAX_INFLIGHT = parsePositiveInt(process.env.MAX_INFLIGHT, 24, 1);
const MAX_UP_BPS = parseNonNegativeInt(process.env.MAX_UP_BPS, 4587520);
const MAX_DOWN_BPS = parseNonNegativeInt(process.env.MAX_DOWN_BPS, 4587520);

const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST"]);
const FORWARD_HEADER_EXACT = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "cache-control",
  "content-length",
  "content-type",
  "pragma",
  "range",
  "referer",
  "user-agent",
]);
const FORWARD_HEADER_PREFIXES = ["sec-ch-", "sec-fetch-"];

const STRIP_HEADERS = new Set([
  "host",
  "connection",
  "proxy-connection",
  "keep-alive",
  "via",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "forwarded",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-forwarded-for",
  "x-real-ip",
]);

let inFlight = 0;

export default async function handler(req, res) {
  const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();
  let slotAcquired = false;

  if (!TARGET_BASE) {
    res.statusCode = 500;
    return res.end("Misconfigured: TARGET_DOMAIN is not set");
  }
  if (!RELAY_PATH) {
    res.statusCode = 500;
    return res.end("Misconfigured: RELAY_PATH is not set");
  }
  if (RELAY_PATH === "/") {
    res.statusCode = 500;
    return res.end("Misconfigured: RELAY_PATH cannot be '/'");
  }
  if (RELAY_KEY && RELAY_KEY.length < 16) {
    res.statusCode = 500;
    return res.end("Misconfigured: RELAY_KEY is too short");
  }

  try {
    const host = req.headers.host || "localhost";
    const url = new URL(req.url || "/", `https://${host}`);

    if (!isAllowedRelayPath(url.pathname)) {
      res.statusCode = 404;
      return res.end("Not Found");
    }

    if (!ALLOWED_METHODS.has(req.method)) {
      res.statusCode = 405;
      res.setHeader("allow", "GET, HEAD, POST");
      return res.end("Method Not Allowed");
    }

    if (RELAY_KEY) {
      const token = (req.headers["x-relay-key"] || "").toString();
      if (token !== RELAY_KEY) {
        res.statusCode = 403;
        return res.end("Forbidden");
      }
    }
    if (!tryAcquireSlot()) {
      res.statusCode = 503;
      res.setHeader("retry-after", "1");
      return res.end("Server Busy: Too Many Inflight Requests");
    }
    slotAcquired = true;

    const targetUrl = `${TARGET_BASE}${url.pathname}${url.search || ""}`;

    const headers = {};
    const clientIp = toHeaderValue(req.headers["x-real-ip"] || req.headers["x-forwarded-for"]);
    for (const key of Object.keys(req.headers)) {
      const lower = key.toLowerCase();
      const value = req.headers[key];
      if (STRIP_HEADERS.has(lower)) continue;
      if (lower.startsWith(PLATFORM_HEADER_PREFIX)) continue;
      if (lower === "x-relay-key") continue;
      if (!shouldForwardHeader(lower)) continue;
      const normalizedValue = toHeaderValue(value);
      if (normalizedValue) headers[lower] = normalizedValue;
    }
    if (clientIp) headers["x-forwarded-for"] = clientIp;

    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const abortCtrl = new AbortController();
    const timeoutRef = setTimeout(() => abortCtrl.abort("upstream_timeout"), UPSTREAM_TIMEOUT_MS);

    try {
      const fetchOpts = {
        method: req.method,
        headers,
        redirect: "manual",
        signal: abortCtrl.signal,
      };

      if (hasBody) {
        const uploadNodeStream = MAX_UP_BPS > 0
          ? req.pipe(createThrottleTransform(MAX_UP_BPS))
          : req;
        fetchOpts.body = Readable.toWeb(uploadNodeStream);
        fetchOpts.duplex = "half";
      }

      const upstream = await fetch(targetUrl, fetchOpts);

      res.statusCode = upstream.status;
      for (const [headerName, headerValue] of upstream.headers) {
        const k = headerName.toLowerCase();
        if (k === "transfer-encoding" || k === "connection") continue;
        try {
          res.setHeader(headerName, headerValue);
        } catch {}
      }

      if (!upstream.body) {
        res.end();
      } else {
        const upstreamNode = Readable.fromWeb(upstream.body);
        const downloadStream = MAX_DOWN_BPS > 0
          ? upstreamNode.pipe(createThrottleTransform(MAX_DOWN_BPS))
          : upstreamNode;
        await pipeline(downloadStream, res);
      }

      const durationMs = Date.now() - startedAt;
      console.info("relay ok", {
        requestId,
        path: url.pathname,
        method: req.method,
        status: upstream.status,
        durationMs,
      });
    } finally {
      clearTimeout(timeoutRef);
    }
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    if (err?.name === "AbortError") {
      console.error("relay timeout", {
        requestId,
        method: req.method,
        durationMs,
        timeoutMs: UPSTREAM_TIMEOUT_MS,
      });
      if (!res.headersSent) {
        res.statusCode = 504;
        return res.end("Gateway Timeout: Upstream Timeout");
      }
      return;
    }

    console.error("relay error", {
      requestId,
      method: req.method,
      durationMs,
      error: String(err),
    });
    if (!res.headersSent) {
      res.statusCode = 502;
      return res.end("Bad Gateway: Tunnel Failed");
    }
  } finally {
    if (slotAcquired) releaseSlot();
  }
}

function shouldForwardHeader(headerName) {
  if (FORWARD_HEADER_EXACT.has(headerName)) return true;
  for (const prefix of FORWARD_HEADER_PREFIXES) {
    if (headerName.startsWith(prefix)) return true;
  }
  return false;
}

function isAllowedRelayPath(pathname) {
  return pathname === RELAY_PATH || pathname.startsWith(`${RELAY_PATH}/`);
}

function normalizeRelayPath(rawPath) {
  if (!rawPath) return "";
  const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  if (path.length > 1 && path.endsWith("/")) return path.slice(0, -1);
  return path;
}

function parsePositiveInt(rawValue, fallbackValue, minValue) {
  const value = Number(rawValue);
  if (!Number.isFinite(value)) return fallbackValue;
  if (value < minValue) return fallbackValue;
  return Math.trunc(value);
}

function parseNonNegativeInt(rawValue, fallbackValue) {
  const value = Number(rawValue);
  if (!Number.isFinite(value)) return fallbackValue;
  if (value < 0) return fallbackValue;
  return Math.trunc(value);
}

function toHeaderValue(value) {
  if (!value) return "";
  return Array.isArray(value) ? value.join(", ") : String(value);
}

function tryAcquireSlot() {
  if (inFlight >= MAX_INFLIGHT) return false;
  inFlight += 1;
  return true;
}

function releaseSlot() {
  inFlight = Math.max(0, inFlight - 1);
}

function createThrottleTransform(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
    return new PassThrough();
  }

  const burstCap = Math.max(bytesPerSecond, 262144);
  let tokens = burstCap;
  let lastRefill = Date.now();

  function refillTokens() {
    const now = Date.now();
    const elapsedMs = now - lastRefill;
    if (elapsedMs <= 0) return;

    const refillAmount = (elapsedMs * bytesPerSecond) / 1000;
    tokens = Math.min(burstCap, tokens + refillAmount);
    lastRefill = now;
  }

  return new Transform({
    transform(chunk, _encoding, callback) {
      if (!chunk || chunk.length === 0) {
        callback();
        return;
      }

      let offset = 0;

      const pump = () => {
        refillTokens();

        if (tokens < 1) {
          setTimeout(pump, 5);
          return;
        }

        const writableSize = Math.min(chunk.length - offset, Math.max(1, Math.floor(tokens)));
        const piece = chunk.subarray(offset, offset + writableSize);
        tokens -= writableSize;
        offset += writableSize;

        this.push(piece);

        if (offset >= chunk.length) {
          callback();
          return;
        }

        setImmediate(pump);
      };

      pump();
    },
  });
}
