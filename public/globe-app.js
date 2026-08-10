// The Global Dashboard.
//
// A globe you can spin, search and click. Every country is outlined; on top of
// that sit the day/night line, recent earthquakes and — if you ask for them —
// live aircraft. Click anywhere and Greg looks up the weather, the local time
// and the headlines there, shows them in the panel, and reads them out in the
// *other* window. The globe deliberately has no voice: two windows talking at
// once would be a mess, and his face is the thing that should react.
//
// The globe itself is served from node_modules and works with the internet
// unplugged. Only the data layers need a connection, and each fails on its own
// without taking the others down.

const el = {
  globe: document.getElementById("globe"),
  loading: document.getElementById("globe-loading"),
  place: document.getElementById("place"),
  coords: document.getElementById("coords"),
  localtime: document.getElementById("localtime"),
  conditions: document.getElementById("conditions"),
  headlines: document.getElementById("headlines"),
  status: document.getElementById("status"),
  clock: document.getElementById("clock"),
  search: document.getElementById("search"),
  results: document.getElementById("results"),
  recent: document.getElementById("recent"),
  homeBtn: document.getElementById("home-btn"),
  spin: document.getElementById("spin"),
  terminator: document.getElementById("terminator"),
  quakes: document.getElementById("quakes"),
  flights: document.getElementById("flights"),
};

const setStatus = (text) => (el.status.textContent = text);

// ---------------------------------------------------------------------------
// The globe
// ---------------------------------------------------------------------------

const world = new Globe(el.globe)
  .globeImageUrl("/vendor/globe/img/earth-blue-marble.jpg")
  .bumpImageUrl("/vendor/globe/img/earth-topology.png")
  .backgroundImageUrl("/vendor/globe/img/night-sky.png")
  .showAtmosphere(true)
  .atmosphereColor("#6fb6ff")
  .atmosphereAltitude(0.16);

world.pointOfView({ altitude: 2.4 });
world.controls().autoRotate = true;
world.controls().autoRotateSpeed = 0.45;

el.spin.addEventListener("change", () => {
  world.controls().autoRotate = el.spin.checked;
});

function fit() {
  const rect = el.globe.getBoundingClientRect();
  if (rect.width && rect.height) world.width(rect.width).height(rect.height);
}
new ResizeObserver(fit).observe(el.globe);
fit();

// ---------------------------------------------------------------------------
// Countries
// ---------------------------------------------------------------------------

const nameOf = (feature) =>
  feature?.properties?.ADMIN ?? feature?.properties?.NAME ?? feature?.properties?.name ?? "Somewhere";

let hovered = null;

fetch("/vendor/globe/countries.geojson")
  .then((res) => {
    if (!res.ok) throw new Error(`countries returned ${res.status}`);
    return res.json();
  })
  .then((geo) => {
    // Antarctica is enormous, unclickable in any useful sense, and has no news.
    const countries = geo.features.filter((f) => f.properties.ISO_A2 !== "AQ");

    world
      .polygonsData(countries)
      .polygonAltitude((d) => (d === hovered ? 0.03 : 0.007))
      .polygonCapColor((d) => (d === hovered ? "rgba(120, 210, 255, 0.55)" : "rgba(90, 160, 220, 0.12)"))
      .polygonSideColor(() => "rgba(40, 90, 140, 0.5)")
      .polygonStrokeColor(() => "#7fd4f5")
      .polygonLabel((d) => `<div class="globe-tip">${nameOf(d)}</div>`)
      .onPolygonHover((polygon) => {
        hovered = polygon;
        el.globe.style.cursor = polygon ? "pointer" : "grab";
        world.polygonAltitude(world.polygonAltitude()).polygonCapColor(world.polygonCapColor());
      })
      // The click coordinates matter as much as the country: the weather in
      // western Russia has nothing to do with the weather in eastern Russia.
      .onPolygonClick((polygon, event, coords) => select(nameOf(polygon), coords.lat, coords.lng));

    el.loading.classList.add("gone");
    setStatus(`${countries.length} countries — click one`);
  })
  .catch((err) => {
    el.loading.textContent = `Couldn't load the countries: ${err.message}`;
    setStatus("failed to load country outlines");
  });

// ---------------------------------------------------------------------------
// Day / night
//
// No API for this — it's solar geometry. The subsolar point is wherever the sun
// is directly overhead; the terminator is every point exactly 90 degrees away
// from it, which traces a great circle across the planet.
// ---------------------------------------------------------------------------

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

