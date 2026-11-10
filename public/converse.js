/**
 * Vanilla-JS demo client for the /v1/converse endpoint. Doubles as a
 * plain-JS reference for the protocol (see client/src/converseProtocol.ts):
 * mic capture, gapless playback of the assistant's speech, interruption,
 * and tools executed in the page.
 */
const $ = (id) => document.getElementById(id);

for (const id of ["token", "language", "provider", "model", "voice"]) {
  $(id).value = localStorage.getItem(`vs_${id}`) || "";
  $(id).addEventListener("change", () => localStorage.setItem(`vs_${id}`, $(id).value.trim()));
}

// --- Tools the model can call. They run here, in the page. ------------------

const TOOLS = [
  {
    name: "get_time",
    description: "Current local date and time of the user.",
    speculative: true, // read-only: may run before the user has finished speaking
    run: () => ({ now: new Date().toString() }),
  },
  {
    name: "set_accent_color",
    description: "Change the accent color of the page.",
    parameters: {
      type: "object",
      properties: { color: { type: "string", description: "A CSS color, e.g. #e5534b or teal" } },
      required: ["color"],
    },
    run: ({ color }) => {
      if (!CSS.supports("color", String(color))) throw new Error(`"${color}" is not a CSS color`);
      document.documentElement.style.setProperty("--accent", color);
      return { ok: true };
    },
  },
  {
    name: "add_note",
    description: "Write a note down in the user's list.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    run: ({ text }) => {
      const item = document.createElement("li");
      item.textContent = String(text);
      $("notes").appendChild(item);
      return { ok: true, count: $("notes").children.length };
    },
  },
  {
    name: "list_notes",
    description: "Read the user's notes.",
    speculative: true,
    run: () => ({ notes: [...$("notes").children].map((li) => li.textContent) }),
  },
];

// --- Playback: PCM frames scheduled back to back ----------------------------

const player = { ctx: null, rate: 24000, nextAt: 0, sources: new Set() };

function playPcm(arrayBuffer) {
  const samples = new Int16Array(arrayBuffer, 0, arrayBuffer.byteLength >> 1);
  if (!player.ctx || samples.length === 0) return;
  const buffer = player.ctx.createBuffer(1, samples.length, player.rate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < samples.length; i += 1) channel[i] = samples[i] / 32768;
  const source = player.ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(player.ctx.destination);
  // A small lead on the first frame absorbs network jitter.
  const startAt = Math.max(player.nextAt, player.ctx.currentTime + 0.04);
  source.start(startAt);
  player.nextAt = startAt + buffer.duration;
  player.sources.add(source);
  source.onended = () => player.sources.delete(source);
}

function stopPlayback() {
  for (const source of player.sources) {
    try {
      source.stop();
    } catch {
      /* already ended */
    }
  }
  player.sources.clear();
  player.nextAt = 0;
}

// --- Conversation log -------------------------------------------------------

const view = { liveUser: null, assistant: new Map() };

function bubble(kind, text = "") {
  const el = document.createElement("div");
  el.className = `msg ${kind}`;
  el.textContent = text;
  $("log").appendChild(el);
  el.scrollIntoView({ block: "nearest" });
  return el;
}

function setStatus(text, dotClass = "") {
  $("status").textContent = text;
  $("dot").className = `dot ${dotClass}`;
}

// --- Session ----------------------------------------------------------------

const session = { ws: null, micCtx: null, stream: null, node: null, ready: false };

function cleanup() {
  stopPlayback();
  if (session.stream) for (const track of session.stream.getTracks()) track.stop();
  if (session.node) session.node.disconnect();
  for (const ctx of [session.micCtx, player.ctx]) if (ctx && ctx.state !== "closed") ctx.close();
  session.stream = session.node = session.micCtx = player.ctx = null;
  session.ready = false;
  $("start").disabled = false;
  for (const id of ["stop", "hush", "typed"]) $(id).disabled = true;
}

async function runTool(ws, ev) {
  const tool = TOOLS.find((t) => t.name === ev.name);
  const line = bubble("tool", `${ev.speculative ? "(early) " : ""}${ev.name}(${ev.arguments})`);
  let output;
  let isError = false;
  try {
    output = JSON.stringify(await tool.run(JSON.parse(ev.arguments || "{}")));
  } catch (err) {
    output = String(err && err.message ? err.message : err);
    isError = true;
  }
  line.textContent += ` → ${output}`;
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "tool_result", callId: ev.callId, output, isError }));
  }
}

