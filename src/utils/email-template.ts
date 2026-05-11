import { LOGO_CID } from "./email-assets.js";

export function wrapEmailInTemplate(aiGeneratedHtml: string): string {
  const senderName = process.env.SENDER_NAME;
  const senderTitle = process.env.SENDER_TITLE;
  const brandName = process.env.BRAND_NAME ?? "Begility";
  const brandDomain = (process.env.SENDER_EMAIL_DOMAIN ?? "begility.com").replace(/^https?:\/\//i, "").replace(/\/$/, "");

  // Logo is embedded as an inline CID attachment by EmailService.createDraft
  // — see src/utils/email-assets.ts and src/services/email.service.ts
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1a1a1a; font-size: 14px; line-height: 1.6; max-width: 600px;">

      <div style="margin-bottom: 30px;">
        ${aiGeneratedHtml}
      </div>

      <table cellpadding="0" cellspacing="0" border="0" style="margin-top: 30px; border-top: 1px solid #eaeaec; padding-top: 20px; width: 100%;">
        <tr>
          <td width="70" style="vertical-align: top; padding-right: 15px;">
            <img src="cid:${LOGO_CID}" alt="${brandName}" width="60" style="display: block; max-width: 60px;">
          </td>
          <td style="vertical-align: top;">
            <p style="margin: 0; font-weight: 600; font-size: 15px; color: #000;">${senderName}</p>
            <p style="margin: 2px 0 0 0; font-size: 13px; color: #555;">${senderTitle} | <strong>${brandName}</strong></p>
            <p style="margin: 4px 0 0 0; font-size: 13px;">
              <a href="https://${brandDomain}" style="color: #000; text-decoration: none;">${brandDomain}</a>
            </p>
          </td>
        </tr>
      </table>

      <div style="margin-top: 30px; font-size: 11px; color: #888; line-height: 1.5;">
        <p style="margin: 0;">
          ${brandName} is an operating intelligence company, part of the Begility group.
        </p>
        <p style="margin: 2px 0 0 0;">
          Begility Ltd, registered in England & Wales. Registered Office: 20 Wenlock Road, London, N1 7GU, United Kingdom.
        </p>
      </div>
    </div>
  `;
}
