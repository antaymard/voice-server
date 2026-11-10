/**
 * The "brain" of a conversation, behind a small interface so the model is
 * swappable: anything that speaks the OpenAI chat-completions protocol
 * (Mistral, OpenAI, Groq, OpenRouter, Ollama, vLLM, …) works by configuration.
 */
import type { Config, LlmProvider } from "../config.ts";

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; name: string; content: string };

export type LlmTool = { name: string; description: string; parameters: Record<string, unknown> };

export type LlmRequest = {
  provider: LlmProvider;
  model: string;
  messages: ChatMessage[];
  tools: LlmTool[];
  signal: AbortSignal;
};

export type LlmChunk = { type: "text"; text: string } | { type: "tool_call"; call: ToolCall };

/** Streams one model turn: text deltas as they come, then complete tool calls. */
export type Llm = (request: LlmRequest) => AsyncIterable<LlmChunk>;

export class LlmError extends Error {}

/** Which endpoint and model a conversation uses, or why the request is refused. */
export function resolveLlm(
  config: Config,
  requested: { provider?: string; model?: string },
): { name: string; provider: LlmProvider; model: string } | { error: string } {
  const name = (requested.provider ?? config.llmDefaultProvider).toLowerCase();
  const provider = config.llmProviders[name];
  if (!provider) {
    return { error: `Unknown LLM provider "${name}" (configured: ${Object.keys(config.llmProviders).join(", ")})` };
  }
  const model = requested.model ?? (name === config.llmDefaultProvider ? config.llmModel : undefined);
  if (!model) return { error: `Provider "${name}" needs an explicit \`model\`` };
  const isDefault = name === config.llmDefaultProvider && model === config.llmModel;
  const allowed =
    isDefault ||
    config.llmAllowedModels === "*" ||
    config.llmAllowedModels.some((m) => m.provider === name && m.model === model);
  if (!allowed) return { error: `Model "${model}" on provider "${name}" is not allowed (see LLM_MODELS)` };
  return { name, provider, model };
}

type StreamDelta = {
  content?: unknown;
  tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: unknown } }>;
};

/** `content` is a string, or (some providers) an array of typed parts. */
function deltaText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const p = part as { type?: unknown; text?: unknown } | null;
      return p && p.type === "text" && typeof p.text === "string" ? p.text : "";
    })
    .join("");
}

async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
  const tail = buffer.trim();
  if (tail.startsWith("data:")) yield tail.slice(5).trim();
}

export const openAiCompatibleLlm: Llm = async function* ({ provider, model, messages, tools, signal }) {
  let response: Response;
  try {
    response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        ...(tools.length > 0
          ? { tools: tools.map((t) => ({ type: "function", function: t })), tool_choice: "auto" }
          : {}),
      }),
    });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new LlmError(`Could not reach the LLM: ${String(err)}`);
  }
  if (!response.ok || !response.body) {
    const detail = (await response.text().catch(() => "")).slice(0, 500);
    throw new LlmError(`LLM answered ${response.status}: ${detail || response.statusText}`);
  }

  // Tool calls arrive in fragments keyed by index; they are complete only
  // once the stream ends.
  const calls = new Map<number, { id: string; name: string; args: string }>();
  for await (const data of sseData(response.body)) {
    if (!data || data === "[DONE]") continue;
    let parsed: { choices?: Array<{ delta?: StreamDelta }>; error?: { message?: unknown } };
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }
    if (parsed.error) throw new LlmError(`LLM stream error: ${String(parsed.error.message ?? "unknown")}`);
    const delta = parsed.choices?.[0]?.delta;
    if (!delta) continue;
    const text = deltaText(delta.content);
    if (text) yield { type: "text", text };
    for (const fragment of delta.tool_calls ?? []) {
      // Without an index, a fragment that names a call opens a new one;
      // anything else continues the latest.
      const opens = Boolean(fragment.id || fragment.function?.name);
      const index = fragment.index ?? (opens ? calls.size : Math.max(0, calls.size - 1));
      const call = calls.get(index) ?? { id: "", name: "", args: "" };
      if (fragment.id) call.id = fragment.id;
      if (fragment.function?.name) call.name += fragment.function.name;
      const args = fragment.function?.arguments;
      if (typeof args === "string") call.args += args;
      else if (args && typeof args === "object") call.args += JSON.stringify(args);
      calls.set(index, call);
    }
  }
  let n = 0;
  for (const call of calls.values()) {
    if (!call.name) continue;
    n += 1;
    yield {
      type: "tool_call",
      call: {
        id: call.id || `call_${Date.now().toString(36)}_${n}`,
        type: "function",
        function: { name: call.name, arguments: call.args || "{}" },
      },
    };
  }
};