function subsolarPoint(when = new Date()) {
  const days = when.getTime() / 86400000 + 2440587.5 - 2451545.0; // days since J2000
  const meanLong = (280.46 + 0.9856474 * days) % 360;
  const meanAnomaly = ((357.528 + 0.9856003 * days) % 360) * RAD;
  const ecliptic = (meanLong + 1.915 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly)) * RAD;
  const tilt = (23.439 - 0.0000004 * days) * RAD;

  const declination = Math.asin(Math.sin(tilt) * Math.sin(ecliptic)) * DEG;
  const rightAscension = Math.atan2(Math.cos(tilt) * Math.sin(ecliptic), Math.cos(ecliptic)) * DEG;
  const siderealHours = (18.697374558 + 24.06570982441908 * days) % 24;

  let longitude = -((siderealHours * 15 - rightAscension) % 360);
  longitude = ((longitude + 540) % 360) - 180;
  return { lat: declination, lng: longitude };
}

function terminatorRing(sun) {
  const lat0 = sun.lat * RAD;
  const lon0 = sun.lng * RAD;
  const quarter = Math.PI / 2; // 90 degrees from the sun is sunrise/sunset
  const points = [];

  for (let step = 0; step <= 180; step++) {
    const bearing = step * 2 * RAD;
    const lat = Math.asin(Math.sin(lat0) * Math.cos(quarter) + Math.cos(lat0) * Math.sin(quarter) * Math.cos(bearing));
    const lon =
      lon0 +
      Math.atan2(
        Math.sin(bearing) * Math.sin(quarter) * Math.cos(lat0),
        Math.cos(quarter) - Math.sin(lat0) * Math.sin(lat)
      );
    points.push([lat * DEG, ((lon * DEG + 540) % 360) - 180]);
  }
  return points;
}

function drawTerminator() {
  if (!el.terminator.checked) {
    world.pathsData([]).labelsData(labels.filter((l) => l.kind !== "sun"));
    return;
  }
  const sun = subsolarPoint();
  world.pathsData([terminatorRing(sun)]).pathColor(() => ["rgba(255,220,120,0.85)", "rgba(255,220,120,0.15)"]).pathStroke(1.4).pathPointAlt(0.012);

  labels = labels.filter((l) => l.kind !== "sun");
  labels.push({ kind: "sun", lat: sun.lat, lng: sun.lng, text: "☀", size: 0, dot: 1.6, color: "#ffd76a" });
  paintLabels();
}

el.terminator.addEventListener("change", drawTerminator);
setInterval(drawTerminator, 60000); // the sun moves a quarter degree a minute

// ---------------------------------------------------------------------------
// Markers: home and the sun share the labels layer
// ---------------------------------------------------------------------------

let labels = [];

function paintLabels() {
  world
    .labelsData(labels)
    .labelLat("lat")
    .labelLng("lng")
    .labelText("text")
    .labelSize("size")
    .labelDotRadius("dot")
    .labelColor("color")
    .labelResolution(2);
}

let home = null;

/**
 * The desktop behind this window.
 *
 * `--desktop` is declared in style.css with the Windows 98 teal as its default,
 * and the MAIN window overrides it at runtime from /api/config. This one never
 * did, so setting the colour left the two windows disagreeing — teal behind the
 * globe and orange behind Greg, which is what somebody actually noticed.
 *
 * The same arrangement everything else here uses: the server owns the value and
 * each window paints whatever it was last told. The hex is checked before it is
 * written, because this goes into a CSS custom property and lib/settings.js
 * validating on the way in is not a reason for the page to trust it on the way
 * out.
 */
function paintDesktop(colour) {
  if (/^#[0-9a-f]{6}$/i.test(String(colour ?? ""))) {
    document.documentElement.style.setProperty("--desktop", colour);
  }
}

fetch("/api/config")
  .then((res) => res.json())
  .then((config) => {
    // BEFORE the guard below, which returns when there is no pinned home. That
    // is the common case — the location follows the connection by default — so
    // painting after it would have made the background match only for people
    // who had pinned themselves to a city.
    paintDesktop(config.desktop);

    const { city, latitude, longitude } = config.location ?? {};
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
    home = { city: city || "Home", lat: latitude, lng: longitude };
    labels.push({ kind: "home", lat: latitude, lng: longitude, text: home.city, size: 0.55, dot: 0.45, color: "#8affc1" });
    paintLabels();
  })
  .catch(() => {
    /* a missing home marker is not worth mentioning */
  });

// And keep it in step. Without this the colour matches only until somebody
// changes it: the settings dialog lives in the other window, so this one would
// hold the old colour until it was reloaded — the same mismatch again, just
// later and harder to explain.
//
// Deliberately only listening for the one thing this window can act on. It is
// not a second consumer of the event stream in any meaningful sense: everything
// else on there belongs to the face.
try {
  const events = new EventSource("/api/events");
  events.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.type === "settings") paintDesktop(payload.state?.appearance?.background);
    } catch {
      /* not ours */
    }
  });
  events.addEventListener("error", () => {});
} catch {
  // A window that cannot hear about a colour change is still a working globe.
}

