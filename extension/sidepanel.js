const MAX_CALLS = 20;
const MAX_TRANSCRIPT_LENGTH = 30_000;
const PLACEHOLDER = "Transcript will appear here as the customer speaks.";
const SPEECH_RMS_THRESHOLD = 0.003;
const SILENCE_COMMIT_MS = 900;

const elements = {
  bridgeToken: document.querySelector("#bridge-token"),
  saveToken: document.querySelector("#save-token"),
  tokenFingerprint: document.querySelector("#token-fingerprint"),
  extensionId: document.querySelector("#extension-id"),
  statusDot: document.querySelector("#status-dot"),
  status: document.querySelector("#status"),
  start: document.querySelector("#start"),
  stop: document.querySelector("#stop"),
  error: document.querySelector("#error"),
  callTime: document.querySelector("#call-time"),
  transcript: document.querySelector("#transcript"),
  copy: document.querySelector("#copy"),
  history: document.querySelector("#history"),
  historyStatus: document.querySelector("#history-status"),
  clearHistory: document.querySelector("#clear-history"),
};

let calls = [];
let currentCall = null;
let socket = null;
let mediaStream = null;
let microphoneStream = null;
let audioContext = null;
let workletNode = null;
let hasPendingSpeech = false;
let lastSpeechAt = 0;
let queuedAudio = [];
let bridgeReady = false;
let pendingStop = false;
let persistenceTimer = null;
let segments = new Map();
let savedBridgeToken = "";

elements.extensionId.textContent = chrome.runtime.id;

function setStatus(text, state = "") {
  elements.status.textContent = text;
  elements.statusDot.className = `status-dot ${state}`.trim();
}

function showError(message) {
  elements.error.textContent = message;
  elements.error.hidden = false;
}

function clearError() {
  elements.error.textContent = "";
  elements.error.hidden = true;
}

async function updateTokenFingerprint(token) {
  if (!token) {
    elements.tokenFingerprint.textContent = "Token fingerprint: not set";
    return;
  }

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const fingerprint = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 12);
  elements.tokenFingerprint.textContent = `Token fingerprint: ${fingerprint}`;
}

function formatTime(dateString) {
  return new Date(dateString).toLocaleString();
}

