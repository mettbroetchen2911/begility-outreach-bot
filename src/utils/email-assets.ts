import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ASSETS_DIR = resolve(process.cwd(), "assets/email");

export const LOGO_CID = "begility-logo";
export const LOGO_FILENAME = "logo-begility.png";
export const ATTACHMENT_PDF_FILENAME = "begility-overview.pdf";

export const logoBase64 = readFileSync(resolve(ASSETS_DIR, LOGO_FILENAME)).toString("base64");
export const pdfBase64  = readFileSync(resolve(ASSETS_DIR, ATTACHMENT_PDF_FILENAME)).toString("base64");
