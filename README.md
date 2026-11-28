# Uleadz Call Listener

I built Uleadz Call Listener as a local prototype. It's a Chrome extension and a small Node.js helper. When you select a supported phone tab, it captures that tab and your microphone, sends short audio clips to Groq for transcription, and saves recent transcripts in Chrome.

It does not place calls, create jobs, or write anything back to Uleadz.

> **Independent prototype:** This project is not an official Uleadz product. Use only with permission and informed consent from everyone whose audio may be processed.

## Features

- Click the extension in the toolbar to choose which supported phone tab to capture.
- Audio is sent to a helper running on your computer, then transcribed by Groq.
- The extension and helper use a token to check that they're allowed to connect.
- Transcripts are saved in this Chrome profile. The extension keeps up to 20 sessions and lets you clear them.
- Download an individual completed transcript as a `.txt` plain-text file.
- A synthetic local audio page provides a no-call smoke test.

## Architecture

```text
Chrome side panel
  ├─ captures the selected phone tab and your microphone
  └─ sends short audio clips to a helper running on your computer
       └─ the helper sends them to Groq for transcription
```

The transcript combines both audio sources, so it may be hard to tell who said what.

## Privacy and limitations

- The extension captures both the selected tab and your microphone. Chrome will ask for microphone permission. Both audio sources are sent to Groq in short clips.
- Audio leaves your computer for transcription. The helper does not save audio or transcripts, but transcripts stay in Chrome until you clear them. Up to 20 sessions are kept.
- Check Groq's current privacy, pricing, and usage limits before using the service.
- Clearing the extension's history does not remove transcript files you've downloaded.
- Transcripts appear after short pauses, not as you speak. Check them for mistakes before using them.
- There are no user accounts or speaker labels, and the app won't fill in job details for you.

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