function downloadTranscript(call) {
  const startedAt = new Date(call.startedAt);
  const timestamp = Number.isNaN(startedAt.getTime())
    ? "unknown-date"
    : startedAt.toISOString().replaceAll(/[:.]/g, "-");
  const content = `Uleadz Call Listener transcript\nStarted: ${formatTime(call.startedAt)}\n\n${call.transcript}\n`;
  const file = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");

  link.href = url;
  link.download = `uleadz-call-transcript-${timestamp}.txt`;
  link.hidden = true;

  try {
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function renderHistory() {
  elements.history.replaceChildren();
  const previous = calls.filter((call) => call.id !== currentCall?.id);

  if (previous.length === 0) {
    const empty = document.createElement("p");
    empty.className = "help";
    empty.textContent = "Completed call transcripts will appear here.";
    elements.history.append(empty);
    return;
  }

  for (const call of previous) {
    const details = document.createElement("details");
    details.className = "history-item";
    const summary = document.createElement("summary");
    summary.textContent = `${formatTime(call.startedAt)} · ${call.transcript ? "Transcript saved" : "No transcript"}`;
    const transcript = document.createElement("p");
    transcript.textContent = call.transcript || "No transcript was captured.";
    details.append(summary, transcript);

    if (call.transcript) {
      const actions = document.createElement("div");
      actions.className = "history-item__actions";
      const download = document.createElement("button");
      download.className = "text-button";
      download.type = "button";
      download.textContent = "Download transcript";
      download.setAttribute("aria-label", `Download transcript from ${formatTime(call.startedAt)}`);
      download.addEventListener("click", () => {
        try {
          downloadTranscript(call);
          elements.historyStatus.textContent = "Transcript downloaded.";
        } catch {
          elements.historyStatus.textContent = "Could not download this transcript.";
        }
      });
      actions.append(download);
      details.append(actions);
    }

    elements.history.append(details);
  }
}

function renderCurrentCall() {
  if (!currentCall) {
    elements.callTime.textContent = "No active session";
    elements.transcript.textContent = PLACEHOLDER;
    elements.copy.disabled = true;
    return;
  }

  elements.callTime.textContent = `Started ${formatTime(currentCall.startedAt)}`;
  elements.transcript.textContent = currentCall.transcript || PLACEHOLDER;
  elements.copy.disabled = !currentCall.transcript;
}

function persistCalls() {
  clearTimeout(persistenceTimer);
  persistenceTimer = setTimeout(() => {
    chrome.storage.local.set({ calls: calls.slice(0, MAX_CALLS) });
  }, 250);
}

function updateTranscript(itemId, event, text) {
  if (!currentCall || typeof text !== "string") return;

  const segment = segments.get(itemId) ?? { text: "", completed: false };
  if (event === "delta") {
    segment.text += text;
  } else {
    segment.text = text;
    segment.completed = true;
  }
  segments.set(itemId, segment);

  currentCall.transcript = [...segments.values()]
    .map((part) => part.text)
    .filter(Boolean)
    .join("\n")
    .slice(0, MAX_TRANSCRIPT_LENGTH);
  renderCurrentCall();
  persistCalls();
}

function stopTracks() {
  if (workletNode) {
    workletNode.port.onmessage = null;
    workletNode.disconnect();
    workletNode = null;
  }
  if (mediaStream) {
    for (const track of mediaStream.getTracks()) track.stop();
    mediaStream = null;
  }
  if (microphoneStream) {
    for (const track of microphoneStream.getTracks()) track.stop();
    microphoneStream = null;
  }
  if (audioContext && audioContext.state !== "closed") {
    audioContext.close();
  }
  audioContext = null;
}

function finishUi(message = "Stopped") {
  stopTracks();
  queuedAudio = [];
  socket = null;
  bridgeReady = false;
  pendingStop = false;
  currentCall = null;
  segments = new Map();
  elements.start.disabled = false;
  elements.stop.disabled = true;
  setStatus(message);
  renderCurrentCall();
  renderHistory();
}

function sendAudio(data) {
  if (socket?.readyState !== WebSocket.OPEN) return;
  const pcm = new Int16Array(data);
  let sumSquares = 0;
  for (const sample of pcm) {
    const normalized = sample / 32768;
    sumSquares += normalized * normalized;
  }
  const rms = Math.sqrt(sumSquares / pcm.length);

  const speechDetected = rms >= SPEECH_RMS_THRESHOLD;
  if (speechDetected) {
    hasPendingSpeech = true;
    lastSpeechAt = Date.now();
  } else if (!hasPendingSpeech) {
    return;
  }

  const bytes = new Uint8Array(data);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  socket.send(JSON.stringify({ type: "audio", data: btoa(binary) }));

  if (!speechDetected && hasPendingSpeech && Date.now() - lastSpeechAt >= SILENCE_COMMIT_MS) {
    socket.send(JSON.stringify({ type: "commit" }));
    hasPendingSpeech = false;
  }
}

function onPcmMessage({ data }) {
  if (data.type === "pcm") {
    if (bridgeReady && socket?.readyState === WebSocket.OPEN && !pendingStop) {
      sendAudio(data.data);
      return;
    }
    if (queuedAudio.length >= 30) queuedAudio.shift();
    queuedAudio.push(data.data);
  }

  if (data.type === "flushed") {
    stopTracks();
    if (bridgeReady && socket?.readyState === WebSocket.OPEN) {
      for (const chunk of queuedAudio) sendAudio(chunk);
      queuedAudio = [];
      if (hasPendingSpeech) socket.send(JSON.stringify({ type: "commit" }));
      socket.send(JSON.stringify({ type: "stop" }));
      setStatus("Finalizing transcript…", "pending");
    } else if (socket?.readyState === WebSocket.OPEN) {
      pendingStop = true;
      setStatus("Finishing connection…", "pending");
    } else {
      finishUi("Stopped");
    }
  }
}

async function beginCapture(microphonePromise) {
  try {
    microphoneStream = await microphonePromise;
  } catch (error) {
    if (error instanceof Error && error.name === "NotAllowedError") {
      throw new Error(
        "Microphone permission was dismissed or blocked. Click Start listening again and choose Allow in Chrome. If no prompt appears, allow microphone access for Chrome in macOS System Settings > Privacy & Security > Microphone, then retry.",
      );
    }
    throw error;
  }
  if (!microphoneStream.getAudioTracks().length) {
    throw new Error("Chrome did not provide microphone audio.");
  }

  const { invokedPhoneTabId } = await chrome.storage.session.get("invokedPhoneTabId");
  if (!Number.isInteger(invokedPhoneTabId)) {
    throw new Error(
      "No tab was selected for capture. Switch to the Uleadz phone tab, click the Uleadz Call Listener toolbar icon there, then click Start listening.",
    );
  }

  const activeTab = await chrome.tabs.get(invokedPhoneTabId);
  if (!activeTab?.url) {
    throw new Error(
      "Chrome could not verify the selected tab. Switch to the Uleadz phone tab, click the Uleadz Call Listener toolbar icon there, then click Start listening.",
    );
  }

  const activeUrl = new URL(activeTab.url);
  const isPhoneTab =
    activeUrl.protocol === "https:" &&
    ["phone.uleadz.com", "phone.uleads.com"].includes(activeUrl.hostname);
  const isLocalTestTab =
    activeUrl.protocol === "http:" &&
    activeUrl.host === "127.0.0.1:4317" &&
    activeUrl.pathname === "/test-audio";
  if (!isPhoneTab && !isLocalTestTab) {
    throw new Error(
      `For safety, listening is available only on the Uleadz phone page (phone.uleadz.com or phone.uleads.com) or the local test page. The selected tab is ${activeUrl.hostname || "not a web page"}. Switch to the phone page, click the Uleadz Call Listener toolbar icon in that tab, then click Start listening.`,
    );
  }

  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: invokedPhoneTabId,
    });
  } catch (error) {
    throw new Error(
      `Chrome denied access to the phone tab. Click the extension toolbar icon while the phone tab is active, then reopen the side panel and try again. ${error instanceof Error ? error.message : ""}`.trim(),
    );
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });
  if (!stream.getAudioTracks().length) {
    for (const track of stream.getTracks()) track.stop();
    throw new Error("Chrome did not provide audio from the Uleadz phone tab.");
  }

  mediaStream = stream;
  audioContext = new AudioContext({ sampleRate: 24_000 });
  await audioContext.audioWorklet.addModule("pcm-worklet.js");

  const source = audioContext.createMediaStreamSource(stream);
  workletNode = new AudioWorkletNode(audioContext, "pcm-encoder", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: "explicit",
  });
  workletNode.port.onmessage = onPcmMessage;

  const tabGain = audioContext.createGain();
  tabGain.gain.value = 0.7;
  const microphoneGain = audioContext.createGain();
  microphoneGain.gain.value = 0.7;
  const mute = audioContext.createGain();
  mute.gain.value = 0;

  source.connect(audioContext.destination);
  source.connect(tabGain);
  tabGain.connect(workletNode);
  const microphoneSource = audioContext.createMediaStreamSource(microphoneStream);
  microphoneSource.connect(microphoneGain);
  microphoneGain.connect(workletNode);
  workletNode.connect(mute);
  mute.connect(audioContext.destination);
  await audioContext.resume();
}

function handleSocketMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw.data);
  } catch {
    showError("The transcription helper returned an invalid response.");
    return;
  }

  if (message.type === "ready") {
    bridgeReady = true;
    for (const chunk of queuedAudio) sendAudio(chunk);
    queuedAudio = [];
    if (pendingStop) {
      pendingStop = false;
      if (hasPendingSpeech) socket.send(JSON.stringify({ type: "commit" }));
      socket.send(JSON.stringify({ type: "stop" }));
      setStatus("Finalizing transcript…", "pending");
      return;
    }
    setStatus("Listening", "active");
    return;
  }

  if (message.type === "transcript") {
    updateTranscript(message.itemId, message.event, message.text);
    return;
  }

  if (message.type === "error") {
    showError(message.message || "Transcription failed.");
    stopTracks();
    if (socket?.readyState === WebSocket.OPEN) socket.close(4001, "Transcription error");
    finishUi("Transcription error");
    return;
  }

  if (message.type === "stopped") {
    finishUi("Stopped");
  }
}

async function startListening() {
  clearError();
  const token = elements.bridgeToken.value.trim() || savedBridgeToken;
  if (!token) {
    showError("Open Connection settings and enter the local bridge token first.");
    return;
  }

  let microphonePromise;
  try {
    microphonePromise = navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
  } catch (error) {
    showError(error instanceof Error ? error.message : "Could not request microphone access.");
    return;
  }

  elements.start.disabled = true;
  elements.stop.disabled = true;
  setStatus("Starting…", "pending");
  currentCall = {
    id: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    transcript: "",
  };
  calls.unshift(currentCall);
  calls = calls.slice(0, MAX_CALLS);
  segments = new Map();
  queuedAudio = [];
  hasPendingSpeech = false;
  lastSpeechAt = 0;
  bridgeReady = false;
  pendingStop = false;
  renderCurrentCall();
  renderHistory();
  persistCalls();

  try {
    await beginCapture(microphonePromise);
    elements.stop.disabled = false;
    socket = new WebSocket("ws://127.0.0.1:4317/transcribe");
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "start", token }));
      setStatus("Connecting to transcription…", "pending");
    });
    socket.addEventListener("message", handleSocketMessage);
    socket.addEventListener("error", () => {
      setStatus("Connection failed; waiting for details…", "pending");
    });
    socket.addEventListener("close", (event) => {
      if (currentCall) {
        if (event.code === 1008) {
          showError(
            "The local helper rejected the connection. Check that the bridge token in Connection settings exactly matches BRIDGE_TOKEN in bridge/.env, then restart npm start.",
          );
        } else if (event.code === 1011) {
          showError(
            "The transcription service closed the connection. Check the helper's Terminal output and verify the Groq API key and transcription quota.",
          );
        } else if (event.code !== 1000) {
          const reason = event.reason ? ` (${event.reason})` : "";
          showError(
            `The connection closed unexpectedly (code ${event.code}${reason}). Check that the local helper is still running.`,
          );
        }
        finishUi(event.code === 1000 ? "Stopped" : "Disconnected");
      }
    });
  } catch (error) {
    if (currentCall) {
      calls = calls.filter((call) => call.id !== currentCall.id);
      persistCalls();
    }
    finishUi("Ready");
    showError(
      error instanceof Error
        ? error.message
        : "Could not start phone-tab and microphone audio capture.",
    );
  }
}

