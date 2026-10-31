import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { WebSocket, WebSocketServer } from "ws";

const HOST = "127.0.0.1";
const PORT = 4317;
const MAX_AUDIO_MESSAGE_CHARS = 32_768;
const MAX_TRANSCRIPTION_AUDIO_BYTES = 25 * 1024 * 1024 - 44;
const MIN_TRANSCRIPTION_AUDIO_BYTES = 24_000 * 2 * 3;
const GROQ_TRANSCRIPTIONS_URL =
  "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_MODEL = "whisper-large-v3-turbo";
const TRANSCRIPTION_PROMPT =
  "A customer call with a locksmith. Relevant terms include car lockout, home lockout, " +
  "rekey, ignition, key fob, vehicle make and model, and service address.";
const TEST_AUDIO_PATH = new URL("../public/test-audio.wav", import.meta.url);
const TEST_AUDIO_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="referrer" content="no-referrer">
    <title>Uleadz Call Listener - Test Audio</title>
  </head>
  <body>
    <main>
      <h1>Transcription test audio</h1>
      <p>This is synthetic speech for testing transcription. It is not a real call, and it does not call anyone.</p>
      <ol>
        <li>Click the Uleadz Call Listener extension icon in Chrome's toolbar to open its side panel.</li>
        <li>Click <strong>Start listening</strong> in the side panel.</li>
        <li>Press play below and wait for the full sample to finish.</li>
        <li>Look for the test phrase in the extension transcript. Stop listening when done.</li>
      </ol>
      <audio controls preload="metadata" src="/test-audio.wav">
        Your browser does not support audio playback.
      </audio>
      <p>Expected content: a test recording, the name Alex, a blue Honda Civic lockout, and a fictional Atlanta address.</p>
    </main>
  </body>
</html>`;

export function createWavBuffer(pcm) {
  if (!Buffer.isBuffer(pcm) || pcm.length === 0 || pcm.length % 2 !== 0) {
    throw new Error("PCM audio must be a non-empty buffer of 16-bit samples.");
  }

  const wav = Buffer.alloc(44 + pcm.length);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + pcm.length, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24_000, 24);
  wav.writeUInt32LE(48_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  return wav;
}

export async function transcribeWithGroq(pcm, apiKey, fetchImpl = fetch) {
  const wav = createWavBuffer(pcm);
  const form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), "call-segment.wav");
  form.append("model", GROQ_MODEL);
  form.append("response_format", "json");
  form.append("temperature", "0");
  form.append("prompt", TRANSCRIPTION_PROMPT);

  let response;
  try {
    response = await fetchImpl(GROQ_TRANSCRIPTIONS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new Error(
      `Could not reach Groq transcription API: ${error instanceof Error ? error.message : "network request failed"}`,
    );
  }

  if (!response.ok) {
    const body = await response.text();
    let detail = body;
    try {
      const parsed = JSON.parse(body);
      detail = parsed.error?.message ?? parsed.message ?? body;
    } catch {
      detail = body;
    }
    throw new Error(`Groq transcription request failed (HTTP ${response.status}): ${detail}`);
  }

  const result = await response.json();
  if (typeof result.text !== "string") {
    throw new Error("Groq returned a transcription response without text.");
  }
  return result.text;
}

export function isValidBase64Audio(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_AUDIO_MESSAGE_CHARS &&
    value.length % 4 === 0 &&
    /^[A-Za-z0-9+/]*={0,2}$/.test(value)
  );
}

export function getTokenFingerprint(token) {
  return createHash("sha256").update(token, "utf8").digest("hex").slice(0, 12);
}

function tokensMatch(supplied, expected) {
  if (typeof supplied !== "string") {
    return false;
  }

  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  if (suppliedBytes.length !== expectedBytes.length) return false;

  return timingSafeEqual(suppliedBytes, expectedBytes);
}

function sendJson(socket, message) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function createTranscriptionSession(client, transcribeAudio) {
  let audioParts = [];
  let audioBytes = 0;
  let segmentNumber = 0;
  let failed = false;
  let stopping = false;
  let queue = Promise.resolve();

  const flushAudio = ({ force = false } = {}) => {
    if (audioBytes === 0 || (!force && audioBytes < MIN_TRANSCRIPTION_AUDIO_BYTES)) {
      return queue;
    }

    const pcm = Buffer.concat(audioParts, audioBytes);
    audioParts = [];
    audioBytes = 0;
    const itemId = `segment-${++segmentNumber}`;

    queue = queue.then(async () => {
      if (failed || client.readyState !== WebSocket.OPEN) return;

      try {
        const text = await transcribeAudio(pcm);
        if (text.trim()) {
          sendJson(client, {
            type: "transcript",
            event: "completed",
            itemId,
            text: text.trim(),
          });
        }
      } catch (error) {
        failed = true;
        const message =
          error instanceof Error ? error.message : "Unknown transcription service error.";
        console.error(`Groq transcription error: ${message}`);
        sendJson(client, { type: "error", message });
        if (client.readyState === WebSocket.OPEN) {
          client.close(1011, "Groq transcription failed");
        }
      }
    });
    return queue;
  };

  const finishWhenQueued = () => {
    queue.then(() => {
      if (stopping && !failed && client.readyState === WebSocket.OPEN) {
        sendJson(client, { type: "stopped" });
        client.close(1000, "Transcription stopped");
      }
    });
  };

  sendJson(client, { type: "ready" });
  client.on("message", (raw) => {
    if (stopping || failed) return;

    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      sendJson(client, { type: "error", message: "Received an invalid extension message." });
      return;
    }

    if (message.type === "audio") {
      if (!isValidBase64Audio(message.data)) {
        sendJson(client, { type: "error", message: "Invalid audio data received from the extension." });
        client.close(1008, "Invalid audio data");
        return;
      }
      const pcm = Buffer.from(message.data, "base64");
      if (pcm.length % 2 !== 0) {
        sendJson(client, { type: "error", message: "Audio data is not valid 16-bit PCM." });
        client.close(1008, "Invalid PCM data");
        return;
      }
      if (audioBytes + pcm.length > MAX_TRANSCRIPTION_AUDIO_BYTES) {
        sendJson(client, {
          type: "error",
          message: "A speech segment exceeded Groq's 25 MB upload limit. Stop and start a new session.",
        });
        client.close(1009, "Audio segment too large");
        return;
      }
      audioParts.push(pcm);
      audioBytes += pcm.length;
      return;
    }

    if (message.type === "commit") {
      flushAudio();
      return;
    }

    if (message.type === "stop") {
      stopping = true;
      flushAudio({ force: true });
      finishWhenQueued();
    }
  });

  client.on("close", () => {
    stopping = true;
    audioParts = [];
    audioBytes = 0;
  });
}

function rejectUpgrade(socket, status, message) {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n${message}`);
  socket.destroy();
}

