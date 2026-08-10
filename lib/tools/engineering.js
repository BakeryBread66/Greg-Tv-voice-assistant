// Engineering tool: schema and handler together.
//
// The counterpart to channel 11, and it exists for exactly the reason
// whats_playing exists beside channel 2 and get_market beside channel 8.
// Channel aliases are matched as substrings, so without this the words in "how
// hot is my GPU" would resolve to a channel and Greg would SWITCH instead of
// answering. That has now happened twice in this project's history and both
// times the fix was the same: asking is not switching, so the question gets its
// own tool and the channel keeps the aliases that mean "show me".
//
// It reads and reports. It changes nothing, so it is deliberately NOT in the
// honesty sentence in the system prompt — that list is for tools that write
// state, and padding it with read-only tools would blunt it.

import { getEngineering } from "../engineering.js";

export const engineering = [
  {
    name: "get_engineering",
    description:
      "Read this machine's hardware: GPU load, temperature and VRAM, CPU load, memory, and which AI models are loaded. Use for 'how hot is the GPU', 'how much VRAM is free', 'what's loaded'.",
    parameters: { type: "object", properties: {}, required: [] },
    async run(input, ctx) {
      try {
        const data = await getEngineering(ctx.config);

        const gpu = data.gpu
          ? {
              name: data.gpu.name,
              loadPercent: data.gpu.utilPct,
              temperatureC: data.gpu.tempC,
              vramUsedGB: Number((data.gpu.vramUsedMiB / 1024).toFixed(1)),
              vramTotalGB: Number((data.gpu.vramTotalMiB / 1024).toFixed(1)),
              vramFreeGB: Number(((data.gpu.vramTotalMiB - data.gpu.vramUsedMiB) / 1024).toFixed(1)),
              powerWatts: data.gpu.powerW,
            }
          : null;

        return {
          gpu,
          // Absent is a fact and gets said plainly, so an empty gpu field cannot
          // be read as "idle" or filled in from imagination.
          gpuNote: data.gpu ? undefined : data.gpuNote ?? "No GPU reading available on this machine.",
          cpu: { model: data.cpu.model, threads: data.cpu.threads, loadPercent: round(data.cpu.busyPct) },
          memory: {
            usedGB: Number(data.memory.usedGB.toFixed(1)),
            totalGB: Number(data.memory.totalGB.toFixed(0)),
          },
          // Three states, kept apart on purpose: a list, an empty list, and
          // "could not ask". A model handed an empty list fills the silence,
          // which is how "no weather warnings" got said without checking.
          modelsLoaded: data.models ?? undefined,
          modelsNote:
            data.models === null
              ? `${data.modelsNote ?? "Could not reach Ollama"} — say you could not check rather than saying nothing is loaded.`
              : data.models.length
                ? undefined
                : "Nothing is loaded on the GPU right now.",
        };
      } catch (err) {
        return { error: `Couldn't read the machine's hardware: ${err.message}` };
      }
    },
  },
];

const round = (n) => (n === null || n === undefined ? null : Number(n.toFixed(0)));
