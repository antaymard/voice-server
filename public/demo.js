/**
 * Vanilla-JS demo client for voice-server. Doubles as a plain-JS reference for
 * the wire protocol; React apps should use the kit in client/ instead.
 */
const $ = (id) => document.getElementById(id);

const tokenInput = $("token");
tokenInput.value = localStorage.getItem("vs_token") || "";
tokenInput.addEventListener("change", () => localStorage.setItem("vs_token", tokenInput.value.trim()));

function requireToken() {
  const token = tokenInput.value.trim();
  if (!token) {
    alert("Paste the server AUTH_TOKEN first.");
    return null;
  }
  return token;
}

// --- Realtime mic ---

const mic = { ws: null, ctx: null, stream: null, node: null, pending: [], ready: false };

function setMicStatus(text, dotClass = "") {
  $("micStatus").textContent = text;
  $("micDot").className = `dot ${dotClass}`;
}

function cleanupAudio() {
  if (mic.stream) for (const track of mic.stream.getTracks()) track.stop();
  if (mic.node) mic.node.disconnect();
  if (mic.ctx && mic.ctx.state !== "closed") mic.ctx.close();
  mic.stream = mic.node = mic.ctx = null;
  $("micStart").disabled = false;
  $("micStop").disabled = true;
}

async function startMic() {
  const token = requireToken();
  if (!token) return;
  const targetDelayMs = Number($("delay").value) || 480;

  $("transcript").textContent = "";
  $("lang").textContent = "–";
  $("micStart").disabled = true;
  setMicStatus("requesting mic…");

  try {
    mic.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    setMicStatus(`mic denied: ${err.name}`, "err");
    $("micStart").disabled = false;
    return;
  }

  // 16 kHz hint; if the browser ignores it, the worklet resamples.
  try {
    mic.ctx = new AudioContext({ sampleRate: 16000 });
  } catch {
    mic.ctx = new AudioContext();
  }
  await mic.ctx.audioWorklet.addModule("/pcm-worklet.js");
  const source = mic.ctx.createMediaStreamSource(mic.stream);
  mic.node = new AudioWorkletNode(mic.ctx, "pcm-processor", {
    processorOptions: { targetSampleRate: 16000, chunkMs: 100 },
  });
  const muted = mic.ctx.createGain();
  muted.gain.value = 0;
  source.connect(mic.node);
  mic.node.connect(muted);
  muted.connect(mic.ctx.destination);

  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/v1/realtime?token=${encodeURIComponent(token)}`);
  ws.binaryType = "arraybuffer";
  mic.ws = ws;
  mic.ready = false;
  mic.pending = [];

  ws.onopen = () => ws.send(JSON.stringify({ type: "start", sampleRate: 16000, targetDelayMs }));
  ws.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    switch (ev.type) {
      case "ready":
        mic.ready = true;
        for (const buf of mic.pending) ws.send(buf);
        mic.pending = [];
        setMicStatus("listening", "live");
        $("micStop").disabled = false;
        break;
      case "delta":
        $("transcript").textContent += ev.text;
        break;
      case "language":
        $("lang").textContent = ev.language;
        break;
      case "done":
        $("transcript").textContent = ev.text;
        setMicStatus("done");
        break;
      case "error":
        setMicStatus(`error: ${ev.code} — ${ev.message}`, "err");
        break;
    }
  };
  ws.onclose = (e) => {
    if ($("micDot").className.indexOf("err") < 0) {
      setMicStatus(`closed (${e.code}${e.reason ? " " + e.reason : ""})`);
    }
    cleanupAudio();
  };

  mic.node.port.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) {
      if (mic.ready && ws.readyState === WebSocket.OPEN) ws.send(e.data);
      else if (mic.pending.length < 64) mic.pending.push(e.data);
    } else if (e.data && e.data.type === "flushed") {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "stop" }));
    }
  };
}

function stopMic() {
  $("micStop").disabled = true;
  setMicStatus("finalizing…");
  if (mic.stream) for (const track of mic.stream.getTracks()) track.stop();
  if (mic.node) {
    // The worklet posts its tail chunk then {type:"flushed"} -> we send stop.
    mic.node.port.postMessage({ type: "flush" });
  } else if (mic.ws && mic.ws.readyState === WebSocket.OPEN) {
    mic.ws.send(JSON.stringify({ type: "stop" }));
  }
}

$("micStart").addEventListener("click", startMic);
$("micStop").addEventListener("click", stopMic);

// --- Bulk upload ---

$("bulkSend").addEventListener("click", async () => {
  const token = requireToken();
  if (!token) return;
  const file = $("file").files[0];
  if (!file) {
    alert("Choose an audio file first.");
    return;
  }
  $("bulkSend").disabled = true;
  $("bulkStatus").textContent = "transcribing…";
  $("bulkResult").textContent = "";
  try {
    const form = new FormData();
    form.append("file", file);
    const language = $("blang").value.trim();
    if (language) form.append("language", language);
    const res = await fetch("/v1/transcribe", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
    const body = await res.json();
    if (res.ok) {
      $("bulkStatus").textContent = `ok (${body.language ?? "?"})`;
      $("bulkResult").textContent = body.text;
    } else {
      $("bulkStatus").textContent = "failed";
      $("bulkResult").textContent = JSON.stringify(body, null, 2);
    }
  } catch (err) {
    $("bulkStatus").textContent = "failed";
    $("bulkResult").textContent = String(err);
  } finally {
    $("bulkSend").disabled = false;
  }
});