export function createBridgeServer({
  groqApiKey,
  extensionId,
  bridgeToken,
  transcribeAudio = (pcm) => transcribeWithGroq(pcm, groqApiKey),
}) {
  const expectedOrigin = `chrome-extension://${extensionId}`;
  const httpServer = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (request.method === "GET" && request.url === "/test-audio") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'self'; media-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
      });
      response.end(TEST_AUDIO_PAGE);
      return;
    }

    if (request.method === "GET" && request.url === "/test-audio.wav") {
      const audio = readFileSync(TEST_AUDIO_PATH);
      response.writeHead(200, {
        "content-type": "audio/wav",
        "content-length": audio.length,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      response.end(audio);
      return;
    }

    response.writeHead(404);
    response.end();
  });

  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
    perMessageDeflate: false,
  });
  let activeClient = null;

  httpServer.on("upgrade", (request, socket, head) => {
    if (request.url !== "/transcribe" || request.headers.origin !== expectedOrigin) {
      rejectUpgrade(socket, "403 Forbidden", "Forbidden");
      return;
    }

    if (activeClient && activeClient.readyState !== WebSocket.CLOSED) {
      rejectUpgrade(socket, "409 Conflict", "A transcription session is already active");
      return;
    }

    websocketServer.handleUpgrade(request, socket, head, (client) => {
      activeClient = client;
      websocketServer.emit("connection", client);
    });
  });

  websocketServer.on("connection", (client) => {
    let authenticated = false;
    const authTimeout = setTimeout(() => {
      if (!authenticated) client.close(1008, "Authentication timeout");
    }, 5_000);

    client.once("message", (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        client.send(
          JSON.stringify({
            type: "error",
            message: "The extension sent an invalid authentication message. Reload the extension and try again.",
          }),
          () => client.close(1008, "Invalid authentication message"),
        );
        return;
      }

      if (message.type !== "start") {
        client.send(
          JSON.stringify({
            type: "error",
            message: "The extension sent an invalid connection request. Reload it and try again.",
          }),
          () => client.close(1008, "Invalid connection request"),
        );
        return;
      }

      if (!tokensMatch(message.token, bridgeToken)) {
        console.warn(
          `Rejected extension connection: bridge token mismatch (helper fingerprint ${getTokenFingerprint(bridgeToken)}).`,
        );
        client.send(
          JSON.stringify({
            type: "error",
            message:
              "The bridge token received from the extension does not match the token loaded by the helper. Compare the 12-character fingerprint shown here with the helper Terminal; if they differ, paste the same token again and click Save token.",
          }),
          () => client.close(1008, "Bridge token mismatch"),
        );
        return;
      }

      authenticated = true;
      clearTimeout(authTimeout);
      createTranscriptionSession(client, transcribeAudio);
    });

    client.on("close", () => {
      clearTimeout(authTimeout);
      if (activeClient === client) activeClient = null;
    });
  });

  return httpServer;
}

function main() {
  const { GROQ_API_KEY: groqApiKey, EXTENSION_ID: extensionId, BRIDGE_TOKEN: bridgeToken } =
    process.env;

  if (!groqApiKey || !extensionId || !/^[a-p]{32}$/.test(extensionId)) {
    throw new Error("Set GROQ_API_KEY and a valid Chrome EXTENSION_ID in bridge/.env.");
  }
  if (!bridgeToken || !/^[A-Za-z0-9_-]{32,}$/.test(bridgeToken)) {
    throw new Error("Set BRIDGE_TOKEN to a random alphanumeric value of at least 32 characters.");
  }
  const server = createBridgeServer({ groqApiKey, extensionId, bridgeToken });
  server.listen(PORT, HOST, () => {
    console.log(`Uleadz transcription bridge listening on http://${HOST}:${PORT}`);
    console.log(`Bridge token fingerprint: ${getTokenFingerprint(bridgeToken)}`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
