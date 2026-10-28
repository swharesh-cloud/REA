# Lecture Notes

A separate Next.js app for live lecture notes. It records in the browser,
transcribes short audio pieces, and asks a language model for organized notes.
It does not use REA's analysis tools, and REA's CLI and MCP server are unchanged.

The recorder keeps a microphone stream open, slices it into about 20 seconds of
16 kHz mono WAV, and sends each piece to the server. Notes refresh after the
first useful transcript and then no more than once every 75 seconds, plus once
when you stop. Sessions (title, transcript, notes, duration) stay in
`localStorage` on this device. The audio itself is not saved.

## What you need

- Node.js 22 or newer
- A [Vercel](https://vercel.com) account with [AI Gateway](https://vercel.com/docs/ai-gateway) credits
- An AI Gateway API key for local development

Transcription and notes are billed to that Vercel team. Nothing in the browser
holds a provider key.

## Environment variables

Copy the example file and fill in the key:

```bash
cd apps/lecture-notes
cp .env.example .env.local
```

| Variable                   | Required  | Purpose                                                           |
| -------------------------- | --------- | ----------------------------------------------------------------- |
| `AI_GATEWAY_API_KEY`       | Local dev | AI Gateway API key. Create it under Team → AI Gateway → API Keys. |
| `LECTURE_TRANSCRIBE_MODEL` | No        | Transcription model ID. Default `openai/whisper-1`.               |
| `LECTURE_NOTES_MODEL`      | No        | Notes model ID. Default `google/gemini-3-flash`.                  |

On Vercel, a deployment can authenticate with OIDC instead of
`AI_GATEWAY_API_KEY`. Vercel injects that token for the project. If an API key
is set, the AI SDK uses the key and ignores OIDC. Do not commit `.env.local`
or any real key.

Model IDs come from the live catalog, `https://ai-gateway.vercel.sh/v1/models`.
The defaults below were checked against that catalog on 28 Oct 2026.

## Local run

```bash
cd apps/lecture-notes
npm install
npm run dev
```

Open `http://localhost:3000`. Allow the microphone when the browser asks. Use
**View sample**, or open `/?sample=1`, to inspect the notes layout without
spending credits.

```bash
npm test
npm run build
```

## Deploy on Vercel

1. Import `swharesh-cloud/REA` as a Vercel project.
2. Set **Root Directory** to `apps/lecture-notes`.
3. Leave the framework preset as Next.js. The install and build commands are
   `npm install` and `npm run build`.
4. Add `AI_GATEWAY_API_KEY`, or leave it unset and rely on Vercel OIDC for a
   team that has AI Gateway enabled.
5. Optionally set `LECTURE_TRANSCRIBE_MODEL` and `LECTURE_NOTES_MODEL`.
6. Deploy. The site must be served from the domain root. The audio worklet is
   loaded from `/pcm-capture-worklet.js`.

iPhone Safari and desktop browsers need HTTPS, which Vercel provides. The mic
button has to be a tap, not an automatic start. iOS can interrupt capture when
the page is backgrounded; the app pauses and waits for **Resume**. A screen
wake lock is requested when the browser allows it.

## Recording and upload

- **Start**, **Pause** / **Resume**, and **Stop**, with a running timer.
- Live transcript from ~20 second pieces. Silence is not sent.
- **Upload audio** for an existing file.
  - Files up to 3.5 MB (except WAV) are sent once.
  - MP3 files up to 24 MB are split on MP3 frames in the browser.
  - Other formats up to 8 MB are decoded and sliced into 20 second WAV pieces.
  - Larger files are refused. Record those in the app so the tab never holds
    the whole lecture.
- Each server request stays under Vercel's ~4.5 MB request-body limit.
- Notes include a title, summary, key points, headed bullets, terms, action
  items, and review questions. Timestamp buttons jump to the nearest transcript
  line.
- **Copy Markdown** and **Export .md**. The library lists saved lectures.

## Cost

Prices are AI Gateway catalog rates observed on 28 Oct 2026. They change.
Confirm them on the model page before a long lecture. Vercel hosting is billed
separately from AI Gateway credits. A Hobby account includes a free hosting
allowance; function time and bandwidth follow the current plan.

### Transcription, per hour of audio

| Model                        | Catalog rate          | About one hour |
| ---------------------------- | --------------------- | -------------- |
| `openai/whisper-1` (default) | $0.0001 / second      | **$0.36**      |
| `openai/gpt-transcribe`      | $0.000075 / second    | $0.27          |
| `elevenlabs/scribe-v2`       | $0.000030556 / second | $0.11          |
| `microsoft/mai-transcribe-2` | $0.00002778 / second  | $0.10          |

Set `LECTURE_TRANSCRIBE_MODEL` to switch. This app sends WAV for live capture
and for decoded uploads, which Microsoft's batch transcriber accepts. Some
token-priced models (for example `openai/gpt-4o-mini-transcribe`) bill audio
tokens instead of duration, so their hourly cost depends on that tokenizer.

### Notes, per hour of lecture

Default model: `google/gemini-3-flash` at low reasoning effort.

- Input about $0.50 / 1M tokens, output about $3 / 1M tokens.
- A spoken hour is roughly 8,000–12,000 words. Rebuilding notes on the 75
  second cadence is on the order of a few hundred thousand input tokens and
  under about 80,000 output tokens.
- That is roughly **$0.15–$0.40** for notes for one recorded hour.
- One note pass at the end, if you do not leave live refresh running, is
  usually a few cents.
- **Update notes** spends one extra call.

### Together

With the defaults, plan on about **$0.50–$0.80 per hour** of audio, mostly
Whisper plus repeated note updates. An uploaded hour costs about the same as
recording it, because the same models run. AI Gateway credits are the bill;
the app does not add a markup.
