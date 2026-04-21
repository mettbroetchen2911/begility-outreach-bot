export function plainToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map((para) => `<p>${para.replace(/\n/g, "<br/>")}</p>`)
    .join("\n");
}

export function stripHtml(html: string): string {
  return html
    .replace(/<\/(p|div)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .trim();
}

export function ensureHtml(body: string): string {
  return body.trimStart().startsWith("<") ? body : plainToHtml(body);
}
