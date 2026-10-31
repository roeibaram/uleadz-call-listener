import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocket } from "ws";
import {
  createWavBuffer,
  createBridgeServer,
  getTokenFingerprint,
  isValidBase64Audio,
  transcribeWithGroq,
} from "../src/server.js";

const extensionId = "abcdefghijklmnopabcdefghijklmnop";

async function startTestServer() {
  const server = createBridgeServer({
    groqApiKey: "not-used-by-these-tests",
    extensionId,
    bridgeToken: "a".repeat(64),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}

async function stopTestServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("accepts small valid base64 audio chunks", () => {
  assert.equal(isValidBase64Audio(Buffer.from([0, 1, 2, 255]).toString("base64")), true);
});

test("rejects malformed, empty, and oversized audio chunks", () => {
  assert.equal(isValidBase64Audio(""), false);
  assert.equal(isValidBase64Audio("not base64"), false);
  assert.equal(isValidBase64Audio("abc"), false);
  assert.equal(isValidBase64Audio("A".repeat(32_772)), false);
});

test("creates a short stable token fingerprint without exposing the token", () => {
  const token = "a".repeat(64);
  const fingerprint = getTokenFingerprint(token);
  assert.match(fingerprint, /^[a-f0-9]{12}$/);
  assert.equal(getTokenFingerprint(token), fingerprint);
  assert.notEqual(getTokenFingerprint(token), token);
});

test("encodes 24 kHz mono PCM as a valid WAV file", () => {
  const pcm = Buffer.from([1, 2, 3, 4]);
  const wav = createWavBuffer(pcm);

  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(4), 40);
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 24_000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.deepEqual(wav.subarray(44), pcm);
});

test("posts WAV chunks to Groq Whisper and returns transcription text", async () => {
  const pcm = Buffer.alloc(24_000 * 2);
  let requestUrl;
  let requestOptions;
  const text = await transcribeWithGroq(pcm, "test-groq-key", async (url, options) => {
    requestUrl = url;
    requestOptions = options;
    return new Response(JSON.stringify({ text: "Car lockout at 123 Main Street." }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  assert.equal(requestUrl, "https://api.groq.com/openai/v1/audio/transcriptions");
  assert.equal(requestOptions.method, "POST");
  assert.equal(requestOptions.headers.Authorization, "Bearer test-groq-key");
  assert.equal(requestOptions.body.get("model"), "whisper-large-v3-turbo");
  assert.equal(requestOptions.body.get("response_format"), "json");
  assert.equal(requestOptions.body.get("temperature"), "0");
  assert.equal(requestOptions.body.get("file").type, "audio/wav");
  assert.equal(text, "Car lockout at 123 Main Street.");
});

test("reports Groq API errors with status and provider message", async () => {
  await assert.rejects(
    transcribeWithGroq(Buffer.alloc(2), "test-groq-key", async () =>
      new Response(JSON.stringify({ error: { message: "rate limit exceeded" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
    ),
    /Groq transcription request failed \(HTTP 429\): rate limit exceeded/,
  );
});

test("serves a local health check", async () => {
  const server = await startTestServer();
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  } finally {
    await stopTestServer(server);
  }
});

test("serves a local synthetic speech test page and audio sample", async () => {
  const server = await startTestServer();
  try {
    const address = server.address();
    const page = await fetch(`http://127.0.0.1:${address.port}/test-audio`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/);
    assert.match(await page.text(), /synthetic speech for testing transcription/i);

    const audio = await fetch(`http://127.0.0.1:${address.port}/test-audio.wav`);
    assert.equal(audio.status, 200);
    assert.match(audio.headers.get("content-type"), /audio\/wav/);
    const sample = Buffer.from(await audio.arrayBuffer());
    assert.equal(sample.toString("ascii", 0, 4), "RIFF");
    assert.equal(sample.toString("ascii", 8, 12), "WAVE");
  } finally {
    await stopTestServer(server);
  }
});

test("rejects WebSocket connections not originating from the extension", async () => {
  const server = await startTestServer();
  try {
    const address = server.address();
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/transcribe`, {
      origin: "https://example.com",
    });
    await once(socket, "error");
  } finally {
    await stopTestServer(server);
  }
});

test("explains a bridge-token mismatch before closing the extension connection", async () => {
  const server = await startTestServer();
  try {
    const address = server.address();
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/transcribe`, {
      origin: `chrome-extension://${extensionId}`,
    });
    await once(socket, "open");
    const message = once(socket, "message");
    const closed = once(socket, "close");
    socket.send(JSON.stringify({ type: "start", token: "wrong-token" }));
    const [raw] = await message;
    const response = JSON.parse(raw.toString());
    assert.equal(response.type, "error");
    assert.match(response.message, /token received from the extension does not match/i);
    const [code] = await closed;
    assert.equal(code, 1008);
  } finally {
    await stopTestServer(server);
  }
});

test("transcribes committed audio and returns a completed segment", async () => {
  const transcripts = [];
  const server = createBridgeServer({
    groqApiKey: "not-used-by-this-test",
    extensionId,
    bridgeToken: "a".repeat(64),
    transcribeAudio: async (pcm) => {
      transcripts.push(pcm);
      return "Customer needs a car lockout.";
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/transcribe`, {
      origin: `chrome-extension://${extensionId}`,
    });
    const messages = [];
    socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
    await once(socket, "open");
    const ready = once(socket, "message");
    socket.send(JSON.stringify({ type: "start", token: "a".repeat(64) }));
    await ready;
    socket.send(
      JSON.stringify({
        type: "audio",
        data: Buffer.from([1, 2, 3, 4]).toString("base64"),
      }),
    );
    const closed = once(socket, "close");
    socket.send(JSON.stringify({ type: "stop" }));
    await closed;

    assert.equal(transcripts.length, 1);
    assert.deepEqual(transcripts[0], Buffer.from([1, 2, 3, 4]));
    assert.ok(messages.some((message) => message.type === "ready"));
    assert.ok(
      messages.some(
        (message) =>
          message.type === "transcript" &&
          message.event === "completed" &&
          message.text === "Customer needs a car lockout.",
      ),
    );
  } finally {
    await stopTestServer(server);
  }
});
