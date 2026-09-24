// Choosing Claude as his brain from Settings: the .env writer, the key check,
// and the switch itself.
//
// Nothing here reaches Anthropic, Ollama, the real .env or the real
// config.json. The key check is given a fake client that throws the SDK's own
// error classes; the switch is given a fake check, a fake re-init and a fake
// save. The real .env is compared before and after.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";

import { setEnvValue, removeEnvValue } from "../lib/envfile.js";
import { looksLikeKey, checkClaudeKey, brainState, changeBrain, CLAUDE_MODELS, DEFAULT_MODEL } from "../lib/claude-brain.js";
import { takesEffort } from "../lib/providers/anthropic.js";

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")));
const REAL_ENV = path.join(ROOT, ".env");
const realBefore = fs.existsSync(REAL_ENV) ? fs.readFileSync(REAL_ENV, "utf8") : null;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "greg-claude-brain-"));
let n = 0;
const scratchEnv = (content) => {
  const file = path.join(DIR, `env-${n++}`);
  if (content !== undefined) fs.writeFileSync(file, content);
  return file;
};

after(() => {
  const now = fs.existsSync(REAL_ENV) ? fs.readFileSync(REAL_ENV, "utf8") : null;
  assert.equal(now, realBefore, "the real .env is unchanged");
  fs.rmSync(DIR, { recursive: true, force: true });
});

const KEY = "sk-ant-api03-" + "a".repeat(40) + "WXYZ";

// ---------------------------------------------------------------------------
// .env
// ---------------------------------------------------------------------------

test("a value is added to .env, and every other line is kept as the user wrote it", () => {
  const file = scratchEnv("# my settings\nSPOTIFY_CLIENT_ID=abc123\n\nNASA_API_KEY=xyz\n");
  const env = {};
  assert.deepEqual(setEnvValue("ANTHROPIC_API_KEY", KEY, { file, env }), { ok: true });
  assert.equal(fs.readFileSync(file, "utf8"), `# my settings\nSPOTIFY_CLIENT_ID=abc123\n\nNASA_API_KEY=xyz\nANTHROPIC_API_KEY=${KEY}\n`);
  assert.equal(env.ANTHROPIC_API_KEY, KEY);
});

test("setting it again replaces it where it was, and duplicates go", () => {
  const file = scratchEnv("ANTHROPIC_API_KEY=old\nOTHER=1\nexport ANTHROPIC_API_KEY=older\n");
  setEnvValue("ANTHROPIC_API_KEY", "sk-ant-new", { file, env: {} });
  assert.equal(fs.readFileSync(file, "utf8"), "ANTHROPIC_API_KEY=sk-ant-new\nOTHER=1\n");
});

test("a .env that does not exist yet is created", () => {
  const file = scratchEnv();
  setEnvValue("ANTHROPIC_API_KEY", KEY, { file, env: {} });
  assert.equal(fs.readFileSync(file, "utf8"), `ANTHROPIC_API_KEY=${KEY}\n`);
});

test("nothing that could write a second line, or read back as something else, is saved", () => {
  const file = scratchEnv("OTHER=1\n");
  const env = {};
  for (const value of [
    `${KEY}\nANTHROPIC_BASE_URL=http://elsewhere.example`,
    `${KEY}\r\nX=1`,
    `sk-ant "quoted"`,
    "sk-ant #comment",
    "has space",
    "",
    "x".repeat(401),
  ]) {
    assert.ok(setEnvValue("ANTHROPIC_API_KEY", value, { file, env }).error, JSON.stringify(value).slice(0, 40));
  }
  assert.ok(setEnvValue("lower-case", "x", { file, env }).error);
  assert.equal(fs.readFileSync(file, "utf8"), "OTHER=1\n", "untouched");
  assert.deepEqual(env, {});
});

test("removing a value takes only that line", () => {
  const file = scratchEnv(`OTHER=1\nANTHROPIC_API_KEY=${KEY}\n# note\n`);
  const env = { ANTHROPIC_API_KEY: KEY };
  assert.deepEqual(removeEnvValue("ANTHROPIC_API_KEY", { file, env }), { ok: true });
  assert.equal(fs.readFileSync(file, "utf8"), "OTHER=1\n# note\n");
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  // And again, with nothing to remove, is fine.
  assert.deepEqual(removeEnvValue("ANTHROPIC_API_KEY", { file, env }), { ok: true });
});

// ---------------------------------------------------------------------------
// The key check
// ---------------------------------------------------------------------------

test("only something shaped like an Anthropic key is sent to be checked", () => {
  assert.equal(looksLikeKey(KEY), true);
  assert.equal(looksLikeKey(`  ${KEY}  `), true);
  for (const text of ["", null, "sk-proj-abcdefghijklmnopqrstuvwxyz", "sk-ant-short", "my key", `${KEY} extra`]) {
    assert.equal(looksLikeKey(text), false, String(text));
  }
});

