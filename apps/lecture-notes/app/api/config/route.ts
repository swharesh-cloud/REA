import { notesModel, transcribeModel } from "../../../lib/models";

export const runtime = "nodejs";

export function GET() {
  return Response.json({
    transcribeModel: transcribeModel(),
    notesModel: notesModel(),
    gatewayConfigured: Boolean(
      process.env.AI_GATEWAY_API_KEY ||
      process.env.VERCEL_OIDC_TOKEN ||
      process.env.VERCEL,
    ),
  });
}