function handleEvent(ws, ev) {
  switch (ev.type) {
    case "ready":
      session.ready = true;
      player.rate = ev.audio.sampleRate;
      setStatus("listening", "live");
      for (const id of ["stop", "hush", "typed"]) $(id).disabled = false;
      $("meta").textContent = `${ev.llmProvider} / ${ev.llmModel} · ${ev.sttModel} · ${ev.ttsModel}`;
      break;
    case "transcript":
      if (!view.liveUser) view.liveUser = bubble("user live");
      view.liveUser.textContent += ev.text;
      break;
    case "user_turn":
      if (!view.liveUser) view.liveUser = bubble("user");
      view.liveUser.textContent = ev.text;
      view.liveUser.className = "msg user";
      view.liveUser = null;
      break;
    case "turn":
      setStatus(ev.phase === "start" || ev.phase === "resume" ? "you're speaking" : "listening", "live");
      break;
    case "response_start":
      view.assistant.set(ev.responseId, bubble("assistant"));
      break;
    case "assistant_delta":
      view.assistant.get(ev.responseId).textContent += ev.text;
      break;
    case "tool_call":
      void runTool(ws, ev);
      break;
    case "interrupt": {
      stopPlayback();
      const el = view.assistant.get(ev.responseId);
      if (el) {
        el.textContent = ev.heardText ? `${ev.heardText}…` : "…";
        el.classList.add("cut");
      }
      break;
    }
    case "response_done": {
      const el = view.assistant.get(ev.responseId);
      if (el && !el.textContent) el.remove();
      break;
    }
    case "response_error":
      bubble("tool", `${ev.code}: ${ev.message}`);
      break;
    case "error":
      setStatus(`error: ${ev.code} — ${ev.message}`, "err");
      break;
  }
}

async function start() {
  const token = $("token").value.trim();
  if (!token) {
    alert("Paste the server AUTH_TOKEN first.");
    return;
  }
  $("start").disabled = true;
  $("log").textContent = "";
  view.liveUser = null;
  view.assistant.clear();
  setStatus("requesting mic…");

  try {
    session.stream = await navigator.mediaDevices.getUserMedia({
      // Echo cancellation keeps the assistant from hearing (and interrupting) itself.
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    setStatus(`mic denied: ${err.name}`, "err");
    $("start").disabled = false;
    return;
  }

  try {
    session.micCtx = new AudioContext({ sampleRate: 16000 });
  } catch {
    session.micCtx = new AudioContext();
  }
  player.ctx = new AudioContext();
  await session.micCtx.audioWorklet.addModule("/pcm-worklet.js");
  const source = session.micCtx.createMediaStreamSource(session.stream);
  session.node = new AudioWorkletNode(session.micCtx, "pcm-processor", {
    processorOptions: { targetSampleRate: 16000, chunkMs: 100 },
  });
  const muted = session.micCtx.createGain();
  muted.gain.value = 0;
  source.connect(session.node);
  session.node.connect(muted);
  muted.connect(session.micCtx.destination);

  const optional = (id, key) => ($(id).value.trim() ? { [key]: $(id).value.trim() } : {});
  const startMessage = {
    type: "start",
    sampleRate: 16000,
    instructions: $("instructions").value,
    tools: TOOLS.map(({ run, ...definition }) => definition),
    bargeIn: $("bargeIn").checked,
    speculate: $("speculate").checked,
    ...optional("language", "language"),
    ...optional("provider", "provider"),
    ...optional("model", "model"),
    ...optional("voice", "voice"),
  };

  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/v1/converse?token=${encodeURIComponent(token)}`);
  ws.binaryType = "arraybuffer";
  session.ws = ws;
  ws.onopen = () => {
    setStatus("connecting…");
    ws.send(JSON.stringify(startMessage));
  };
  ws.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) playPcm(e.data);
    else handleEvent(ws, JSON.parse(e.data));
  };
  ws.onclose = (e) => {
    if (!$("dot").className.includes("err")) setStatus(`closed (${e.code}${e.reason ? ` ${e.reason}` : ""})`);
    cleanup();
  };
  session.node.port.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer && session.ready && ws.readyState === WebSocket.OPEN) ws.send(e.data);
  };
}

const sendJson = (message) => {
  if (session.ws && session.ws.readyState === WebSocket.OPEN) session.ws.send(JSON.stringify(message));
};

$("start").addEventListener("click", () => void start());
$("stop").addEventListener("click", () => sendJson({ type: "stop" }));
$("hush").addEventListener("click", () => sendJson({ type: "interrupt" }));
$("typed").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || !$("typed").value.trim()) return;
  sendJson({ type: "text", text: $("typed").value.trim() });
  $("typed").value = "";
});
