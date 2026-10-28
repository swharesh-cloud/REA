# Lecture Notes

Record a lecture in your browser and get a transcript plus study notes. The
default setup is free and stays on your Mac: Whisper transcribes the audio,
and Ollama writes the notes. You do not need a Vercel account, an API key, or
a credit card.

On this Mac, open `http://localhost:3000`. The microphone works on that
address. An iPhone is different; see below.

## Install once

You need Homebrew and Node.js 22 or newer. The same two commands work on an
Apple Silicon iMac and an Intel iMac.

```bash
brew install whisper.cpp ollama node
```

`whisper.cpp` installs the `whisper-cli` program. Homebrew uses the Mac's
graphics chip automatically on Apple Silicon. On Intel it uses the CPU. You
do not pick a different install.

## Start

From this folder:

```bash
./start.sh
```

The first run downloads two files, then builds the app and opens the server:

- Whisper `base.en`, about 150 MB. English speech, small and fast.
- Ollama `llama3.2`, about 2 GB. Fits an 8 GB iMac next to the browser.

Later runs skip the downloads. Then open `http://localhost:3000`.

Press **Start**, allow the microphone, and talk. A transcript piece arrives
about every 20 seconds. Notes show up after the first useful piece, then
refresh about once a minute. **Pause**, **Stop**, **Upload audio**, **Copy
Markdown**, and **Export .md** are on the page. Past lectures stay in this
browser only. The recording itself is not saved.

**View sample** shows the layout without running Whisper or Ollama.

You can also use `npm run build && npm start` after the models are already
downloaded. `./start.sh` is the one-command path.

## Which models, and how fast

These speeds are typical for this kind of Mac. They are not a benchmark from
this project. The first transcription after a restart can take longer while
macOS prepares the program. Later pieces are the numbers below.

| Mac                                    | Whisper              | A 20-second piece                                                         | Notes model                           | Notes refresh           |
| -------------------------------------- | -------------------- | ------------------------------------------------------------------------- | ------------------------------------- | ----------------------- |
| Apple Silicon iMac (M1 or newer), 8 GB | `base.en` (default)  | often about a second                                                      | `llama3.2` (default, 3B, ~2 GB)       | often 10–40 seconds     |
| Apple Silicon iMac, 16 GB              | `small.en` (~500 MB) | often a few seconds                                                       | `qwen2.5:7b` or `llama3.1:8b` (~5 GB) | slower, clearer notes   |
| Intel iMac                             | stay on `base.en`    | several seconds, sometimes about as long as the audio on an older machine | stay on `llama3.2`                    | can be a minute or more |

If pieces pile up, use a smaller Whisper file, `ggml-tiny.en.bin` (about 75 MB).
Download it the same way as base and set `WHISPER_MODEL` to that path.

To switch models, put this in `.env.local` and start again:

```bash
WHISPER_MODEL=./models/ggml-small.en.bin
OLLAMA_MODEL=qwen2.5:7b
```

`./start.sh` downloads an Ollama model the first time that name is missing.
For a Whisper file other than `base.en`, download it yourself from
[ggerganov/whisper.cpp on Hugging Face](https://huggingface.co/ggerganov/whisper.cpp/tree/main).

## Use it from an iPhone

The phone's browser only allows the microphone on HTTPS, or on the phone's own
`localhost`. `http://192.168.x.x:3000` will load the page and then refuse the
mic.

On the Mac, `http://localhost:3000` is enough.

To open the recorder on a phone, add HTTPS with either of these:

Cloudflare's quick tunnel (public URL, fine for a study session):

```bash
brew install cloudflared
cloudflared tunnel --url http://localhost:3000
```

Open the `https://....trycloudflare.com` link on the phone.

Tailscale (stays on your own machines): install Tailscale on the Mac and the
phone, sign in, then on the Mac run `tailscale serve 3000`. Open the HTTPS
address Tailscale prints.

Stop the tunnel when class is over.

## Optional: OpenAI instead of local models

Leave the defaults if you want the free path. To pay OpenAI instead, copy
`.env.example` to `.env.local` and set:

```bash
TRANSCRIBE_PROVIDER=openai
NOTES_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_TRANSCRIBE_MODEL=whisper-1
OPENAI_NOTES_MODEL=gpt-4o-mini
```

You can mix them. Local Whisper plus OpenAI notes, or the other way around,
is fine. The key stays on the Mac. The browser never sees it.

Prices below are from OpenAI's pricing page on 28 Oct 2026. Check
https://developers.openai.com/api/docs/pricing before a long lecture.

- `whisper-1` transcription: **$0.006 per minute, about $0.36 per hour** of audio.
- `gpt-4o-mini-transcribe`: about **$0.003 per minute, about $0.18 per hour**.
  OpenAI plans to remove `whisper-1` and the GPT-4o transcription models on
  26 Feb 2027. `gpt-transcribe` is the newer file model at **$0.0045 per minute,
  about $0.27 per hour**.
- Notes with `gpt-4o-mini` ($0.15 / 1M input tokens, $0.60 / 1M output tokens):
  refreshing about every 75 seconds for a one-hour lecture is roughly
  **$0.05–$0.15**. One note pass at the end is usually a few cents.
- The optional OpenAI route together is about **$0.40–$0.55 per hour** with
  `whisper-1`, or less with `gpt-4o-mini-transcribe`.

The local route does not call OpenAI. Software is free. You pay for electricity.

## Environment variables

| Variable                  | Default                     | What it does                      |
| ------------------------- | --------------------------- | --------------------------------- |
| `TRANSCRIBE_PROVIDER`     | `local`                     | `local` (whisper.cpp) or `openai` |
| `NOTES_PROVIDER`          | `ollama`                    | `ollama` or `openai`              |
| `WHISPER_BIN`             | `whisper-cli`               | Whisper program on your PATH      |
| `WHISPER_MODEL`           | `./models/ggml-base.en.bin` | Path to the `.bin` model file     |
| `OLLAMA_BASE_URL`         | `http://127.0.0.1:11434/v1` | Ollama's OpenAI-compatible API    |
| `OLLAMA_MODEL`            | `llama3.2`                  | Model name from `ollama list`     |
| `OPENAI_API_KEY`          | empty                       | Only for `openai` providers       |
| `OPENAI_TRANSCRIBE_MODEL` | `whisper-1`                 | OpenAI transcription model        |
| `OPENAI_NOTES_MODEL`      | `gpt-4o-mini`               | OpenAI notes model                |

## Optional Docker image

The free path is `./start.sh` on the Mac, because Whisper and Ollama run
beside the app. The Dockerfile only builds the website. For OpenAI inside the
container, pass `OPENAI_API_KEY` and set both providers to `openai`. For
Ollama on the Mac, set `OLLAMA_BASE_URL=http://host.docker.internal:11434/v1`.

## Develop

```bash
npm install
npm test
npm run dev
```
