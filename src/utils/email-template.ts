// ============================================================================
// Branded email wrapper for outbound
//
// All brand-specific strings below are driven by env vars so the same code can
// serve any niche configured in src/config/niche.ts. Set these on Google Cloud
// Run (non-secret) and the footer will render for whichever brand you've
// pointed the bot at.
//
//   BRAND_NAME            — e.g. "Begility"
//   BRAND_WEBSITE         — e.g. "begility.com" (no protocol)
//   BRAND_LOGO_URL        — public URL to a PNG logo (60-120px tall)
//   BRAND_TAGLINE         — optional one-line tagline below the sender block
//   BRAND_LEGAL_LINE_1    — e.g. "Begility Ltd is a UK-registered AI consultancy."
//   BRAND_LEGAL_LINE_2    — e.g. "Registered in England & Wales. Company No. XXXXXXXX. Registered office: ..."
//   SENDER_NAME           — first + last name shown in the signature block
//   SENDER_TITLE          — e.g. "Founder"
// ============================================================================

export function wrapEmailInTemplate(aiGeneratedHtml: string): string {
  const senderName = process.env.SENDER_NAME ?? "";
  const senderTitle = process.env.SENDER_TITLE ?? "";
  const brandName = process.env.BRAND_NAME ?? "Begility";
  const brandWebsite = (process.env.BRAND_WEBSITE ?? "begility.com").replace(/^https?:\/\//, "");
  const brandLogoUrl = process.env.BRAND_LOGO_URL ?? "";
  const brandTagline = process.env.BRAND_TAGLINE ?? "Bespoke AI automation, agents & integrations for operations-heavy teams.";
  const legalLine1 = process.env.BRAND_LEGAL_LINE_1 ?? `${brandName} is a UK-based AI consultancy and integration studio.`;
  const legalLine2 = process.env.BRAND_LEGAL_LINE_2 ?? "";

  const logoCell = brandLogoUrl
    ? `<td width="70" style="vertical-align: top; padding-right: 15px;">
         <img src="${brandLogoUrl}" alt="${brandName}" width="60" style="display: block; max-width: 60px;">
       </td>`
    : "";

  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1a1a1a; font-size: 14px; line-height: 1.6; max-width: 620px;">

      <div style="margin-bottom: 30px;">
        ${aiGeneratedHtml}
      </div>

      <table cellpadding="0" cellspacing="0" border="0" style="margin-top: 30px; border-top: 1px solid #eaeaec; padding-top: 20px; width: 100%;">
        <tr>
          ${logoCell}
          <td style="vertical-align: top;">
            <p style="margin: 0; font-weight: 600; font-size: 15px; color: #000;">${senderName}</p>
            <p style="margin: 2px 0 0 0; font-size: 13px; color: #555;">${senderTitle} | <strong>${brandName}</strong></p>
            <p style="margin: 4px 0 0 0; font-size: 13px;">
              <a href="https://${brandWebsite}" style="color: #000; text-decoration: none;">${brandWebsite}</a>
            </p>
            ${brandTagline ? `<p style="margin: 6px 0 0 0; font-size: 12px; color: #777; font-style: italic;">${brandTagline}</p>` : ""}
          </td>
        </tr>
      </table>

      <div style="margin-top: 30px; font-size: 11px; color: #888; line-height: 1.5;">
        <p style="margin: 0;">${legalLine1}</p>
        ${legalLine2 ? `<p style="margin: 2px 0 0 0;">${legalLine2}</p>` : ""}
      </div>
    </div>
  `;
}
