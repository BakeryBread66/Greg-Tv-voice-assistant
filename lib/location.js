// Figures out where "here" is, so weather and news are actually local.
// Tries a few free IP-geolocation services in order; the config file can override.

const PROVIDERS = [
  {
    name: "ipwho.is",
    url: "https://ipwho.is/",
    pick: (d) => ({ city: d.city, region: d.region, latitude: d.latitude, longitude: d.longitude }),
  },
  {
    name: "ip-api",
    url: "http://ip-api.com/json/",
    pick: (d) => ({ city: d.city, region: d.regionName, latitude: d.lat, longitude: d.lon }),
  },
  {
    name: "freeipapi",
    url: "https://freeipapi.com/api/json",
    pick: (d) => ({ city: d.cityName, region: d.regionName, latitude: d.latitude, longitude: d.longitude }),
  },
];

// Last-resort so Greg is never completely lost.
const FALLBACK = { city: "New York", region: "New York", latitude: 40.7128, longitude: -74.006, source: "fallback" };

let cached = null;

export async function getLocation(config) {
  if (cached) return cached;

  const override = config.location || {};
  if (!override.auto && override.latitude != null && override.longitude != null) {
    cached = {
      city: override.city || "your area",
      region: override.region || "",
      latitude: override.latitude,
      longitude: override.longitude,
      source: "config",
    };
    return cached;
  }

  for (const provider of PROVIDERS) {
    try {
      const res = await fetch(provider.url, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(6000),
      });
      const text = await res.text();
      if (!text.trim().startsWith("{")) continue; // some providers serve an HTML block page

      const loc = provider.pick(JSON.parse(text));
      if (typeof loc.latitude !== "number" || typeof loc.longitude !== "number") continue;

      cached = { ...loc, source: provider.name };
      console.log(`[location] ${loc.city}, ${loc.region} (via ${provider.name})`);
      return cached;
    } catch {
      // try the next provider
    }
  }

  console.warn("[location] all providers failed, falling back to New York — set it manually in config.json");
  cached = FALLBACK;
  return cached;
}

export function clearLocationCache() {
  cached = null;
}
