// Local model provider — talks to Ollama running on this machine.
// No API key, no account, works offline.
//
// Uses Ollama's native /api/chat rather than its OpenAI-compatible endpoint,
// because only the native one separates a model's private reasoning from the
// text meant for the user. That matters a lot here: anything in `content`
// gets spoken out loud.

const DEFAULT_URL = "http://localhost:11434";

/**
 * The options block every chat request sends, warm-up included.
 *
 * One function because Ollama keys a loaded model on its context size: a
 * warm-up at the default num_ctx followed by a real turn at 32768 unloads and
 * reloads, costing the entire benefit while /api/ps reports the model resident
 * throughout. Measured 10,854 ms mismatched against 1,449 ms matched. Two
 * copies of this object is one copy too many.
 */
function chatOptions(config) {
  return {
    temperature: config.ollama?.temperature ?? 0.7,
    num_ctx: config.ollama?.contextTokens ?? 8192,
  };
}

/**
 * "auto" means ON, and the mapping has to reach Ollama as a boolean.
 *
 * Passing the string "auto" straight through is not an error Ollama reports —
 * it silently stops calling tools, which cost the eighth session a routing
 * measurement that scored 0/7 on prompts known to work.
 */
function thinkSetting(config) {
  const setting = config.ollama?.think ?? "auto";
  return setting === "auto" ? true : setting === "off" ? false : setting;
}

