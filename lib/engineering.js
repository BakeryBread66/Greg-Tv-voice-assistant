// What the machine is actually doing.
//
// Thematically the most obvious channel this set could carry — an engineering
// readout on a CRT — and practically the one that answers the question this
// project asks most often. VRAM is the binding resource here: the brain, the
// eyes, the ears and the cloned voice all want the same card, gaming mode exists
// solely to hand 11 GB of it back, and until now the only way to see any of that
// was to run nvidia-smi in a terminal.
//
// Everything is local. No key, no network, no account, and nothing that leaves
// the machine.
//
// **No sidecar, deliberately.** nvidia-smi answers in ~150 ms, so it is spawned
// per poll rather than kept alive. A long-running helper would have to be added
// to stop-greg.bat's sweep BY NAME — the list is explicit, not a wildcard — and
// a sidecar that outlives a shutdown holding GPU memory is the exact failure
// that file warns about three times. Nothing to leak is better than remembering
// to clean it up.

import { execFile } from "node:child_process";
import os from "node:os";

const SMI_TIMEOUT_MS = 4000;

// One nvidia-smi query, in the order the fields are parsed below.
const GPU_FIELDS = [
  "name",
  "utilization.gpu",
  "memory.used",
  "memory.total",
  "temperature.gpu",
  "power.draw",
  "power.limit",
  "fan.speed",
  "clocks.sm",
];

/** Run nvidia-smi and hand back its one CSV row, or null. */
function queryGpu() {
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(
        "nvidia-smi",
        [`--query-gpu=${GPU_FIELDS.join(",")}`, "--format=csv,noheader,nounits"],
        { timeout: SMI_TIMEOUT_MS, windowsHide: true },
        (err, stdout) => {
          if (err) return resolve({ error: err.code === "ENOENT" ? "absent" : err.message });
          resolve({ row: String(stdout).trim().split("\n")[0] });
        },
      );
    } catch (err) {
      return resolve({ error: err.message });
    }
    child.on("error", () => resolve({ error: "absent" }));
  });
}

/**
 * A number nvidia-smi might not have.
 *
 * It answers "[N/A]" for anything the driver does not expose — fan speed on a
 * card with no controllable fan, power on a laptop chip — and parseFloat("[N/A]")
 * is NaN, which would render as a bar of NaN%. Null means "this card does not
 * report it", which is a different fact from zero and must stay different.
 */
function num(raw) {
  const value = Number.parseFloat(String(raw ?? "").trim());
  return Number.isFinite(value) ? value : null;
}

/**
 * CPU busy percentage, averaged over the gap since the last call.
 *
 * os.loadavg() is meaningless on Windows — it returns zeros — so this is the
 * only honest route. The first call has nothing to compare against and takes a
 * short sample inline rather than reporting 0%: an unknown is not an idle
 * machine, and this project has been bitten before by an empty answer that
 * looked like a real one.
 */
let lastCpu = null;

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const [kind, ms] of Object.entries(cpu.times)) {
      total += ms;
      if (kind === "idle") idle += ms;
    }
  }
  return { idle, total };
}

async function cpuBusy() {
  if (!lastCpu) {
    lastCpu = cpuTimes();
    await new Promise((r) => setTimeout(r, 150));
  }
  const now = cpuTimes();
  const idle = now.idle - lastCpu.idle;
  const total = now.total - lastCpu.total;
  lastCpu = now;
  if (total <= 0) return null;
  return Math.max(0, Math.min(100, 100 * (1 - idle / total)));
}

/**
 * Which models Ollama currently has resident, and what they cost.
 *
 * The obvious source is `nvidia-smi --query-compute-apps`, and on Windows it is
 * useless: **per-process used_memory comes back "[N/A]"** under WDDM, for every
 * process, so the list is thirty entries of Explorer and Edge with no figures.
 * Measured before building anything on it. Ollama's own /api/ps knows exactly
 * what it has loaded and how much VRAM each model is holding, which is the
 * question worth answering anyway.
 */
async function residentModels(config) {
  const base = config?.ollama?.url ?? "http://localhost:11434";
  try {
    const res = await fetch(`${base}/api/ps`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { models: null, reason: `Ollama answered ${res.status}` };
    const body = await res.json();
    return {
      models: (body.models ?? []).map((m) => ({
        name: m.name ?? m.model ?? "unknown",
        vramMiB: Math.round((m.size_vram ?? 0) / 1048576),
        // Ollama unloads on a keep-alive timer, so how long it has left is a
        // real part of "what is on the card right now".
        expiresAt: m.expires_at ?? null,
      })),
      reason: null,
    };
  } catch (err) {
    // Null is "could not ask", which the renderer must not draw as "nothing
    // loaded" — the two look identical on screen and mean opposite things.
    return { models: null, reason: err.name === "TimeoutError" ? "Ollama did not answer" : "Ollama unreachable" };
  }
}

/**
 * The whole readout.
 *
 * Never throws: this feeds a channel, and a fault card that says why is worth
 * more than a blank screen.
 */
export async function getEngineering(config = {}) {
  const [gpuResult, busy, resident] = await Promise.all([queryGpu(), cpuBusy(), residentModels(config)]);

  let gpu = null;
  let gpuNote = null;

  if (gpuResult.error) {
    // No NVIDIA card is a FACT, not a failure — the same call as radar having no
    // station or NWS not covering Iceland. It must not render as a fault.
    gpuNote = gpuResult.error === "absent" ? "No NVIDIA GPU on this machine" : `nvidia-smi failed: ${gpuResult.error}`;
  } else {
    const parts = String(gpuResult.row).split(",").map((s) => s.trim());
    const [name, util, used, total, temp, power, powerLimit, fan, clock] = parts;
    if (!name) gpuNote = "nvidia-smi returned nothing";
    else {
      gpu = {
        name: name.replace(/^NVIDIA\s+/, ""),
        utilPct: num(util),
        vramUsedMiB: num(used),
        vramTotalMiB: num(total),
        tempC: num(temp),
        powerW: num(power),
        powerLimitW: num(powerLimit),
        fanPct: num(fan),
        clockMHz: num(clock),
      };
    }
  }

  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();

  return {
    gpu,
    gpuNote,
    cpu: {
      // Trimmed: "AMD Ryzen 9 7950X3D 16-Core Processor" does not fit a 312px
      // picture and the marketing suffix is the part nobody needs.
      model: (os.cpus()[0]?.model ?? "unknown").replace(/\s*\d+-Core Processor\s*$/i, "").trim(),
      threads: os.cpus().length,
      busyPct: busy,
    },
    memory: {
      usedGB: (totalBytes - freeBytes) / 1073741824,
      totalGB: totalBytes / 1073741824,
    },
    models: resident.models,
    modelsNote: resident.reason,
    uptimeHours: os.uptime() / 3600,
  };
}
