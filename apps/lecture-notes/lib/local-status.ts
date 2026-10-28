import { accessSync, constants } from "node:fs";
import { spawnSync } from "node:child_process";

import type { AppSettings } from "./settings";

function commandExists(bin: string): boolean {
  if (bin.includes("/")) {
    try {
      accessSync(bin, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const result = spawnSync("which", [bin], { encoding: "utf8" });
  return result.status === 0;
}

function fileExists(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function ollamaUp(baseUrl: string): Promise<boolean> {
  const root = baseUrl.replace(/\/v1\/?$/u, "");
  try {
    const response = await fetch(`${root}/api/tags`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function localStatus(settings: AppSettings): Promise<{
  ready: boolean;
  message: string | null;
}> {
  const problems: string[] = [];
  if (settings.transcribeProvider === "local") {
    if (!commandExists(settings.whisperBin)) {
      problems.push(
        `Whisper is not installed (looking for ${settings.whisperBin}). On a Mac: brew install whisper.cpp`,
      );
    } else if (!fileExists(settings.whisperModel)) {
      problems.push(
        `Whisper model file is missing (${settings.whisperModel}). Run ./start.sh to download the small English model.`,
      );
    }
  } else if (!settings.openaiApiKey) {
    problems.push("Set OPENAI_API_KEY, or set TRANSCRIBE_PROVIDER=local.");
  }
  if (settings.notesProvider === "ollama") {
    if (!(await ollamaUp(settings.ollamaBaseUrl))) {
      problems.push(
        "Ollama is not running. On a Mac: brew install ollama, then ./start.sh",
      );
    }
  } else if (!settings.openaiApiKey) {
    problems.push("Set OPENAI_API_KEY, or set NOTES_PROVIDER=ollama.");
  }
  if (problems.length === 0) {
    const local =
      settings.transcribeProvider === "local" &&
      settings.notesProvider === "ollama";
    return {
      ready: true,
      message: local
        ? "Free on this Mac: local Whisper and Ollama. No API key."
        : null,
    };
  }
  return {
    ready: false,
    message: `${problems.join(" ")} The sample still works.`,
  };
}