el.homeBtn.addEventListener("click", () => {
  if (!home) return setStatus("I don't know where home is");
  select(home.city, home.lat, home.lng);
});

// ---------------------------------------------------------------------------
// Earthquakes
// ---------------------------------------------------------------------------

// Shallow quakes do the damage, so depth drives the colour rather than the size.
const depthColor = (km) => (km < 30 ? "#ff4d4d" : km < 100 ? "#ffa64d" : km < 300 ? "#ffe14d" : "#7fd4f5");

async function loadQuakes() {
  if (!el.quakes.checked) {
    world.pointsData([]);
    return;
  }
  try {
    const res = await fetch("/api/quakes");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `quakes returned ${res.status}`);

    world
      .pointsData(data.quakes)
      .pointLat("lat")
      .pointLng("lon")
      .pointColor((q) => depthColor(q.depth))
      // Magnitude is logarithmic, so squaring it separates a 6 from a 3 the way
      // the energy release actually does.
      .pointAltitude((q) => Math.max(0.01, ((q.magnitude ?? 1) ** 2) / 260))
      .pointRadius((q) => Math.max(0.12, (q.magnitude ?? 1) * 0.09))
      .pointLabel(
        (q) =>
          `<div class="globe-tip"><b>M${(q.magnitude ?? 0).toFixed(1)}</b> ${q.place}<br>${q.depth} km deep</div>`
      )
      .onPointClick((q) => select(q.place.replace(/^\d+\s*km\s+\w+\s+of\s+/i, ""), q.lat, q.lon));

    setStatus(`${data.quakes.length} quakes — ${data.description}`);
  } catch (err) {
    setStatus(`Earthquakes unavailable: ${err.message}`);
  }
}

el.quakes.addEventListener("change", loadQuakes);

// ---------------------------------------------------------------------------
// Live flights
//
// OpenSky's anonymous quota is small, so this only runs while the box is ticked,
// only asks about where the camera is pointing, and waits a long time between
// asks. Running out dims the layer rather than breaking anything.
// ---------------------------------------------------------------------------

const FLIGHT_POLL = 45000;
let flightTimer = null;

// Where we last deliberately looked. Asking the camera instead is a race: the
// fly-to is a 900ms animation, so `pointOfView()` right after a click still
// reports the *previous* place — which had the aircraft over London coming back
// for Iceland. Dragging the globe by hand clears this and hands control back to
// the camera, which is then the honest answer.
let focus = null;

world.controls().addEventListener("start", () => {
  focus = null;
});

async function loadFlights() {
  if (!el.flights.checked) {
    world.htmlElementsData([]);
    return;
  }

  const view = world.pointOfView();
  const lat = focus?.lat ?? view.lat;
  const lon = focus?.lon ?? view.lng;

  try {
    const res = await fetch(`/api/flights?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}&span=8`);
    const data = await res.json();

    if (data.error) {
      setStatus(`Flights: ${data.error}`);
      world.htmlElementsData([]);
      return;
    }

    // 300 DOM markers is a lot of layout; the highest are the interesting ones.
    const shown = (data.aircraft ?? []).slice(0, 140);

    world
      .htmlElementsData(shown)
      .htmlLat("lat")
      .htmlLng("lon")
      .htmlAltitude((d) => Math.min(0.22, (d.altitude ?? 0) / 60000))
      .htmlElement((d) => {
        const marker = document.createElement("div");
        marker.className = "plane";
        marker.textContent = "➤";
        marker.style.transform = `rotate(${(d.heading ?? 0) - 90}deg)`;
        marker.title = `${d.callsign} — ${Math.round((d.altitude ?? 0) * 3.28084)} ft, ${d.speed} mph`;
        return marker;
      });

    setStatus(`${shown.length} aircraft in view${data.cached ? " (cached)" : ""}`);
  } catch (err) {
    setStatus(`Flights unavailable: ${err.message}`);
  }
}

el.flights.addEventListener("change", () => {
  clearInterval(flightTimer);
  if (el.flights.checked) {
    loadFlights();
    flightTimer = setInterval(loadFlights, FLIGHT_POLL);
  } else {
    world.htmlElementsData([]);
    setStatus("Flights off");
  }
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

let searchTimer = null;

el.search.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const term = el.search.value.trim();
  if (term.length < 2) {
    el.results.hidden = true;
    return;
  }
  // Typing shouldn't fire a request per keystroke.
  searchTimer = setTimeout(() => runSearch(term), 300);
});

