import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { withRetry } from "./retry.js";

// ---------------------------------------------------------------------------
// AWS Bedrock — Claude Sonnet for Pro reasoning calls
// ---------------------------------------------------------------------------
//
// Replaces Gemini 2.5 Pro for quality-sensitive tasks (brand-fit scoring,
// outreach drafting). Flash model remains Gemini 2.5 Flash, handled in
// ai.service.ts.
// ---------------------------------------------------------------------------

let cachedClient: BedrockRuntimeClient | null = null;

function client(): BedrockRuntimeClient {
  if (cachedClient) return cachedClient;

  const region = process.env.AWS_BEDROCK_REGION ?? process.env.AWS_REGION ?? "us-east-1";
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

  // Allow IAM role / instance-profile auth by not forcing keys when absent
  cachedClient = new BedrockRuntimeClient({
    region,
    ...(accessKeyId && secretAccessKey
      ? { credentials: { accessKeyId, secretAccessKey, sessionToken: process.env.AWS_SESSION_TOKEN } }
      : {}),
  });
  return cachedClient;
}

export interface BedrockClaudeOptions {
  systemPrompt: string;
  userPrompt: string;
  temperature: number;
  maxTokens: number;
  label: string;
  /** Optional override of the default Sonnet inference profile / model ID. */
  modelOverride?: string;
}

/**
 * Invokes Claude Sonnet on AWS Bedrock using the Messages API and returns
 * the raw text response. The caller is expected to parse JSON where
 * required.
 */
export async function callClaudeSonnet(opts: BedrockClaudeOptions): Promise<string> {
  const modelId =
    opts.modelOverride ??
    process.env.BEDROCK_SONNET_MODEL_ID ??
    "anthropic.claude-sonnet-4-5-20250929-v1:0";

  const body = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
    system: opts.systemPrompt,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: opts.userPrompt }],
      },
    ],
  };

  return withRetry(
    async () => {
      const cmd = new InvokeModelCommand({
        modelId,
        contentType: "application/json",
        accept: "application/json",
        body: Buffer.from(JSON.stringify(body)),
      });

      const response = await client().send(cmd);
      const decoded = Buffer.from(response.body as Uint8Array).toString("utf-8");

      let parsed: { content?: Array<{ type: string; text?: string }>; stop_reason?: string };
      try {
        parsed = JSON.parse(decoded);
      } catch (err) {
        throw new Error(`Bedrock returned non-JSON for ${opts.label}: ${decoded.slice(0, 300)}`);
      }

      const textParts = (parsed.content ?? [])
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text as string);

      const text = textParts.join("").trim();
      if (!text) {
        throw new Error(
          `Bedrock returned empty content for ${opts.label} (stop_reason=${parsed.stop_reason ?? "?"})`
        );
      }

      return text;
    },
    opts.label,
    { maxAttempts: 3, baseDelayMs: 2000 }
  );
}

/**
 * Convenience wrapper: call Sonnet and parse the response as JSON, stripping
 * any markdown code fences the model may emit.
 */
export async function callClaudeSonnetJson<T>(opts: BedrockClaudeOptions): Promise<T> {
  const raw = await callClaudeSonnet(opts);
  const cleaned = raw
    .replace(/^```(?:json)?\n?/g, "")
    .replace(/\n?```$/g, "")
    .trim();

  try {
    return JSON.parse(cleaned) as T;
  } catch (err) {
    throw new Error(
      `Claude Sonnet returned unparseable JSON for ${opts.label}.\n` +
        `Raw (first 500): ${raw.slice(0, 500)}\nError: ${err}`
    );
  }
}
