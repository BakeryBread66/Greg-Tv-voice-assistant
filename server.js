// Greg's server: serves the face, and answers the browser's questions.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { loadConfig, firstRunNotice } from "./lib/config.js";
import { refuseReason } from "./lib/guard.js";
import { synthesize } from "./lib/tts.js";
import { initPiper, piperStatus, stopPiper } from "./lib/tts-piper.js";
import { initSapi } from "./lib/tts-sapi.js";
import { initClone, cloneStatus, stopClone } from "./lib/tts-clone.js";
import { powerState, setVision, setGamingMode, onPowerChange } from "./lib/power.js";
import { channelState, setChannel, turnKnob, onChannelChange, addChannels } from "./lib/channels.js";
import { initSettings, settingsState, applySettings, onSettingsChange } from "./lib/settings.js";
import { getNowPlaying, getArt, stopNowPlaying } from "./lib/nowplaying.js";
import { getProgramme, clearProgrammes, addProgramme } from "./lib/programmes.js";
import { loadAddons, addonLoader, ADDON_FOLDER } from "./lib/addons.js";
import { refreshChannelTool } from "./lib/tools/channels.js";
import { getApodImage } from "./lib/apod.js";
import { getRadarFrame } from "./lib/radar.js";
import { startAlertWatch, stopAlertWatch, onAlert } from "./lib/alertwatch.js";
import { initConversationLog, logTurn, conversationStats, clearConversations } from "./lib/conversation-log.js";
import { getCursor, stopCursorWatch } from "./lib/cursor.js";
import { initCache, warmCache, cacheStats, DEFAULT_PHRASES } from "./lib/tts-cache.js";
import { think, initBrain, describeBrain, initVision, warmBrain } from "./lib/brain.js";
import { getLocation } from "./lib/location.js";
import { getWeather, weatherToSentence } from "./lib/weather.js";
// newsToSentence is no longer imported here: the globe fetches headlines to
// LIST, not to speak. lib/brain.js still uses it for the no-API-key fallback.
import { getNews } from "./lib/news.js";
import { getQuakes } from "./lib/quakes.js";
import { getFlights } from "./lib/flights.js";
import { geocode } from "./lib/geocode.js";
import { setSelectedPlace, getSelectedPlace } from "./lib/selection.js";
import { initPersonality, TRAITS } from "./lib/personality.js";
import { initSpotify, loginUrl, completeLogin, status as spotifyStatus, duck, unduck } from "./lib/spotify.js";
import { initReminders } from "./lib/reminders.js";
import { initStt, transcribe, sttStatus, stopStt } from "./lib/stt.js";
import { visionStatus } from "./lib/vision.js";
import { setWindowRect } from "./lib/screen.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "public");

// The globe, its textures and the country outlines all ship inside the npm
// packages — the CDN URLs you see in globe.gl examples are just unpkg serving
// those same files. Serving them from node_modules keeps the dashboard working
// with the internet unplugged, which is the whole point of the rest of Greg.
const GLOBE_FILES = {
  "globe.gl.min.js": path.join(ROOT, "node_modules", "globe.gl", "dist", "globe.gl.min.js"),
  "countries.geojson": path.join(
    ROOT, "node_modules", "three-globe", "example", "country-polygons", "ne_110m_admin_0_countries.geojson"
  ),
};
const GLOBE_IMG_DIR = path.join(ROOT, "node_modules", "three-globe", "example", "img");

// Load .env if the user made one (Node reads it natively).
try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {
  // no .env yet — fallback mode
}

// A fresh clone has no config.json — it is gitignored, because it carries the
// user's coordinates. This used to be a bare JSON.parse of a file that wasn't
// there, so the first thing anybody cloning the repo saw was a stack trace.
// lib/config.js creates it from the example on a first run, and refuses to start
// rather than overwrite one that exists and will not parse.
let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
const PORT = Number(process.env.PORT) || config.port || 4747;

// One user, one machine, one conversation.
const history = [];

// When Greg woke up. The face shows this as a running clock on the test card,
// so it has to be the server's uptime rather than the page's — reloading the
// window shouldn't reset it, and reconnecting after a restart should.
const STARTED_AT = Date.now();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".geojson": "application/geo+json; charset=utf-8",
};

const sendJson = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
};

// Open browser connections that want pushed events (a timer coming due).
const listeners = new Set();

function broadcast(payload) {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of listeners) {
    try {
      res.write(frame);
    } catch {
      listeners.delete(res);
    }
  }
}