function stopListening() {
  if (!currentCall) return;
  elements.stop.disabled = true;
  setStatus("Stopping…", "pending");

  if (workletNode) {
    workletNode.port.postMessage({ type: "flush" });
    setTimeout(() => {
      if (currentCall && workletNode) onPcmMessage({ data: { type: "flushed" } });
    }, 400);
    return;
  }

  if (socket?.readyState === WebSocket.OPEN) {
    pendingStop = true;
    setStatus("Finishing connection…", "pending");
  } else {
    finishUi();
  }
}

elements.saveToken.addEventListener("click", async () => {
  const token = elements.bridgeToken.value.trim();
  if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) {
    showError("Use an alphanumeric bridge token with at least 32 characters.");
    return;
  }
  await chrome.storage.local.set({ bridgeToken: token });
  await updateTokenFingerprint(token);
  clearError();
  elements.saveToken.textContent = "Saved";
  setTimeout(() => {
    elements.saveToken.textContent = "Save token";
  }, 1200);
});

elements.start.addEventListener("click", startListening);
elements.stop.addEventListener("click", stopListening);

elements.copy.addEventListener("click", async () => {
  if (currentCall?.transcript) {
    try {
      await navigator.clipboard.writeText(currentCall.transcript);
      clearError();
      elements.copy.textContent = "Copied";
      setTimeout(() => {
        elements.copy.textContent = "Copy";
      }, 1200);
    } catch {
      showError("Could not access the clipboard. Select the transcript and copy it manually.");
    }
  }
});

elements.clearHistory.addEventListener("click", async () => {
  if (currentCall) {
    showError("Stop listening before clearing call history.");
    return;
  }
  clearTimeout(persistenceTimer);
  calls = [];
  await chrome.storage.local.remove("calls");
  elements.historyStatus.textContent = "";
  renderCurrentCall();
  renderHistory();
});

async function initialize() {
  const stored = await chrome.storage.local.get(["bridgeToken", "calls"]);
  savedBridgeToken = stored.bridgeToken ?? "";
  elements.bridgeToken.value = savedBridgeToken;
  await updateTokenFingerprint(savedBridgeToken);
  calls = Array.isArray(stored.calls) ? stored.calls.slice(0, MAX_CALLS) : [];
  renderCurrentCall();
  renderHistory();
}

initialize();