/** A stand-in for the SDK client whose models.retrieve does what it is told. */
const clientThat = (outcome, seen = {}) => (options) => {
  seen.options = options;
  return {
    models: {
      retrieve: async (model) => {
        seen.model = model;
        if (outcome instanceof Error) throw outcome;
        return { id: model };
      },
    },
  };
};

test("a key Anthropic accepts for that model passes, with no retries and a timeout", async () => {
  const seen = {};
  assert.deepEqual(await checkClaudeKey(KEY, "claude-sonnet-5", { createClient: clientThat("ok", seen) }), { ok: true });
  assert.equal(seen.model, "claude-sonnet-5");
  assert.equal(seen.options.apiKey, KEY);
  assert.equal(seen.options.maxRetries, 0);
  assert.ok(seen.options.timeout > 0);
});

test("each way Anthropic can say no becomes a sentence somebody can act on", async () => {
  const headers = new Headers();
  const cases = [
    [new Anthropic.AuthenticationError(401, {}, "invalid x-api-key", headers), /didn't accept that key/],
    [new Anthropic.PermissionDeniedError(403, {}, "forbidden", headers), /isn't allowed/],
    [new Anthropic.NotFoundError(404, {}, "not found", headers), /can't use claude-opus-5/],
    [new Anthropic.RateLimitError(429, {}, "slow down", headers), /too many requests/],
    [new Anthropic.APIConnectionError({ message: "offline" }), /Couldn't reach Anthropic/],
    [new Anthropic.InternalServerError(500, {}, "oops", headers), /error \(500\)/],
    [new Error("something odd"), /Couldn't check the key: something odd/],
  ];
  for (const [error, expected] of cases) {
    const result = await checkClaudeKey(KEY, "claude-opus-5", { createClient: clientThat(error) });
    assert.match(result.error, expected, error.constructor.name);
    assert.ok(!result.error.includes(KEY), "the key is never repeated back");
  }
});

// ---------------------------------------------------------------------------
// The switch
// ---------------------------------------------------------------------------

/** A config, an env, and fakes that record what the switch did. */
function harness({ provider = "auto", model = "claude-opus-5", key = null, check = { ok: true } } = {}) {
  const config = { provider, model };
  const env = key ? { ANTHROPIC_API_KEY: key } : {};
  const envFile = scratchEnv(key ? `ANTHROPIC_API_KEY=${key}\n` : "");
  const calls = { checks: [], reinits: 0, saves: 0, warms: 0 };
  const deps = {
    env,
    envFile,
    check: async (k, m) => {
      calls.checks.push([k, m]);
      return typeof check === "function" ? check(k, m) : check;
    },
    reinit: async (c) => {
      calls.reinits++;
      return { active: true, label: c.provider === "anthropic" ? c.model : "gemma4:e4b" };
    },
    save: () => {
      calls.saves++;
      return { ok: true };
    },
    warm: () => {
      calls.warms++;
    },
    describe: () => ({ active: true, label: config.provider === "anthropic" ? config.model : "gemma4:e4b", kind: config.provider === "anthropic" ? "anthropic" : "ollama" }),
  };
  return { config, env, envFile, calls, deps };
}

test("switching to Claude with no key saved is refused, and changes nothing", async () => {
  const h = harness();
  const result = await changeBrain({ action: "use", brain: "claude", model: "claude-opus-5" }, h.config, h.deps);
  assert.match(result.error, /Save a Claude API key first/);
  assert.equal(h.config.provider, "auto");
  assert.equal(h.calls.saves, 0);
});

test("a key that fails its check is never saved", async () => {
  const h = harness({ check: { error: "Anthropic didn't accept that key." } });
  const result = await changeBrain({ action: "save-key", key: KEY, model: "claude-opus-5" }, h.config, h.deps);
  assert.match(result.error, /didn't accept/);
  assert.equal(fs.readFileSync(h.envFile, "utf8"), "");
  assert.equal(h.env.ANTHROPIC_API_KEY, undefined);
});

test("a good key is checked, saved, and reported only by its last four characters", async () => {
  const h = harness();
  const result = await changeBrain({ action: "save-key", key: `  ${KEY} `, model: "claude-sonnet-5" }, h.config, h.deps);
  assert.equal(result.ok, true);
  assert.deepEqual(h.calls.checks, [[KEY, "claude-sonnet-5"]]);
  assert.equal(fs.readFileSync(h.envFile, "utf8"), `ANTHROPIC_API_KEY=${KEY}\n`);
  assert.equal(result.state.keySaved, true);
  assert.equal(result.state.keyEnding, "WXYZ");
  assert.ok(!JSON.stringify(result).includes(KEY), "the key is never in what goes back to the page");
  // Saving a key is not switching to Claude.
  assert.equal(h.config.provider, "auto");
});

test("something that isn't a key is refused before Anthropic is asked", async () => {
  const h = harness();
  const result = await changeBrain({ action: "save-key", key: "hello", model: "claude-opus-5" }, h.config, h.deps);
  assert.match(result.error, /sk-ant-/);
  assert.equal(h.calls.checks.length, 0);
});

test("switching to Claude checks the key again, then saves and restarts the brain", async () => {
  const h = harness({ key: KEY });
  const result = await changeBrain({ action: "use", brain: "claude", model: "claude-sonnet-5" }, h.config, h.deps);
  assert.equal(result.ok, true);
  assert.deepEqual(h.calls.checks, [[KEY, "claude-sonnet-5"]]);
  assert.equal(h.config.provider, "anthropic");
  assert.equal(h.config.model, "claude-sonnet-5");
  assert.equal(h.calls.saves, 1);
  assert.equal(h.calls.reinits, 1);
  assert.equal(result.state.using, "claude");
});

test("a key that has stopped working keeps him where he was", async () => {
  const h = harness({ key: KEY, check: { error: "Anthropic didn't accept that key." } });
  const result = await changeBrain({ action: "use", brain: "claude", model: "claude-opus-5" }, h.config, h.deps);
  assert.ok(result.error);
  assert.equal(h.config.provider, "auto");
  assert.equal(h.calls.saves, 0);
  assert.equal(h.calls.reinits, 0);
});

test("only the models in the list can be chosen", async () => {
  const h = harness({ key: KEY });
  for (const model of ["gpt-5", "claude-opus-5-20260401", "", null]) {
    const result = await changeBrain({ action: "use", brain: "claude", model }, h.config, h.deps);
    assert.match(result.error, /Pick one of the Claude models/, String(model));
  }
  assert.equal(h.config.provider, "auto");
});

test("back to this PC means 'auto', and the local brain is warmed", async () => {
  const h = harness({ provider: "anthropic", key: KEY });
  const result = await changeBrain({ action: "use", brain: "local" }, h.config, h.deps);
  assert.equal(result.ok, true);
  assert.equal(h.config.provider, "auto", "never 'ollama': auto is the local-only setting");
  assert.equal(h.calls.warms, 1);
  assert.equal(h.calls.checks.length, 0, "going local needs no key");
});

test("with Ollama down, going local says he is in basic mode rather than pretending", async () => {
  const h = harness({ provider: "anthropic", key: KEY });
  h.deps.reinit = async () => ({ active: false, label: "basic mode" });
  const result = await changeBrain({ action: "use", brain: "local" }, h.config, h.deps);
  assert.equal(result.ok, true);
  assert.match(result.warning, /basic mode/);
});

test("removing the key while on Claude moves him back to this PC first", async () => {
  const h = harness({ provider: "anthropic", key: KEY });
  const result = await changeBrain({ action: "remove-key" }, h.config, h.deps);
  assert.equal(result.ok, true);
  assert.equal(h.config.provider, "auto");
  assert.equal(h.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(fs.readFileSync(h.envFile, "utf8"), "");
  assert.equal(result.state.keySaved, false);
});

test("a new key while on Claude restarts the brain, so the old key stops being used", async () => {
  const h = harness({ provider: "anthropic", key: KEY });
  const newer = "sk-ant-api03-" + "b".repeat(40) + "NEW1";
  await changeBrain({ action: "save-key", key: newer }, h.config, h.deps);
  assert.equal(h.calls.reinits, 1);
  assert.equal(h.env.ANTHROPIC_API_KEY, newer);
});

test("the state the dialog reads never carries the key", () => {
  const state = brainState({ provider: "anthropic", model: "claude-haiku-4-5" }, { env: { ANTHROPIC_API_KEY: KEY }, brain: { active: true, label: "x" } });
  assert.equal(state.using, "claude");
  assert.equal(state.model, "claude-haiku-4-5");
  assert.ok(!JSON.stringify(state).includes(KEY));
  // An unknown model in config.json shows as the default, not as a blank.
  assert.equal(brainState({ model: "claude-2" }, { env: {}, brain: {} }).model, DEFAULT_MODEL);
  assert.equal(brainState({}, { env: {}, brain: {} }).keySaved, false);
});

test("nonsense actions are refused", async () => {
  const h = harness({ key: KEY });
  assert.ok((await changeBrain({ action: "explode" }, h.config, h.deps)).error);
  assert.ok((await changeBrain({ action: "use", brain: "gpt" }, h.config, h.deps)).error);
  assert.equal(h.config.provider, "auto");
});

test("effort is sent to every offered model but Haiku 4.5, which rejects it", () => {
  assert.equal(takesEffort("claude-opus-5"), true);
  assert.equal(takesEffort("claude-sonnet-5"), true);
  assert.equal(takesEffort("claude-haiku-4-5"), false);
  assert.ok(CLAUDE_MODELS.some((m) => m.id === "claude-haiku-4-5"));
});