el.search.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    const first = el.results.querySelector("li");
    if (first) first.click();
  } else if (event.key === "Escape") {
    el.results.hidden = true;
  }
});

async function runSearch(term) {
  try {
    const res = await fetch(`/api/geocode?q=${encodeURIComponent(term)}`);
    const { results } = await res.json();

    if (!results?.length) {
      el.results.replaceChildren(Object.assign(document.createElement("li"), { textContent: "Nothing found" }));
      el.results.hidden = false;
      return;
    }

    el.results.replaceChildren(
      ...results.map((r) => {
        const item = document.createElement("li");
        item.textContent = r.name;
        const where = document.createElement("span");
        where.className = "where";
        where.textContent = ` — ${[r.region, r.country].filter(Boolean).join(", ")}`;
        item.append(where);
        item.addEventListener("click", () => {
          el.results.hidden = true;
          el.search.value = "";
          select(r.name, r.latitude, r.longitude);
        });
        return item;
      })
    );
    el.results.hidden = false;
  } catch (err) {
    setStatus(`Search failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Recently visited
// ---------------------------------------------------------------------------

const recent = [];

function paintRecent() {
  if (!recent.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "Nowhere yet";
    el.recent.replaceChildren(empty);
    return;
  }
  el.recent.replaceChildren(
    ...recent.map((spot) => {
      const item = document.createElement("li");
      item.textContent = spot.name;
      item.title = `${spot.lat.toFixed(2)}, ${spot.lon.toFixed(2)}`;
      item.addEventListener("click", () => select(spot.name, spot.lat, spot.lon));
      return item;
    })
  );
}
paintRecent();

function remember(name, lat, lon) {
  const existing = recent.findIndex((s) => s.name === name);
  if (existing !== -1) recent.splice(existing, 1);
  recent.unshift({ name, lat, lon });
  recent.length = Math.min(recent.length, 8);
  paintRecent();
}

// ---------------------------------------------------------------------------
// Asking Greg about a place
// ---------------------------------------------------------------------------

let inFlight = null;

async function select(name, lat, lon) {
  el.place.textContent = name;
  el.coords.textContent = `${lat.toFixed(2)}°, ${lon.toFixed(2)}°`;
  el.localtime.textContent = "";
  el.conditions.textContent = "…";
  el.headlines.replaceChildren();
  setStatus(`Looking up ${name}…`);
  remember(name, lat, lon);
  focus = { lat, lon };

  // Fly to it, and stop spinning so it doesn't drift away while you read.
  world.pointOfView({ lat, lng: lon, altitude: 1.6 }, 900);
  world.controls().autoRotate = false;
  el.spin.checked = false;

  // Somewhere new means the flights in view are the wrong ones.
  if (el.flights.checked) setTimeout(loadFlights, 1100);

  // Clicking a second place mid-lookup abandons the first.
  inFlight?.abort();
  const controller = new AbortController();
  inFlight = controller;

  try {
    const res = await fetch("/api/place", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat, lon, name }),
      signal: controller.signal,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `server error ${res.status}`);

    show(data);
    setStatus(`${data.place} — Greg is reading it out`);
  } catch (err) {
    if (err.name === "AbortError") return;
    el.conditions.textContent = "—";
    setStatus(`Couldn't reach Greg: ${err.message}`);
  } finally {
    if (inFlight === controller) inFlight = null;
  }
}

function show(data) {
  const now = data.weather?.now;
  const today = data.weather?.forecast?.[0];

  el.localtime.textContent = data.localTime ? `Local time ${data.localTime}` : "";

  el.conditions.textContent = now
    ? `${now.temperature}, ${now.conditions}. Feels like ${now.feelsLike}. ` +
      `Wind ${now.wind}, humidity ${now.humidity}.` +
      (today ? ` Today ${today.high} / ${today.low}.` : "")
    : "No weather came back for there.";

  if (!data.news?.length) {
    const empty = document.createElement("li");
    empty.textContent = "No headlines came back.";
    el.headlines.replaceChildren(empty);
    return;
  }

  el.headlines.replaceChildren(
    ...data.news.map((story) => {
      const item = document.createElement("li");
      item.textContent = story.headline;
      const source = document.createElement("span");
      source.className = "source";
      source.textContent = ` — ${story.source}`;
      item.append(source);
      return item;
    })
  );
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function tick() {
  el.clock.textContent = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
tick();
setInterval(tick, 10000);

drawTerminator();
loadQuakes();
// Refresh the quake feed occasionally; the USGS file only regenerates each minute.
setInterval(loadQuakes, 5 * 60 * 1000);