export function createOllamaProvider(config) {
  const base = (config.ollama?.url ?? DEFAULT_URL).replace(/\/+$/, "");
  const model = config.ollama?.model ?? "qwen3:4b";
  // Vision may run on a different model from the conversation — the brain and
  // the eyes have different requirements, and the best local vision models are
  // not the best chat models.
  const visionModel = config.vision?.model || model;
  const capabilities = new Map();

  async function getCapabilities(forModel = model) {
    if (capabilities.has(forModel)) return capabilities.get(forModel);
    const res = await fetch(`${base}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: forModel }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      throw new Error(
        res.status === 404
          ? `the model "${forModel}" isn't downloaded — run: ollama pull ${forModel}`
          : `Ollama returned ${res.status}`
      );
    }
    const caps = new Set((await res.json()).capabilities ?? []);
    capabilities.set(forModel, caps);
    return caps;
  }

  return {
    name: "ollama",
    // "(on this PC)" rather than "(local)" or "(offline)", so all three lines of
    // the banner say the same thing the same way. "offline" was actively
    // alarming: the face says "Offline — Greg has been shut down" when the
    // server dies, so the word means "working, privately" in one place and
    // "dead" in the other, and a user reading "Ears: ... (offline)" while
    // debugging a microphone reasonably reads it as the fault.
    label: `${model} (on this PC)`,

    async ready() {
      try {
        await getCapabilities();
        return true;
      } catch (err) {
        console.warn(`[brain] local model unavailable: ${err.message}`);
        return false;
      }
    },

    /**
     * Can this model call a tool at all?
     *
     * Ollama declares it, and `runChat` below already checks — but silently: a
     * model without the capability simply has `tools` omitted from its request,
     * and nothing anywhere says so. Point `ollama.model` at a completion-only
     * model and Greg starts up looking perfectly healthy, offers 28 tools he can
     * never call, and answers everything from imagination. Measured on
     * `gemma3:1b`, whose capabilities are `completion` and nothing else: 0 tool
     * calls in six turns, a wrong time, a wrong day, and "seventy-three degrees
     * with a chance of rain" against a real 89°F and clear.
     *
     * Same shape as the vision swatch test, which is this project's best idea:
     * establish what the model can actually do, then withhold what it cannot.
     *
     * Assumes YES when Ollama cannot be reached, because that is a different
     * failure and `ready()` is the thing that reports it. Stripping tools from a
     * model that has them, over a network blip, would be the worse mistake.
     */
    async supportsTools() {
      try {
        return (await getCapabilities()).has("tools");
      } catch {
        return true;
      }
    },

    async complete(request) {
      return runChat(request, null);
    },

    /**
     * Load the model into VRAM without asking it anything.
     *
     * The first question of a session cost **11.7 s measured**, against ~1.5 s
     * warm — nine of those seconds are gemma4:e4b being read off the disk. It
     * lands on the most predictable occasion there is: the boot sequence and
     * the greeting take about seven seconds and neither touches the model, so
     * the user watches a television warm up and is then made to wait again.
     *
     * **The options MUST match the ones a real turn sends, and that is the whole
     * subtlety here.** Ollama keys a loaded model on its context size, so
     * warming with the default `num_ctx` and then asking a real question at
     * 32768 silently unloads and reloads — measured **10,854 ms**, with the
     * model showing as resident in /api/ps the entire time. The instrument says
     * loaded while nothing has been gained. Warming with matching options:
     * **1,449 ms.** They come from one function now so they cannot drift.
     */
    async warm() {
      const caps = await getCapabilities();
      const body = {
        model,
        messages: [],
        options: chatOptions(config),
        keep_alive: config.ollama?.keepAlive ?? "5m",
      };
      // Thinking is part of how the model is loaded too, so it is set the same
      // way a real turn sets it rather than left off.
      if (caps.has("thinking")) body.think = thinkSetting(config);

      const res = await fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.ollama?.warmTimeoutMs ?? 120000),
      });
      if (!res.ok) throw new Error(`Ollama returned ${res.status}`);
      // done_reason is "load" when it did the thing we asked for.
      return (await res.json())?.done_reason ?? "unknown";
    },

    // Same request, but content is handed over as it arrives so Greg can start
    // speaking the first sentence before the last one exists.
    async completeStream(request, onContent) {
      return runChat(request, onContent);
    },

    /**
     * Ask the model what it can see in an image.
     *
     * Deliberately a separate, tool-free call rather than an image attached to
     * the conversation: it keeps the tool-calling loop's message format
     * untouched, and the description comes back as ordinary text that survives
     * the history stripping in brain.js like any other tool result.
     */
    async describeImage({ prompt, imageBase64 }) {
      const caps = await getCapabilities(visionModel);
      if (!caps.has("vision")) {
        throw new Error(`"${visionModel}" reports no vision capability — set vision.model in config.json to one that has it`);
      }

      const body = {
        model: visionModel,
        messages: [{ role: "user", content: prompt, images: [imageBase64] }],
        stream: false,
        options: {
          // Low temperature: this is a description of what is actually there,
          // and invention is the whole failure mode.
          temperature: 0.2,
          num_ctx: config.ollama?.contextTokens ?? 8192,
        },
      };

      // No tools in this call, so the reason `think` has to stay on elsewhere
      // doesn't apply — and looking at a screen is slow enough already.
      if (caps.has("thinking")) body.think = config.vision?.think ?? false;

      // How long the vision model stays resident after answering. Left unset it
      // follows Ollama's own default (5 minutes), which means an occasional
      // ~12-second wait while it reloads versus ~4 seconds warm. Set "30m" or
      // "-1" to keep it loaded, at the cost of holding its VRAM the whole time.
      if (config.vision?.keepAlive) body.keep_alive = config.vision.keepAlive;

      const res = await fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.vision?.timeoutMs ?? 120000),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Ollama returned ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
      }

      return stripReasoning((await res.json()).message?.content ?? "");
    },
  };

  async function runChat({ system, messages, tools }, onContent) {
      const caps = await getCapabilities();

      const body = {
        model,
        messages: [{ role: "system", content: system }, ...messages.map(toOllamaMessage)],
        stream: Boolean(onContent),
        // Shared with warm(), which is not tidiness: Ollama keys a loaded model
        // on its context size, so a warm-up that sends different options
        // reloads the model on the first real question and buys nothing at all.
        options: chatOptions(config),
      };

      if (caps.has("tools") && tools?.length) {
        body.tools = tools.map((tool) => ({
          type: "function",
          function: { name: tool.name, description: tool.description, parameters: tool.parameters },
        }));
      }

      // How long the CHAT model stays resident after answering.
      //
      // The vision model has had this from the start and the brain never did, so
      // it followed Ollama's default of five minutes — and gemma4:e4b is 9.6 GB
      // on disk. Measured on this machine: **1.7 s to the first sentence warm,
      // 10.6 s cold.** Nine of those seconds are the model being read off the
      // disk again because nobody spoke to him for five minutes, which is most
      // of what "Greg is a bit slow" turns out to mean — and it is intermittent,
      // so it reads as a mystery rather than as a cold start.
      //
      // It costs 3.3 GB of VRAM held between conversations, which is the
      // smallest of the four things competing for the card, and gaming mode
      // already keeps the brain loaded on purpose for the same reason: it is
      // cheap, and it is the one that has to be there to hear you.
      if (config.ollama?.keepAlive) body.keep_alive = config.ollama.keepAlive;

      // Counter-intuitive but important: for some models, leaving thinking ON is
      // what keeps their scratchpad in a separate `thinking` field. Switching it
      // off makes them dump that reasoning straight into `content` — which then
      // gets read aloud. So "auto" means on, and we discard the reasoning.
      //
      // Models that stay clean with it off (gemma4, for one) are far faster that
      // way, hence the config override. Measured on an RTX 4090:
      //   qwen3:4b    think on  -> 2.0s, clean   | think off -> 2.8s, LEAKS
      //   gemma4:e4b  think on  -> 4.1s, clean   | think off -> 0.45s, clean
      if (caps.has("thinking")) body.think = thinkSetting(config);

      const res = await fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.ollama?.timeoutMs ?? 120000),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Ollama returned ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
      }

      const message = onContent ? await readStream(res, onContent) : (await res.json()).message ?? {};

      const toolCalls = (message.tool_calls ?? []).map((call, index) => ({
        id: call.id ?? `call_${Date.now()}_${index}`,
        name: call.function?.name,
        args: parseArgs(call.function?.arguments),
      }));

      return { text: stripReasoning(message.content ?? ""), toolCalls };
  }
}