function readBody(req, limitBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > limitBytes) {
        reject(new Error("request too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function serveStatic(req, res, urlPath) {
  const relative = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath).replace(/^\/+/, "");
  const filePath = path.join(PUBLIC_DIR, relative);

  // Never serve anything outside public/.
  // The separator matters: without it "public" also matches a sibling called
  // "public-anything", which is the same defect lib/files.js fixed in its root
  // check. Latent today because no such folder exists — which is exactly when
  // it is cheap to close.
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  // Before anything else: is this request actually from this machine?
  //
  // Binding to 127.0.0.1 keeps the network out but not a web page — a browser
  // sends requests to localhost for any site you visit. See lib/guard.js for
  // the two attacks this closes; the important one is DNS rebinding, which
  // would otherwise let a site read /api/settings (city and coordinates) and
  // drive /api/chat into read_file and look_at_screen.
  const refusal = refuseReason(
    { host: req.headers.host, origin: req.headers.origin, method: req.method },
    PORT
  );
  if (refusal) {
    console.warn(`[guard] ${refusal}`);
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end(refusal);
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    // --- Live event stream: how a timer reaches the browser and speaks ---
    if (url.pathname === "/api/events" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      res.write("retry: 3000\n\n");
      listeners.add(res);

      // Comment frames keep proxies and idle sockets from dropping the stream.
      const keepAlive = setInterval(() => {
        try {
          res.write(": ping\n\n");
        } catch {
          clearInterval(keepAlive);
        }
      }, 25000);

      req.on("close", () => {
        clearInterval(keepAlive);
        listeners.delete(res);
      });
      return;
    }

    // --- Heartbeat: lets the page notice when Greg has been shut down ---
    if (url.pathname === "/api/health") {
      return sendJson(res, 200, { ok: true });
    }

    // --- Load the model while the set is still warming up ---
    //
    // Answered IMMEDIATELY rather than when the model has finished loading. The
    // page fires this and forgets it, and a request left open for the nine
    // seconds gemma4:e4b takes to read off the disk would sit in the browser's
    // connection budget for the whole warm-up, behind which the boot sequence's
    // own fetches are queued. Nothing is waiting on the answer.
    if (url.pathname === "/api/warm" && req.method === "POST") {
      warmBrain().then(({ warmed, reason }) => {
        console.log(warmed ? `[brain] pre-loaded (${reason})` : `[brain] not pre-loaded: ${reason}`);
      });
      return sendJson(res, 202, { started: true });
    }

    // --- Startup info for the browser ---
    if (url.pathname === "/api/config" && req.method === "GET") {
      const loc = await getLocation(config);
      const brain = describeBrain();
      const ears = sttStatus();
      const mouth = piperStatus();
      return sendJson(res, 200, {
        name: config.name ?? "Greg",
        wakeWords: config.wakeWords ?? ["hey greg"],
        followUp: config.followUp ?? { enabled: true, seconds: 7 },
        bargeIn: config.bargeIn ?? { enabled: true, sustainMs: 350 },
        hasBrain: brain.active,
        brainLabel: brain.label,
        // Coordinates as well as the name, so the globe can drop a home marker.
        location: { city: loc.city, region: loc.region, latitude: loc.latitude, longitude: loc.longitude },
        // "local" = offline Whisper on this machine, "browser" = Chrome's cloud service
        listening: ears.state === "ready" ? "local" : "browser",
        earsLabel: ears.state === "ready" ? `${ears.model} on ${ears.device}` : "browser speech recognition",
        // "local" = offline Piper on this machine, "cloud" = Microsoft's voices
        speaking: mouth.state === "ready" ? "local" : "cloud",
        voiceLabel: mouth.state === "ready" ? mouth.voice : config.voice,
        canSeeScreen: visionStatus().ok,
        // Projected here as well as in /api/settings, so the page can paint the
        // desktop on its first load rather than only once the dialog has been
        // opened. Read-only, like the name beside it — settings.js still owns it.
        desktop: settingsState().appearance.background,
        startedAt: STARTED_AT,
      });
    }

    // --- Ask Greg something ---
    if (url.pathname === "/api/chat" && req.method === "POST") {
      const { text, awaySeconds } = await readBody(req);
      if (!text || !String(text).trim()) return sendJson(res, 400, { error: "no text supplied" });

      console.log(`\n[you]  ${text}`);
      const started = Date.now();
      const { reply, usedTools } = await think(String(text).trim(), history, config, null, awaySeconds);
      console.log(`[greg] ${reply}`);
      if (usedTools.length) console.log(`       (used: ${usedTools.join(", ")}, ${Date.now() - started}ms)`);

      logTurn({ user: text, reply, usedTools, ms: Date.now() - started });
      return sendJson(res, 200, { reply, usedTools });
    }

    // --- Ask Greg something, hearing each sentence as it lands ---
    //
    // Same answer as /api/chat, delivered a sentence at a time so the browser can
    // start synthesizing the first one while the rest is still being written.
    if (url.pathname === "/api/chat/stream" && req.method === "POST") {
      const { text, awaySeconds } = await readBody(req);
      if (!text || !String(text).trim()) return sendJson(res, 400, { error: "no text supplied" });

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });

      console.log(`\n[you]  ${text}`);
      const started = Date.now();
      let firstAt = null;
      let index = 0;

      const send = (payload) => {
        try {
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        } catch {
          // The page went away mid-answer; the loop below finishes harmlessly.
        }
      };

      const { reply, usedTools } = await think(
        String(text).trim(),
        history,
        config,
        (sentence) => {
          if (firstAt === null) firstAt = Date.now() - started;
          send({ type: "sentence", text: sentence, index: index++ });
        },
        awaySeconds
      );

      console.log(`[greg] ${reply}`);
      const detail = [
        usedTools.length ? `used: ${usedTools.join(", ")}` : null,
        firstAt !== null ? `first sentence ${firstAt}ms` : null,
        `total ${Date.now() - started}ms`,
      ].filter(Boolean);
      console.log(`       (${detail.join(", ")})`);

      // After the reply is out, never before: this touches the disk and the
      // streaming path measures its own time to first sentence.
      logTurn({ user: text, reply, usedTools, ms: Date.now() - started });

      send({ type: "done", reply, usedTools });
      return res.end();
    }

    // --- Turn speech into text, locally ---
    if (url.pathname === "/api/transcribe" && req.method === "POST") {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 12_000_000) return sendJson(res, 413, { error: "audio too long" });
        chunks.push(chunk);
      }
      if (!size) return sendJson(res, 400, { error: "no audio" });

      const result = await transcribe(Buffer.concat(chunks));
      return sendJson(res, 200, result);
    }

    // --- Turn text into speech ---
    if (url.pathname === "/api/tts" && req.method === "POST") {
      const { text } = await readBody(req);
      if (!text || !String(text).trim()) return sendJson(res, 400, { error: "no text supplied" });

      // Local Piper returns WAV, the cloud fallback MP3 — the browser plays
      // either, but only if the header says which one it's getting.
      const { audio, contentType } = await synthesize(String(text), {
        voice: config.voice,
        rate: config.rate,
        pitch: config.pitch,
      });

      res.writeHead(200, { "Content-Type": contentType, "Content-Length": audio.length, "Cache-Control": "no-store" });
      return res.end(audio);
    }

    // --- Somewhere on the globe was clicked ---
    //
    // Answers the caller with the detail for the panel, and pushes the spoken
    // version through the event stream so Greg says it out loud in the main
    // window. The globe deliberately has no voice of its own: two windows
    // talking over each other would be a mess, and his face is the thing that
    // should be reacting anyway.
    // Where the mouse is when it has left the browser, so Greg's head can keep
    // following it. Polled only while the pointer is outside the window; the
    // watcher process starts on the first ask and stops when they stop.
    if (url.pathname === "/api/cursor" && req.method === "GET") {
      return sendJson(res, 200, getCursor());
    }

    // A verbatim record of everything said needs a way to look at it and a way
    // to destroy it. Both live here rather than behind a tool, because neither
    // is something the model should be doing on its own initiative.
    if (url.pathname === "/api/conversations" && req.method === "GET") {
      return sendJson(res, 200, conversationStats());
    }

    if (url.pathname === "/api/conversations" && req.method === "DELETE") {
      const result = clearConversations();
      console.log("[log] conversation history cleared");
      return sendJson(res, result.ok ? 200 : 500, result);
    }

    if (url.pathname === "/api/power" && req.method === "GET") {
      return sendJson(res, 200, powerState());
    }

    if (url.pathname === "/api/power" && req.method === "POST") {
      const body = await readBody(req);
      const on = Boolean(body.on);

      // Same two switches the voice tools use, so the button and "gaming mode on"
      // cannot drift apart — both go through lib/power.js and both broadcast.
      if (body.what === "gamingMode") {
        const result = await setGamingMode(on, config);
        console.log(`[power] gaming mode ${on ? "on" : "off"} (from the face)`);
        return sendJson(res, 200, result);
      }
      if (body.what === "vision") {
        const result = await setVision(on, config);
        if (!result.ok) return sendJson(res, 409, result);
        console.log(`[eyes] switched ${on ? "on" : "off"} (from the face)`);
        return sendJson(res, 200, result);
      }
      return sendJson(res, 400, { error: "say what to switch: gamingMode or vision" });
    }

    // --- The settings dialog ---
    //
    // Only the settings that take effect without a restart; see lib/settings.js
    // for why the rest are deliberately absent.
    if (url.pathname === "/api/settings" && req.method === "GET") {
      return sendJson(res, 200, settingsState());
    }

    if (url.pathname === "/api/settings" && req.method === "POST") {
      const result = await applySettings(await readBody(req));
      if (result.error) return sendJson(res, 500, result);
      if (result.problems.length) console.log(`[settings] ${result.problems.join(" ")}`);
      else console.log(`[settings] updated — ${result.resolved?.city ?? "location unchanged"}`);
      // 200 even with problems: some of the patch may have applied, and the
      // dialog needs the real state back either way so it can't drift from what
      // was actually accepted.
      return sendJson(res, 200, result);
    }

    // --- What is on Greg's screen ---
    //
    // Same shape as /api/power: the state lives on the server, both the knob and
    // the voice tool go through lib/channels.js, and every change is broadcast so
    // the two can never disagree about what is showing.
    if (url.pathname === "/api/channel" && req.method === "GET") {
      return sendJson(res, 200, channelState());
    }

    if (url.pathname === "/api/channel" && req.method === "POST") {
      const body = await readBody(req);
      const result = body.step ? turnKnob(Number(body.step)) : setChannel(body.channel);
      if (result.error) return sendJson(res, 400, result);
      if (result.changed) console.log(`[channel] ${result.channel} — ${result.name} (from the face)`);
      return sendJson(res, 200, result);
    }

    // --- What a channel is showing ---
    //
    // One route for every channel with live data behind it, rather than a
    // bespoke endpoint each. The registry in lib/programmes.js owns the caching,
    // the de-duplication and the poll interval, so adding a channel does not add
    // anything here. The reply carries `pollMs`, and the page sets its timer
    // from that — a rate limit is enforced where it is understood.
    // An add-on's own renderer, served out of its folder so the page can
    // import() it. Only ever `channels/<id>/render.js` — the id is rebuilt from
    // scratch out of safe characters rather than trusted, so nothing in the URL
    // can climb out of the folder. Serving somebody's whole disk through the
    // one route that hands back JavaScript would be a poor way to end.
    if (url.pathname.startsWith("/api/channels/") && req.method === "GET") {
      const id = url.pathname.slice("/api/channels/".length).replace(/\/render\.js$/, "");
      const safe = id.toLowerCase().replace(/[^a-z0-9-]/g, "");
      const file = path.join(ADDON_FOLDER, safe, "render.js");
      if (!safe || !file.startsWith(ADDON_FOLDER)) return res.writeHead(403).end("Forbidden");
      return fs.readFile(file, (err, data) => {
        if (err) return res.writeHead(404, { "Content-Type": "text/plain" }).end("no renderer");
        res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" }).end(data);
      });
    }

    if (url.pathname === "/api/programme" && req.method === "GET") {
      const id = url.searchParams.get("id") ?? "";
      const data = await getProgramme(id, config);
      // A channel that has never loaded is a 503, not a 200 with an error in
      // it: the page has to be able to tell "nothing to show" from "here is
      // something, it is just old".
      return sendJson(res, data.error && !data.at ? 503 : 200, data);
    }

    // The astronomy picture, proxied rather than linked.
    //
    // The browser could fetch apod.nasa.gov directly, but then the image is
    // re-downloaded on every reload and Greg's "works with the internet
    // unplugged except for the feeds" property gets one more exception. Cached
    // on disk here, keyed by date in the URL so a new picture is a new URL and
    // yesterday's can never be served for today.
    if (url.pathname === "/api/apod/image" && req.method === "GET") {
      try {
        const image = await getApodImage(config);
        if (!image) return sendJson(res, 404, { error: "today's entry is a video with no still" });
        res.writeHead(200, {
          "Content-Type": image.contentType,
          "Content-Length": image.bytes.length,
          "Cache-Control": "public, max-age=3600",
        });
        return res.end(image.bytes);
      } catch (err) {
        return sendJson(res, 502, { error: err.message });
      }
    }

    // One radar sweep. Proxied rather than linked for two reasons: the NWS sends
    // no CORS header, so a frame fetched straight into the face canvas would
    // taint it — and the frame URLs are positional, `_0` always meaning "the
    // newest", so their content changes every couple of minutes and caching by
    // URL is worthless. The version here is the loop's identity instead.
    if (url.pathname === "/api/radar/frame" && req.method === "GET") {
      const frame = getRadarFrame(Number(url.searchParams.get("i")) || 0);
      if (!frame) return sendJson(res, 404, { error: "no such radar frame" });
      res.writeHead(200, {
        "Content-Type": frame.contentType,
        "Content-Length": frame.bytes.length,
        "Cache-Control": "public, max-age=600",
      });
      return res.end(frame.bytes);
    }

    // --- What Windows says is playing, for the now-playing channel ---
    //
    // Asking is what keeps the watcher process alive, so the page polling this
    // while the channel is up is also what stops it idling out. Switch away and
    // nothing asks, and it shuts itself down a minute later.
    if (url.pathname === "/api/nowplaying" && req.method === "GET") {
      return sendJson(res, 200, await getNowPlaying({ waitMs: Number(url.searchParams.get("wait")) || 0 }));
    }

    // The artwork itself, as a plain image rather than base64 inside the JSON
    // above — it is a few hundred KB and the browser should be able to cache it.
    // The version in the query string is what makes that safe: a new track is a
    // new URL, so a stale picture can never be served for a new song.
    if (url.pathname === "/api/nowplaying/art" && req.method === "GET") {
      const art = getArt();
      if (!art) return sendJson(res, 404, { error: "no artwork for what is playing" });
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": art.image.length,
        // Immutable per version, and the version is in the URL.
        "Cache-Control": "public, max-age=3600",
      });
      return res.end(art.image);
    }

    if (url.pathname === "/api/place" && req.method === "POST") {
      const { lat, lon, name } = await readBody(req);
      const latitude = Number(lat);
      const longitude = Number(lon);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return sendJson(res, 400, { error: "need a latitude and longitude" });
      }

      const place = {
        city: String(name ?? "").trim() || "that spot",
        region: "",
        latitude,
        longitude,
      };

      console.log(`\n[globe] ${place.city} (${latitude.toFixed(2)}, ${longitude.toFixed(2)})`);

      // Remember it, so "what's the news here?" in the main window means here.
      setSelectedPlace(place);

      // One slow source shouldn't cost you the other, so they're independent.
      const [weather, news] = await Promise.allSettled([
        getWeather(config, { days: 2, place }),
        getNews(config, { scope: "local", limit: 4, place }),
      ]);

      // Now that the forecast has come back we know the timezone too, so "what
      // time is it here?" can be answered without a second lookup.
      if (weather.status === "fulfilled" && weather.value.timezone) {
        setSelectedPlace({ ...place, timezone: weather.value.timezone });
      }

      // The headlines are FETCHED but not SPOKEN.
      //
      // Clicking a place used to get you the time, the weather and two news
      // stories read aloud — which is a lot of talking for what is often just a
      // look at the map, and the headlines are the longest part of it. They are
      // still returned and the dashboard still lists them, so they are there to
      // read; they are simply no longer read TO you.
      //
      // Asking still works and is unchanged: "what's the news there?" goes
      // through get_local_news with the selection resolved by lib/selection.js,
      // so prompting for them speaks them exactly as before.
      const spoken = [
        weather.status === "fulfilled" && weather.value.localTime
          ? `It's ${weather.value.localTime} in ${place.city}.`
          : "",
        weather.status === "fulfilled"
          ? weatherToSentence(weather.value)
          : `I couldn't get the weather for ${place.city}.`,
      ]
        .filter(Boolean)
        .join(" ");

      broadcast({ type: "say", text: spoken });

      return sendJson(res, 200, {
        place: place.city,
        weather: weather.status === "fulfilled" ? weather.value : null,
        news: news.status === "fulfilled" ? news.value.stories : [],
        localTime: weather.status === "fulfilled" ? weather.value.localTime : null,
        timezone: weather.status === "fulfilled" ? weather.value.timezone : null,
        spoken,
      });
    }

    // --- Recent earthquakes, for the globe ---
    if (url.pathname === "/api/quakes" && req.method === "GET") {
      const data = await getQuakes({ feed: url.searchParams.get("feed") ?? undefined });
      return sendJson(res, 200, data);
    }

    // --- Aircraft near a point ---
    //
    // Failure here is deliberately soft: the quota is small and running out
    // should dim the layer, not break the dashboard.
    if (url.pathname === "/api/flights" && req.method === "GET") {
      try {
        const data = await getFlights({
          lat: url.searchParams.get("lat"),
          lon: url.searchParams.get("lon"),
          span: Number(url.searchParams.get("span")) || undefined,
        });
        return sendJson(res, 200, data);
      } catch (err) {
        return sendJson(res, 200, { aircraft: [], error: err.message });
      }
    }

    // --- Place name to coordinates, for the search box ---
    if (url.pathname === "/api/geocode" && req.method === "GET") {
      const results = await geocode(url.searchParams.get("q") ?? "", { count: 6 });
      return sendJson(res, 200, { results });
    }

    // --- Connecting Spotify ---
    //
    // Two endpoints, used once. The browser goes to /login, approves on
    // Spotify's own page, and Spotify sends it back to /callback with a code we
    // swap for a refresh token. Greg never sees a password.
    if (url.pathname === "/api/spotify/login" && req.method === "GET") {
      try {
        res.writeHead(302, { Location: loginUrl() }).end();
      } catch (err) {
        sendJson(res, 400, { error: err.message });
      }
      return;
    }

    if (url.pathname === "/api/spotify/callback" && req.method === "GET") {
      const denied = url.searchParams.get("error");
      const page = (title, detail) =>
        `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
        `<body style="background:#008080;font-family:'MS Sans Serif',Tahoma,sans-serif;font-size:12px;display:grid;place-items:center;height:100vh;margin:0">` +
        `<div style="background:#c0c0c0;padding:3px;border:2px solid;border-color:#dfdfdf #000 #000 #dfdfdf;box-shadow:inset 1px 1px 0 #fff,inset -1px -1px 0 #808080;width:320px">` +
        `<div style="background:linear-gradient(90deg,#000080,#1084d0);color:#fff;font-weight:bold;padding:2px 4px">Greg</div>` +
        `<div style="padding:14px;text-align:center;line-height:1.5">${detail}</div></div>`;

      if (denied) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(page("Not connected", `Spotify said: <b>${denied}</b>.<br>Nothing was changed.`));
      }

      try {
        await completeLogin(url.searchParams.get("code"), url.searchParams.get("state"));
        console.log("[spotify] connected");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(page("Connected", "Spotify is connected.<br>You can close this window and ask Greg to play something."));
      } catch (err) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(page("Not connected", `Couldn't finish connecting:<br><b>${err.message}</b>`));
      }
    }

    if (url.pathname === "/api/spotify/status" && req.method === "GET") {
      return sendJson(res, 200, spotifyStatus());
    }

    // --- The browser telling us Greg has started or stopped talking ---
    //
    // Only used to duck the music. Deliberately fire-and-forget: if Spotify is
    // slow or unreachable, that must not delay him speaking.
    if (url.pathname === "/api/speaking" && req.method === "POST") {
      const { speaking } = await readBody(req);
      (speaking ? duck() : unduck()).catch(() => {});
      return sendJson(res, 200, { ok: true });
    }

    // --- Where Greg's own window is, so he knows if he's in shot ---
    if (url.pathname === "/api/window" && req.method === "POST") {
      return sendJson(res, 200, { ok: setWindowRect(await readBody(req)) });
    }

    // --- Start a fresh conversation ---
    if (url.pathname === "/api/reset" && req.method === "POST") {
      history.length = 0;
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname.startsWith("/api/")) return sendJson(res, 404, { error: "no such endpoint" });

    // The globe's library, textures and country outlines, straight out of
    // node_modules. Read-only, and only the handful of files named above.
    if (url.pathname.startsWith("/vendor/globe/")) {
      const name = path.basename(url.pathname);
      const wanted = url.pathname.includes("/img/")
        ? /^[\w-]+\.(jpg|png)$/.test(name) && path.join(GLOBE_IMG_DIR, name)
        : GLOBE_FILES[name];

      if (!wanted) return sendJson(res, 404, { error: "not found" });

      return fs.readFile(wanted, (err, data) => {
        if (err) return sendJson(res, 404, { error: "the globe isn't installed — run: npm install" });
        res.writeHead(200, {
          "Content-Type": MIME[path.extname(name).toLowerCase()] ?? "application/octet-stream",
          // These never change, and the blue marble is 1.4 MB.
          "Cache-Control": "public, max-age=86400",
        });
        res.end(data);
      });
    }

    return serveStatic(req, res, url.pathname);
  } catch (err) {
    console.error("[server]", err);
    return sendJson(res, 500, { error: err.message ?? "something went wrong" });
  }
});

