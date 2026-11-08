# Uleadz Call Listener

Uleadz Call Listener is a portfolio prototype built from a Chrome Manifest V3 extension and a local Node.js bridge. It captures audio from a manually selected Uleadz phone tab and the user's microphone, sends short mixed-audio segments to Groq Whisper, and keeps a bounded transcript history in the current Chrome profile.

The prototype demonstrates browser tab capture, audio processing, an authenticated local WebSocket bridge, third-party speech-to-text integration, and explicit consent and data-handling boundaries. It does not write to Uleadz, create or submit jobs, or initiate calls.

> **Independent prototype:** This project is not an official Uleadz product. Use only with permission and informed consent from everyone whose audio may be processed.

## Features

- Chrome toolbar action explicitly selects the tab to capture; access is limited to the supported phone pages and local test page.
- Audio is streamed to a loopback-only Node.js helper, grouped into short speech segments, and transcribed with Groq Whisper.
- A random bridge token and extension-origin validation protect the local WebSocket connection.
- Transcripts are stored in `chrome.storage.local` in the current browser profile, with a 20-session history limit and a clear-history action.
- Download an individual completed transcript as a plain-text file when needed.
- A synthetic local audio page provides a no-call smoke test.
- The helper does not save audio or transcripts and the extension does not submit data to Uleadz.

## Architecture

```text
Chrome side panel
  ├─ selected phone-tab audio + microphone
  ├─ Web Audio worklet encodes PCM and groups speech segments
  └─ authenticated WebSocket ──> local Node.js bridge (127.0.0.1:4317)
                                    └─ HTTPS transcription request ──> Groq Whisper
```

The bridge converts PCM segments to WAV for the transcription API. The transcript combines both audio sources without speaker labels, so it may be difficult to tell who said what.

## Privacy and limitations

- The extension captures both the selected tab and the microphone. Chrome asks for microphone access; microphone audio is mixed with tab audio and sent to Groq along with each speech segment.
- Review Groq's current privacy, retention, pricing, and rate-limit terms before use. Audio leaves the device for transcription. The bridge does not persist audio or transcript data.
- Transcripts remain in this Chrome profile until cleared, and at most 20 sessions are retained.
- Transcript downloads are created only after the user selects **Download transcript**; downloaded files are outside the extension's local-history controls.
- Transcription is near-live, not word-by-word streaming. Accuracy is not guaranteed; verify transcripts before relying on them.
- This is a local prototype without user accounts, speaker diarization, job-field extraction, or Uleadz write-back.

## What goes where

- While listening is active, audio from the selected tab and your microphone is mixed, streamed to the local Node helper, and uploaded in short WAV segments to Groq's transcription API.
- The helper does not save audio or transcripts. Transcripts are saved in `chrome.storage.local` in this Chrome profile.
- Clear the local history from the extension at any time.

Use this only where you have permission and consent to process call audio. Audio segments are sent to Groq; review Groq's current privacy, retention, pricing, and rate-limit terms before use. Free-tier limits can change and are subject to your account.

## Requirements

- Google Chrome 116 or newer
- Node.js 20.6 or newer
- A Groq API key with access to speech-to-text

## 1. Set up the local transcription helper

```sh
cd bridge
npm install
cp .env.example .env
```