/**
 * Collapse Ollama's newline-delimited JSON stream back into one message,
 * reporting content as it arrives.
 *
 * Measured with gemma4:e4b: a turn that calls a tool emits no content at all
 * (~80 chunks of private reasoning, then tool_calls), and a plain turn produces
 * its first content only in the last ~10% of the turn. So streaming the model
 * buys little on its own — the win is that it lets synthesis start early. See
 * CLAUDE.md.
 */
async function readStream(res, onContent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const message = { role: "assistant", content: "", tool_calls: [] };
  let buffer = "";
  // How much of the *cleaned* text has already been handed over. Raw deltas are
  // never emitted directly: a model that spills "<think>" into content would
  // otherwise have its reasoning spoken aloud before anyone could strip it.
  let emitted = 0;

  const handleLine = (line) => {
    if (!line.trim()) return;
    let chunk;
    try {
      chunk = JSON.parse(line);
    } catch {
      return; // a partial line; the next read completes it
    }
    if (chunk.error) throw new Error(chunk.error);

    const piece = chunk.message?.content ?? "";
    if (piece) {
      message.content += piece;
      const visible = visibleSoFar(message.content);
      if (visible.length > emitted) {
        onContent(visible.slice(emitted));
        emitted = visible.length;
      }
    }
    if (chunk.message?.tool_calls?.length) message.tool_calls.push(...chunk.message.tool_calls);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) handleLine(line);
  }
  handleLine(buffer);

  return message;
}

function parseArgs(args) {
  if (!args) return {};
  if (typeof args === "object") return args;
  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
}

// Safety net: some models emit raw reasoning tags inside content regardless.
// Never let that reach the speaker.
function stripReasoning(text) {
  return text
    .replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/?(think|thinking|reasoning)>/gi, "")
    .trim();
}

// The same job mid-stream, where the closing tag may not have arrived yet.
// An opening tag with no partner means everything after it is reasoning that
// hasn't finished, so cut there and wait rather than guessing.
function visibleSoFar(text) {
  const closed = text.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, "");
  const open = closed.search(/<(think|thinking|reasoning)>/i);
  const safe = open === -1 ? closed : closed.slice(0, open);
  // A half-typed "<thin" could still become a tag; hold back a trailing partial.
  return safe.replace(/<[a-z/]*$/i, "").trim();
}

function toOllamaMessage(message) {
  if (message.role === "tool") {
    return { role: "tool", tool_name: message.name, content: message.content };
  }

  if (message.role === "assistant") {
    const out = { role: "assistant", content: message.content ?? "" };
    if (message.toolCalls?.length) {
      out.tool_calls = message.toolCalls.map((call) => ({
        function: { name: call.name, arguments: call.args },
      }));
    }
    return out;
  }

  return { role: message.role, content: message.content };
}
