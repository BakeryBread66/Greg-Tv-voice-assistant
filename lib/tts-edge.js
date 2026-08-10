// Greg's cloud voice — the fallback when local Piper isn't available.
//
// Talks to Microsoft's neural text-to-speech service (the same engine behind Edge's
// "Read Aloud") over a WebSocket. Free, no API key, and it sounds like a person
// rather than a 1998 screen reader. Node 20+ has a built-in WebSocket, so this
// needs no dependencies at all.
//
// This is the one part of Greg that needs internet. Only what Greg *says* is sent,
// never what you say — but see lib/tts-piper.js for the offline path that avoids
// the trip entirely.

import crypto from "node:crypto";

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const ENDPOINT = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const WIN_EPOCH = 11644473600; // seconds between 1601-01-01 and 1970-01-01
const GEC_VERSION = "1-140.0.3485.14";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0";

// The service requires a rolling SHA-256 token derived from the current 5-minute window.
function securityToken() {
  let ticks = Math.floor(Date.now() / 1000) + WIN_EPOCH;
  ticks -= ticks % 300;
  ticks *= 1e9 / 100; // to 100-nanosecond intervals
  return crypto.createHash("sha256").update(`${ticks}${TRUSTED_CLIENT_TOKEN}`, "ascii").digest("hex").toUpperCase();
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n) => String(n).padStart(2, "0");

// The service is picky: it wants a JavaScript-style date string, not ISO-8601.
function timestamp() {
  const d = new Date();
  return (
    `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCDate())} ${d.getUTCFullYear()} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`
  );
}

const escapeXml = (text) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

const connectionId = () => crypto.randomUUID().replace(/-/g, "");

// Small cache so repeated lines (greetings, "one moment") don't re-synthesize.
const cache = new Map();
const CACHE_LIMIT = 40;

/**
 * Turn text into MP3 audio.
 * @returns {Promise<Buffer>} 24kHz mono MP3
 */
export function synthesize(text, { voice = "en-GB-RyanNeural", rate = "+0%", pitch = "+0Hz", volume = "+0%" } = {}) {
  const clean = String(text ?? "").trim().slice(0, 3000);
  if (!clean) return Promise.resolve(Buffer.alloc(0));

  const key = `${voice}|${rate}|${pitch}|${clean}`;
  if (cache.has(key)) return Promise.resolve(cache.get(key));

  return new Promise((resolve, reject) => {
    const url =
      `${ENDPOINT}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
      `&Sec-MS-GEC=${securityToken()}&Sec-MS-GEC-Version=${GEC_VERSION}&ConnectionId=${connectionId()}`;

    let socket;
    try {
      socket = new WebSocket(url, {
        headers: {
          Pragma: "no-cache",
          "Cache-Control": "no-cache",
          Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
          "Accept-Language": "en-US,en;q=0.9",
          "User-Agent": UA,
        },
      });
    } catch (err) {
      return reject(err);
    }
    socket.binaryType = "arraybuffer";

    const chunks = [];
    let settled = false;

    const finish = (err, buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {}
      if (err) return reject(err);
      if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
      cache.set(key, buffer);
      resolve(buffer);
    };

    const timer = setTimeout(() => finish(new Error("speech synthesis timed out")), 20000);

    socket.addEventListener("open", () => {
      socket.send(
        `X-Timestamp:${timestamp()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
          JSON.stringify({
            context: {
              synthesis: {
                audio: {
                  metadataoptions: { sentenceBoundaryEnabled: "false", wordBoundaryEnabled: "false" },
                  outputFormat: "audio-24khz-48kbitrate-mono-mp3",
                },
              },
            },
          })
      );

      // Note the namespace: the service rejects anything but the W3C synthesis one.
      const ssml =
        `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
        `<voice name='${voice}'><prosody pitch='${pitch}' rate='${rate}' volume='${volume}'>` +
        `${escapeXml(clean)}</prosody></voice></speak>`;

      socket.send(
        `X-RequestId:${connectionId()}\r\nContent-Type:application/ssml+xml\r\n` +
          `X-Timestamp:${timestamp()}Z\r\nPath:ssml\r\n\r\n${ssml}`
      );
    });

    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        if (event.data.includes("Path:turn.end")) finish(null, Buffer.concat(chunks));
        return;
      }
      // Binary frames are: [2-byte header length][header text][audio bytes]
      const buf = Buffer.from(event.data);
      const headerLength = buf.readUInt16BE(0);
      const header = buf.subarray(2, 2 + headerLength).toString("utf8");
      if (header.includes("Path:audio")) chunks.push(buf.subarray(2 + headerLength));
    });

    socket.addEventListener("error", (event) =>
      finish(new Error(`speech service error: ${event.message ?? event.error?.message ?? "connection failed"}`))
    );

    socket.addEventListener("close", (event) => {
      if (settled) return;
      if (chunks.length) return finish(null, Buffer.concat(chunks));
      finish(new Error(`speech service closed (${event.code})${event.reason ? `: ${event.reason}` : ""}`));
    });
  });
}