Create a Groq API key at [console.groq.com/keys](https://console.groq.com/keys). In `bridge/.env`, set:

1. `GROQ_API_KEY` to your Groq API key.
2. `EXTENSION_ID` to the ID shown for this extension at `chrome://extensions`.
3. `BRIDGE_TOKEN` to a random value generated with `openssl rand -hex 32`.

Keep `.env` private: it contains credentials and is excluded by `.gitignore`. Never commit or share it.

Start the helper:

```sh
npm start
```

It listens only on `127.0.0.1:4317`. Keep this Terminal window open while testing.

## 2. Load the Chrome extension

1. Open `chrome://extensions`.
2. Turn on **Developer mode** and select **Load unpacked**.
3. Choose this project's `extension` folder.
4. Copy the extension ID shown on its card into `EXTENSION_ID` in `bridge/.env`.
5. Restart the helper after editing `.env`.
6. If the extension was already loaded, click its **Reload** icon after updating project files.
7. Pin **Uleadz Call Listener** to the Chrome toolbar if needed.
8. While the Uleadz phone page is the active tab (`https://phone.uleadz.com` or `https://phone.uleads.com`), click the extension's toolbar icon. This explicit action selects that tab and grants Chrome's temporary tab-capture permission.
9. Enter the same bridge token into the side panel settings and click **Save token**.

The extension uses Chrome's temporary `activeTab` grant from the toolbar click to verify and capture only that selected tab; it does not request persistent host access to Uleadz. The local helper checks the browser extension origin and bridge token before accepting a session.

The helper prints a 12-character bridge-token fingerprint when it starts. The extension shows a fingerprint under the token field. Compare these fingerprints if authentication fails; they are safe to compare and do not reveal the token.

## 3. Test a call

1. Open your Uleadz phone page (`https://phone.uleadz.com` or `https://phone.uleads.com`) and confirm you are on the correct call.
2. With that phone tab active, click the **Uleadz Call Listener toolbar icon**. This tells Chrome which tab to capture and opens the side panel.
3. Check the consent and audio-sharing notice. The extension captures both phone-tab audio and your microphone; Chrome may prompt you to grant microphone permission.
4. Click **Start listening**. Phone-tab audio is routed back to your speakers/headphones, and microphone audio is not played back. Keep the side panel open for the duration of the call.
5. Groq Whisper transcribes audio segments after pauses; this is near-live, not word-by-word streaming. Keep listening active during the call to collect the transcript.
6. Click **Stop listening** when the call ends and review the transcript in the extension. It is not copied into a Uleadz note.

The bridge batches short pauses and uploads WAV audio to `whisper-large-v3-turbo`; it does not save audio files. Recent transcript history stays in the extension, with at most 20 sessions.

## Test without placing a call

The bridge includes a short synthetic speech sample at `http://127.0.0.1:4317/test-audio`. It does not place a phone call, but the sample is still sent to Groq and uses your account's transcription quota.

1. Start the bridge with `npm start` from the `bridge` directory.
2. Open `http://127.0.0.1:4317/test-audio` in Chrome.
3. Keep the test page active, then click the extension toolbar icon and open the side panel.
4. Click **Start listening**, grant microphone access, play the sample, and say a short test phrase if you want to verify both audio sources.
5. Review the transcript and click **Stop listening**.

The sample is synthetic and for smoke testing only. It does not validate real-call routing or transcription accuracy.

## Tests

Run the bridge tests from the project root:

```sh
npm test --prefix bridge
```

The tests cover WAV encoding, audio validation, token fingerprinting, Groq request handling, local test endpoints, and WebSocket origin/token checks.

## After restarting your computer

1. Open Terminal and start the helper:

   ```sh
   cd bridge
   npm start
   ```

2. Leave that Terminal window open while testing.
3. Open `http://127.0.0.1:4317/test-audio` for the no-call test, or open `https://phone.uleadz.com` for a real call.
4. Click the extension toolbar icon from the tab you want to capture, then click **Start listening** and allow microphone access.

You do not need to recreate `.env`, reinstall packages, or reload the extension after an ordinary computer restart. Only reload the extension after changing its source files.

## Troubleshooting

- **Wrong tab / capture permission:** The extension only captures the Uleadz phone page (`phone.uleadz.com` or `phone.uleads.com`) or the local test page. Switching tabs alone does not select a new capture target: make the phone page active, click the extension toolbar icon in that tab, then click **Start listening** in the side panel.
- **Cannot connect:** Check that the helper is running, the bridge token matches, and `EXTENSION_ID` in `.env` is the ID displayed by `chrome://extensions`.
- **Bridge token mismatch:** Compare the helper's fingerprint in Terminal to the extension fingerprint under Connection settings. If they differ, paste the token from `BRIDGE_TOKEN` into the extension again and click **Save token**. Restart `npm start` after editing `.env`.
- **Groq authentication or transcription error:** Check `GROQ_API_KEY` in `.env`, restart the helper, and verify your Groq account has access/quota for `whisper-large-v3-turbo`. Rate limits and free-tier allowances are account-dependent and may change.
- **"Permission dismissed" / microphone not captured:** The microphone permission prompt was closed or blocked, so no microphone audio was started. Click **Start listening** again and choose **Allow** if Chrome asks. If no prompt appears, open `chrome://settings/content/microphone`, check that Chrome has a microphone selected and that access is not blocked, then check macOS **System Settings > Privacy & Security > Microphone** and enable Google Chrome. Reopen the side panel and retry. If macOS permission was just changed, quit and reopen Chrome.
- **No transcript:** Confirm the call audio is audible in the active phone tab and let the call speak for a few seconds. Quiet audio is ignored, short pauses are grouped to reduce requests, and pending speech is sent when enough audio has accumulated or when you stop listening.
- **Tab audio is silent:** Stop listening and try again. Captured tab audio is routed back to the output device by the extension.
- **Before field automation:** Verify transcript accuracy on multiple calls first. Job matching, extraction into fields, and writing to Uleadz are intentionally out of scope for this stage.

Groq API references: [Speech-to-text](https://console.groq.com/docs/speech-to-text) and [rate limits](https://console.groq.com/docs/rate-limits).
