// Choosing Claude as his brain from Settings, rather than by editing two files
// and restarting him.
//
// The rule this project keeps: Greg's brain leaves this PC only when the user
// asks for it by name. "auto" never picks Claude (see initBrain). This is that
// asking, made a button: nothing here switches without an explicit "use", and
// nothing switches to Claude without first proving the key works — a wrong key
// would otherwise leave him answering every question with an error.
//
// The key lives in .env, never in config.json, and never leaves this module on
// its way anywhere but Anthropic: brainState() reports only that one is saved
// and its last four characters. Nothing here logs it.
//
// Everything that touches the network, the disk or the brain is passed in, so
// the decisions are tested without any of them.

import Anthropic from "@anthropic-ai/sdk";

import { initBrain, describeBrain, warmBrain } from "./brain.js";
import { setEnvValue, removeEnvValue, ENV_FILE } from "./envfile.js";
import { saveConfig } from "./settings.js";

const KEY_NAME = "ANTHROPIC_API_KEY";

/** The models offered. Opus 5 first: it is what config.json has always named. */
export const CLAUDE_MODELS = [
  { id: "claude-opus-5", label: "Claude Opus 5 — the most capable" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5 — quicker, and under half the price" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 — the fastest and cheapest" },
];
export const DEFAULT_MODEL = CLAUDE_MODELS[0].id;

const knownModel = (id) => CLAUDE_MODELS.some((m) => m.id === id);

/** Does this look like an Anthropic API key at all? Checked before any request. */
export function looksLikeKey(text) {
  return /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(String(text ?? "").trim());
}

/**
 * Ask Anthropic whether this key can use this model.
 *
 * models.retrieve costs nothing — no tokens, no answer — and fails for exactly
 * the two things worth knowing before switching: a key Anthropic does not
 * accept, and a model that key cannot use. The errors are the SDK's own typed
 * classes, turned into sentences somebody can act on.
 */
export async function checkClaudeKey(key, model, { createClient = (options) => new Anthropic(options) } = {}) {
  try {
    const client = createClient({ apiKey: key, maxRetries: 0, timeout: 15000 });
    await client.models.retrieve(model);
    return { ok: true };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return { error: "Anthropic didn't accept that key. Check it was copied whole." };
    if (err instanceof Anthropic.PermissionDeniedError) return { error: "That key isn't allowed to use Claude models." };
    if (err instanceof Anthropic.NotFoundError) return { error: `That key works, but it can't use ${model}. Pick another model.` };
    if (err instanceof Anthropic.RateLimitError) return { error: "Anthropic says too many requests right now. Try again in a minute." };
    if (err instanceof Anthropic.APIConnectionError) return { error: "Couldn't reach Anthropic. Check the internet connection." };
    if (err instanceof Anthropic.APIError) return { error: `Anthropic answered with an error (${err.status ?? "no status"}). Try again shortly.` };
    return { error: `Couldn't check the key: ${err.message}` };
  }
}

/** What the Brain tab shows. Never the key. */
export function brainState(config, { env = process.env, brain = describeBrain() } = {}) {
  const key = String(env[KEY_NAME] ?? "").trim();
  return {
    using: config.provider === "anthropic" ? "claude" : "local",
    model: knownModel(config.model) ? config.model : DEFAULT_MODEL,
    models: CLAUDE_MODELS,
    keySaved: Boolean(key),
    keyEnding: key.length >= 8 ? key.slice(-4) : "",
    active: { label: brain.label, kind: brain.kind ?? null, running: brain.active, onThisMachine: brain.onThisMachine },
  };
}

/**
 * Carry out one thing the Brain tab asked for.
 *
 *   { action: "save-key", key, model }   check it, then keep it in .env
 *   { action: "remove-key" }             forget it — back to this PC first
 *   { action: "use", brain: "claude" | "local", model }
 *
 * Returns { ok } or { error }, and the state either way. On any error nothing
 * has changed: the check comes before every write.
 */
export async function changeBrain(request, config, deps = {}) {
  const {
    env = process.env,
    envFile = ENV_FILE,
    check = checkClaudeKey,
    reinit = initBrain,
    save = saveConfig,
    warm = warmBrain,
  } = deps;
  const state = () => brainState(config, { env, brain: deps.describe ? deps.describe() : describeBrain() });
  const fail = (error) => ({ error, state: state() });
  const model = request.model === undefined ? brainState(config, { env }).model : request.model;

  switch (request.action) {
    case "save-key": {
      const key = String(request.key ?? "").trim();
      if (!looksLikeKey(key)) return fail("That doesn't look like an Anthropic API key. They start with sk-ant-.");
      if (!knownModel(model)) return fail("Pick one of the Claude models in the list.");
      const checked = await check(key, model);
      if (checked.error) return fail(checked.error);
      const saved = setEnvValue(KEY_NAME, key, { file: envFile, env });
      if (saved.error) return fail(saved.error);
      // Already on Claude: the provider made its client with the OLD key, so
      // make a new one or the new key does nothing until a restart.
      if (config.provider === "anthropic") await reinit(config);
      return { ok: true, state: state() };
    }

    case "remove-key": {
      // Off Claude first, or the next question goes to a brain with no key.
      if (config.provider === "anthropic") {
        const back = await changeBrain({ action: "use", brain: "local" }, config, deps);
        if (back.error) return back;
      }
      const removed = removeEnvValue(KEY_NAME, { file: envFile, env });
      if (removed.error) return fail(removed.error);
      return { ok: true, state: state() };
    }

    case "use": {
      if (request.brain === "local") {
        // "auto", not "ollama": the local brain, and never a quiet move to the
        // cloud if it is down. See initBrain.
        config.provider = "auto";
        const saved = save();
        if (saved && saved.ok === false) return fail(`Couldn't save to config.json: ${saved.error}`);
        const brain = await reinit(config);
        warm(); // fired, not awaited: loading takes seconds and the dialog should not wait
        if (!brain.active) {
          return {
            ok: true,
            warning: "He's set to think on this PC, but no local brain answered, so he's in basic mode until Ollama is running.",
            state: state(),
          };
        }
        return { ok: true, state: state() };
      }

      if (request.brain === "claude") {
        if (!knownModel(model)) return fail("Pick one of the Claude models in the list.");
        const key = String(env[KEY_NAME] ?? "").trim();
        if (!key) return fail("Save a Claude API key first.");
        // Every switch is checked, not only the first: a key can be revoked or
        // run out of credit between one day and the next.
        const checked = await check(key, model);
        if (checked.error) return fail(checked.error);
        config.provider = "anthropic";
        config.model = model;
        const saved = save();
        if (saved && saved.ok === false) return fail(`Couldn't save to config.json: ${saved.error}`);
        const brain = await reinit(config);
        if (!brain.active) return fail("The key checked out, but Claude didn't start. The console says why.");
        return { ok: true, state: state() };
      }

      return fail('Say which brain: "claude" or "local".');
    }

    default:
      return fail("Say what to do: save-key, remove-key or use.");
  }
}
