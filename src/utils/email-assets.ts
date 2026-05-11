// src/utils/email-assets.ts
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const ASSETS_DIR = resolve(process.cwd(), "assets/email");

// Inline logo (referenced via cid: in the footer)
export const LOGO_FILENAME = "logo-begility.png";
export const LOGO_CID = "begility-logo";          // any unique token; must match cid: in template
export const LOGO_CONTENT_TYPE = "image/png";

// PDF attached to every outbound email
export const PDF_FILENAME = "begility-overview.pdf";
export const PDF_CONTENT_TYPE = "application/pdf";

// Graph caps inline-attachment payloads at ~3 MB. Above that we'd need an upload session.
const INLINE_LIMIT_BYTES = 3 * 1024 * 1024;

function loadAsBase64(filename: string, label: string): string {
  const path = resolve(ASSETS_DIR, filename);
  const size = statSync(path).size;
  if (size > INLINE_LIMIT_BYTES) {
    throw new Error(
      `${label} (${filename}) is ${(size / 1024 / 1024).toFixed(2)} MB — exceeds 3 MB inline limit. ` +
      `Use a Graph upload session or compress the file.`
    );
  }
  return readFileSync(path).toString("base64");
}

export const logoBase64 = loadAsBase64(LOGO_FILENAME, "Email logo");
export const pdfBase64  = loadAsBase64(PDF_FILENAME, "Email PDF attachment");