// Derived from TRAITS rather than listed by hand: the banner was written when
// there were four dials, silently stopped mentioning formality when that was
// added, and would have missed edge too. A line that lists settings has to come
// from the same place the settings do.
function personalityLine(character) {
  return Object.entries(TRAITS)
    .map(([name, trait]) => `${trait.label.toLowerCase()} ${character[name]}`)
    .join(", ");
}

function openBrowser(url) {
  const chromePaths = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  const browser = chromePaths.find((p) => fs.existsSync(p));

  try {
    if (browser) {
      // App mode: no address bar, feels like a real desktop app.
      spawn(browser, [`--app=${url}`, "--window-size=560,780"], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    console.log(`Open ${url} in Chrome to talk to Greg.`);
  }
}

// Starting up must never fail silently.
//
// Everything below runs inside an async listen callback, and for a long time it
// had no error handling at all: any step that threw became an unhandled promise
// rejection, which Node turns into process death, with nothing said about WHICH
// step failed. The symptom is the worst one this project can produce — the
// console goes quiet, the banner never appears, and there is no way to tell
// "Ollama is missing" from "node_modules is half-installed".
//
// Reported by the first person other than the author to install Greg from
// scratch: the window came up, printed npm's chatter, and then simply stopped.
process.on("unhandledRejection", (err) => {
  console.error(`\nGreg fell over while starting: ${err?.stack ?? err}`);
  console.error("This is a bug. Nothing was damaged - your settings and memory are untouched.\n");
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  console.error(`\nGreg hit an unexpected error: ${err?.stack ?? err}\n`);
  process.exit(1);
});

// The one startup failure with an obvious cause and an obvious fix, which
// otherwise arrives as a raw stack trace nobody should have to read.
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\nPort ${PORT} is already in use - Greg is very likely already running.`);
    console.error("Close the other window, or run stop-greg.bat, then try again.");
    console.error(`If something else owns that port, change "port" in config.json.\n`);
  } else if (err.code === "EACCES") {
    console.error(`\nNot allowed to listen on port ${PORT}. Pick a port above 1024 in config.json.\n`);
  } else {
    console.error(`\nGreg could not open port ${PORT}: ${err.message}\n`);
  }
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", async () => {
  const url = `http://localhost:${PORT}`;

  // Said BEFORE the slow work, not after it — a warning that a wait is coming
  // is worth nothing once the wait is over. Everything below this line can sit
  // silently for minutes on a first run while speech models download, and a
  // console that looks idle reads as a program that has hung.
  const notice = firstRunNotice(config);
  if (notice) console.log(`\n${notice}\n`);

  const loc = await getLocation(config);
  const brain = await initBrain(config);

  // Optional: local speech recognition. Falls back to the browser if absent.
  const earsReady = await initStt(config);
  const ears = sttStatus();
  if (!earsReady && ears.reason) console.log(`[ears] using browser speech recognition (${ears.reason})`);

  // Optional: local speech synthesis. Falls back to Microsoft's voices if absent.
  const voiceReady = await initPiper(config);
  const mouth = piperStatus();
  if (!voiceReady && mouth.reason) console.log(`[voice] using the cloud voice (${mouth.reason})`);

  // Windows' own voice, underneath Piper and ABOVE the cloud. Probed at startup
  // rather than assumed: a stripped Windows image can genuinely have no voices,
  // and finding that out mid-sentence is too late to be useful.
  const system = await initSapi(config);
  console.log(
    system.state === "ready"
      ? `[voice] system voice ready as a local fallback (${system.reason})`
      : `[voice] no system voice — a local failure would fall to the cloud (${system.reason})`
  );

  // Optional: the cloned voice, preferred over Piper when it is running. Started
  // after Piper on purpose — if the clone fails to load there is already a
  // working voice underneath it rather than a gap.
  const cloneReady = await initClone(config);
  const cloned = cloneStatus();
  if (!cloneReady && cloned.reason) console.log(`[voice] cloned voice off — ${cloned.reason}`);

  // The speech cache only earns its keep against the cloned voice, which runs at
  // roughly realtime; Piper is fast enough that a cache would be noise.
  const cache = initCache(config);
  if (cache.enabled && cloneReady && config.speechCache?.warmOnStart !== false) {
    // Deliberately not awaited: the sidecar serializes synthesis, so warming in
    // front of Greg's first real answer would delay the very thing this speeds up.
    warmCache({
      phrases: config.speechCache?.phrases ?? DEFAULT_PHRASES,
      voiceId: `clone:${cloned.reference}:${cloned.exaggeration}:${cloned.cfgWeight}:${cloned.temperature}`,
      synthesize: (phrase) => synthesize(phrase),
      onDone: ({ made, total }) =>
        made && console.log(`[voice] warmed ${made} of ${total} common phrases into the speech cache`),
    });
  }

  // What was actually said, kept across restarts. Greg's other memory holds a few
  // curated facts; this holds the exchanges themselves.
  const log = initConversationLog(config);
  if (log.enabled && log.turns) console.log(`[log] ${log.turns} past exchanges in ${log.file}`);

  // Push every power change down the existing event stream, so a switch thrown by
  // voice moves the button and one thrown on the button is reflected everywhere.
  // Without this the two would silently disagree about whether the eyes are open.
  onPowerChange((state) => broadcast({ type: "power", state }));

  // Same again for the channel, so "put the album art up" said out loud moves the
  // knob on the cabinet, and the knob moves what the model thinks it is showing.
  onChannelChange((state) => broadcast({ type: "channel", state }));

  // A severe weather warning interrupts the programme. This is the one thing on
  // the set that changes channel without being asked, and the only reason that
  // is acceptable is that lib/alertwatch.js is strict about what qualifies —
  // Severe and above, Immediate or Expected, once per alert.
  //
  // The switch goes through setChannel() rather than being announced separately,
  // so the knob, the button and the model all learn about it through the same
  // broadcast everything else uses. Nothing here keeps a second copy of what is
  // showing.
  onAlert(({ alert, spoken }) => {
    // Drop the cached forecast first, or the channel he has just switched to
    // shows a card with no warning on it for up to four minutes — the one
    // moment the picture and the announcement must not disagree.
    clearProgrammes();
    setChannel("weather");
    // `tone` picks which earcon the page plays before he speaks. A warning gets
    // the two-tone attention signal that precedes exactly this announcement on a
    // real television; everything else gets the station ident. The distinction
    // is made HERE because the server is the only place that knows a message is
    // a severe weather warning — by the time it reaches the speech queue it is a
    // string like any other.
    broadcast({ type: "say", text: spoken, tone: "alert" });
    broadcast({ type: "alert", alert });
  });
  startAlertWatch(config);

  // --- Channels somebody dropped into channels/ ----------------------------
  //
  // The folder IS the registration, the way personas/ and voices/ already work.
  // Everything an add-on needs from the server happens here: it joins CHANNELS
  // so the knob and set_channel can reach it, and its feed joins the programme
  // registry so it inherits caching, stale-on-error and a stated poll interval.
  //
  // Problems are PRINTED. A folder somebody has just written which silently
  // does nothing is the most frustrating way for this to fail, and the console
  // banner is where this project already says what actually loaded.
  const addons = loadAddons();
  for (const problem of addons.problems) console.warn(`[channels] ${problem}`);
  if (addons.channels.length) {
    addChannels(addons.channels);
    for (const channel of addons.channels) {
      if (channel.fetch) {
        addProgramme(channel.id, {
          load: addonLoader(channel, { locate: (cfg) => getLocation(cfg) }),
          pollMs: channel.fetch.pollMs,
        });
      }
    }
    // The model is told about them here, after they exist. set_channel's
    // description is built at import time, so without this an add-on would
    // work from the knob and never be mentioned by Greg.
    refreshChannelTool();
    const names = addons.channels.map((c) => `${c.number} ${c.name}`).join(", ");
    console.log(`Channels: ${addons.channels.length} added — ${names}`);
  }

  // And the settings, so a personality dial moved by voice moves the slider in
  // the dialog, and a wake word changed in the dialog reaches the listener that
  // has to match it — without either side keeping its own copy.
  initSettings(config);
  onSettingsChange((state) => {
    broadcast({ type: "settings", state });
    // Moving the pin in the Location tab has to reach the channels too. Without
    // this the weather channel keeps showing the old town for four minutes and
    // Ceefax keeps its old local page — a setting that appears to do nothing
    // until later is the confusing kind of right.
    clearProgrammes();
  });

  // Optional: screen vision, but only if the model can prove it sees images.
  // A model that reports a vision capability and then describes a screen it
  // never received is worse than one with no eyes at all.
  const eyes = await initVision(config);
  if (!eyes.ok) console.log(`[eyes] screen vision off — ${eyes.reason}`);

  // Personality has to be initialised explicitly rather than lazily: the lazy
  // path has no config to read, so it would quietly ignore config.json and use
  // the built-in defaults instead.
  const character = initPersonality(config);
  const spotify = initSpotify(config);
  if (spotify.enabled && !spotify.configured) {
    console.log("[spotify] no SPOTIFY_CLIENT_ID — pause and skip still work, playing a named song doesn't");
  } else if (spotify.configured && !spotify.connected) {
    console.log(`[spotify] not connected yet — open ${url}/api/spotify/login once`);
  }

  // Timers announce themselves through the event stream above.
  const restored = initReminders((item) => {
    console.log(`[reminder] ${item.text}${item.late ? " (was due while Greg was off)" : ""}`);
    broadcast({ type: "reminder", text: item.text, kind: item.kind, late: Boolean(item.late) });
  });
  if (restored.restored || restored.missed) {
    console.log(`[reminder] ${restored.restored} still pending, ${restored.missed} came due while away`);
  }

  // Plain ASCII — the default Windows console mangles box-drawing characters.
  console.log(`
  ==================================================
    ${config.name ?? "Greg"} is awake.

    Face:     ${url}
    Location: ${loc.city}${loc.region ? `, ${loc.region}` : ""}
    Brain:    ${brain.label}
    Ears:     ${earsReady ? `${ears.model} on ${ears.device} (on this PC)` : "browser speech recognition (needs internet)"}
    Voice:    ${
      cloneReady
        ? `${cloned.reference}, cloned (on this PC)${cache.enabled ? `, ${cache.entries} cached` : ""}`
        : voiceReady
          ? `${mouth.voice} (on this PC)`
          : `${config.voice} (needs internet)`
    }
    Eyes:     ${eyes.ok ? "can read your screen" : "no screen vision"}
    Manner:   ${personalityLine(character)}

    Say "Hey ${config.name ?? "Greg"}" once the page has mic access.
    Ctrl+C here to shut him down.
  ==================================================
`);

  if (config.openBrowser !== false) openBrowser(url);
});

// Don't leave the Whisper, Piper or clone processes orphaned when Greg is shut
// down. The clone matters most of the three: it holds GPU memory that nothing
// else can reclaim while it is running.
function stopChildren() {
  stopStt();
  stopPiper();
  stopClone();
  stopCursorWatch();
  stopNowPlaying();
  // Not a child process, but it is an interval, and an interval that outlives
  // the server is the same class of leftover.
  stopAlertWatch();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopChildren();
    process.exit(0);
  });
}
process.on("exit", stopChildren);
