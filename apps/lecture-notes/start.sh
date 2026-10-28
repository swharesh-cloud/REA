#!/usr/bin/env bash
# One command after Homebrew: ./start.sh
# Downloads the free models when they are missing, then builds and starts the app.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Install Node.js 22 or newer from https://nodejs.org and run this again."
  exit 1
fi

if [[ -f .env.local ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env.local
  set +a
fi

TRANSCRIBE_PROVIDER="${TRANSCRIBE_PROVIDER:-local}"
NOTES_PROVIDER="${NOTES_PROVIDER:-ollama}"
WHISPER_MODEL="${WHISPER_MODEL:-$PWD/models/ggml-base.en.bin}"
OLLAMA_MODEL="${OLLAMA_MODEL:-llama3.2}"
export TRANSCRIBE_PROVIDER NOTES_PROVIDER WHISPER_MODEL OLLAMA_MODEL

if [[ "$TRANSCRIBE_PROVIDER" == "local" ]]; then
  if ! command -v whisper-cli >/dev/null 2>&1 && ! command -v "${WHISPER_BIN:-whisper-cli}" >/dev/null 2>&1; then
    echo "Whisper is not installed."
    echo "On a Mac, Apple Silicon or Intel: brew install whisper.cpp"
    exit 1
  fi
  if [[ ! -f "$WHISPER_MODEL" ]]; then
    mkdir -p "$(dirname "$WHISPER_MODEL")"
    echo "Downloading the English Whisper base model (about 150 MB)..."
    curl -L --fail --progress-bar \
      -o "$WHISPER_MODEL" \
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin"
  fi
fi

if [[ "$NOTES_PROVIDER" == "ollama" ]]; then
  if ! command -v ollama >/dev/null 2>&1; then
    echo "Ollama is not installed."
    echo "On a Mac, Apple Silicon or Intel: brew install ollama"
    exit 1
  fi
  if ! curl -sf "http://127.0.0.1:11434/api/tags" >/dev/null; then
    echo "Starting Ollama..."
    ollama serve >/tmp/lecture-notes-ollama.log 2>&1 &
    ready=0
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
      if curl -sf "http://127.0.0.1:11434/api/tags" >/dev/null; then
        ready=1
        break
      fi
      sleep 0.5
    done
    if [[ "$ready" -ne 1 ]]; then
      echo "Ollama did not start. See /tmp/lecture-notes-ollama.log"
      exit 1
    fi
  fi
  if ! ollama list | grep -q "$OLLAMA_MODEL"; then
    echo "Downloading Ollama model ${OLLAMA_MODEL} (llama3.2 is about 2 GB)."
    ollama pull "$OLLAMA_MODEL"
  fi
fi

if [[ ! -d node_modules ]]; then
  npm install
fi

npm run build
echo
echo "Lecture Notes is starting at http://localhost:3000"
echo "On this Mac, that address can use the microphone."
echo "An iPhone needs HTTPS. See the README for a Cloudflare tunnel or Tailscale."
echo
exec npm start
