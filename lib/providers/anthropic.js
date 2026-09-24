// Claude provider — used only when config.json says "provider": "anthropic"
// AND an ANTHROPIC_API_KEY is present. "auto" never picks it: see initBrain.
// Greg works fine without this; see providers/ollama.js for the local option.

import Anthropic from "@anthropic-ai/sdk";

/** Does this model accept output_config.effort? Every current one but Haiku 4.5. */
export function takesEffort(model) {
  return !String(model ?? "").startsWith("claude-haiku-4-5");
}

export function createAnthropicProvider(config) {
  let client = null;
  const model = config.model ?? "claude-opus-5";

  return {
    name: "anthropic",
    // Everything said to him, and everything his tools find for him, is sent to
    // Anthropic while this is the brain. The window shows a badge whenever it
    // is — see public/brain-place.js — and this is the field it reads.
    where: { onThisMachine: false, service: "Anthropic" },
    label: `${model} (Claude, on Anthropic's servers)`,

    async ready() {
      return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
    },

    /**
     * Every Claude model this talks to calls tools. Present so brain.js never
     * has to ask which provider it has — the same reason warm() exists below.
     */
    async supportsTools() {
      return true;
    },

    /**
     * Nothing to warm — the model is on somebody else's machine and is always
     * ready. Present so callers never have to ask which provider they have,
     * and returning "n/a" rather than throwing because the warm-up is fired
     * and forgotten: a rejection here would be an unhandled one.
     */
    async warm() {
      return "n/a";
    },

    async complete({ system, messages, tools }) {
      client ??= new Anthropic(); // reads ANTHROPIC_API_KEY from the environment

      const response = await client.messages.create({
        model,
        max_tokens: config.maxTokens ?? 700,
        system,
        // Low effort keeps Greg quick — this is a conversation, not a research project.
        // Only for models that take it: Haiku 4.5 answers the setting with a 400.
        ...(takesEffort(model) ? { output_config: { effort: config.effort ?? "low" } } : {}),
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.parameters,
        })),
        messages: messages.map(toAnthropicMessage),
      });

      // Always check why it stopped before reading the content.
      if (response.stop_reason === "refusal") {
        return { text: "I'm not able to help with that one.", toolCalls: [], refused: true };
      }

      const text = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join(" ")
        .trim();

      const toolCalls = response.content
        .filter((block) => block.type === "tool_use")
        .map((block) => ({ id: block.id, name: block.name, args: block.input ?? {} }));

      return { text, toolCalls };
    },
  };
}

function toAnthropicMessage(message) {
  if (message.role === "tool") {
    return {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: message.toolCallId, content: message.content }],
    };
  }

  if (message.role === "assistant") {
    const content = [];
    if (message.content) content.push({ type: "text", text: message.content });
    for (const call of message.toolCalls ?? []) {
      content.push({ type: "tool_use", id: call.id, name: call.name, input: call.args });
    }
    return { role: "assistant", content };
  }

  return { role: "user", content: message.content };
}
