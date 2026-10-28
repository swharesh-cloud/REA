import { localStatus } from "../../../lib/local-status";
import { readSettings } from "../../../lib/settings";

export const runtime = "nodejs";

export async function GET() {
  try {
    const settings = readSettings();
    const status = await localStatus(settings);
    return Response.json({
      transcribeProvider: settings.transcribeProvider,
      notesProvider: settings.notesProvider,
      transcribeModel:
        settings.transcribeProvider === "local"
          ? settings.whisperModel
          : settings.openaiTranscribeModel,
      notesModel:
        settings.notesProvider === "ollama"
          ? settings.ollamaModel
          : settings.openaiNotesModel,
      ready: status.ready,
      message: status.message,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Settings are invalid.";
    return Response.json({ ready: false, message }, { status: 500 });
  }
}
