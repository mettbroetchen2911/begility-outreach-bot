import { TurnContext, CardFactory, MessageFactory } from "botbuilder";
import {
  getConfig, setConfig, resetConfig, listConfig, CONFIG_KEYS,
} from "./runtime-config.service.js";
import { countSendsToday, getSendsForLead, getRecentSends } from "./send-recorder.js";

// ---------------------------------------------------------------------------
// Entry point — returns true if the message matched a command (bot should
// not fall through to the default "I'm the lead engine bot" reply).
// ---------------------------------------------------------------------------
export async function handleBotTextCommand(
  context: TurnContext,
  cleanText: string,
): Promise<boolean> {
  const text = cleanText.trim();
  const lower = text.toLowerCase();

  if (lower.startsWith("!config") || lower.startsWith("/config")) {
    await handleConfig(context, text.replace(/^[!/]config\s*/i, ""));
    return true;
  }

  if (lower.startsWith("!sends") || lower.startsWith("/sends")) {
    await handleSends(context, text.replace(/^[!/]sends\s*/i, ""));
    return true;
  }

  if (lower.startsWith("!help") || lower.startsWith("/help")) {
    await context.sendActivity(helpText());
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// !config subcommands
// ---------------------------------------------------------------------------

async function handleConfig(context: TurnContext, args: string): Promise<void> {
  const userName = context.activity.from?.name ?? "Unknown";
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const sub = (tokens[0] ?? "help").toLowerCase();

  try {
    switch (sub) {
      case "list": {
        const entries = await listConfig();
        await context.sendActivity(MessageFactory.attachment(
          CardFactory.adaptiveCard(buildConfigListCard(entries))
        ));
        return;
      }

      case "get": {
        const key = tokens[1]?.toUpperCase();
        if (!key) { await context.sendActivity("Usage: `!config get <KEY>`"); return; }
        if (!CONFIG_KEYS[key]) { await context.sendActivity(`Unknown key: ${key}. Try \`!config list\`.`); return; }
        const current = await getConfig(key);
        const def = CONFIG_KEYS[key];
        await context.sendActivity(
          `**${key}**\n` +
          `• Current: \`${JSON.stringify(current)}\`\n` +
          `• Type: \`${def.type}\`\n` +
          `• ${def.description}`
        );
        return;
      }

      case "set": {
        const key = tokens[1]?.toUpperCase();
        const value = tokens.slice(2).join(" ");
        if (!key || !value) { await context.sendActivity("Usage: `!config set <KEY> <value>`"); return; }
        if (!CONFIG_KEYS[key]) { await context.sendActivity(`Unknown key: ${key}. Try \`!config list\`.`); return; }
        try {
          const { previous, current } = await setConfig(key, value, userName);
          await context.sendActivity(
            `Updated **${key}**\n` +
            `• Previous: \`${JSON.stringify(previous)}\`\n` +
            `• New: \`${JSON.stringify(current)}\`\n` +
            `Changes take effect on the next read (cache TTL ≤ 30s).`
          );
        } catch (err) {
          await context.sendActivity(`Rejected: ${(err as Error).message}`);
        }
        return;
      }

      case "reset": {
        const key = tokens[1]?.toUpperCase();
        if (!key) { await context.sendActivity("Usage: `!config reset <KEY>`"); return; }
        if (!CONFIG_KEYS[key]) { await context.sendActivity(`Unknown key: ${key}`); return; }
        const def = await resetConfig(key, userName);
        await context.sendActivity(`Reset **${key}** to default: \`${JSON.stringify(def)}\``);
        return;
      }

      case "help":
      default:
        await context.sendActivity(configHelpText());
        return;
    }
  } catch (err) {
    await context.sendActivity(`Error: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// !sends subcommands
// ---------------------------------------------------------------------------

async function handleSends(context: TurnContext, args: string): Promise<void> {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const sub = (tokens[0] ?? "today").toLowerCase();

  try {
    if (sub === "today") {
      const outreach = await countSendsToday("outreach");
      const followUp = await countSendsToday("follow_up");
      const goodbye = await countSendsToday("goodbye");
      const total = outreach + followUp + goodbye;
      const cap = await getConfig<number>("DAILY_SEND_CAP").catch(() => 0);
      const capLine = cap > 0 ? ` (cap: ${cap})` : " (no cap)";
      await context.sendActivity(
        `**Sends today${capLine}**\n` +
        `• Outreach: ${outreach}\n` +
        `• Follow-ups: ${followUp}\n` +
        `• Goodbyes: ${goodbye}\n` +
        `• Total: **${total}**`
      );
      return;
    }

    if (sub === "lead") {
      const leadId = tokens[1];
      if (!leadId) { await context.sendActivity("Usage: `!sends lead <leadId>`"); return; }
      const rows = await getSendsForLead(leadId, 20);
      if (rows.length === 0) { await context.sendActivity(`No sends recorded for ${leadId}.`); return; }
      const lines = rows.map((r) =>
        `• ${r.sentAt.toISOString().slice(0, 16).replace("T", " ")}  ${r.direction}  by ${r.sentBy}${r.wasEdited ? ` (edited: ${r.editSummary ?? "?"})` : ""}`
      ).join("\n");
      await context.sendActivity(`**Send history for ${leadId}**\n${lines}`);
      return;
    }

    if (sub === "recent") {
      const rows = await getRecentSends(25);
      const lines = rows.map((r) =>
        `• ${r.sentAt.toISOString().slice(0, 16).replace("T", " ")}  ${r.direction}  lead=${r.leadId.slice(0, 8)}  by ${r.sentBy}`
      ).join("\n");
      await context.sendActivity(`**Recent sends**\n${lines || "_none_"}`);
      return;
    }

    await context.sendActivity("Usage: `!sends today` | `!sends recent` | `!sends lead <leadId>`");
  } catch (err) {
    await context.sendActivity(`Error: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Card for !config list
// ---------------------------------------------------------------------------

function buildConfigListCard(entries: Array<{
  key: string;
  current: unknown;
  default: unknown;
  type: string;
  description: string;
  isOverride: boolean;
  updatedBy?: string;
  updatedAt?: Date;
}>): Record<string, unknown> {
  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    body: [
      { type: "TextBlock", text: "Runtime Config", weight: "Bolder", size: "Medium" },
      { type: "TextBlock", text: "_Edit with `!config set <KEY> <value>`_", isSubtle: true, wrap: true },
      ...entries.map((e) => ({
        type: "Container",
        style: e.isOverride ? "emphasis" : "default",
        items: [
          {
            type: "TextBlock",
            text: `**${e.key}** = \`${JSON.stringify(e.current)}\`${e.isOverride ? " *(override)*" : ""}`,
            wrap: true,
          },
          {
            type: "TextBlock",
            text: e.description,
            size: "Small",
            isSubtle: true,
            wrap: true,
          },
          ...(e.isOverride && e.updatedBy ? [{
            type: "TextBlock",
            text: `_set by ${e.updatedBy} at ${e.updatedAt?.toISOString().slice(0, 16).replace("T", " ")}_`,
            size: "Small",
            isSubtle: true,
          }] : []),
        ],
      })),
    ],
  };
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

function configHelpText(): string {
  return [
    "**!config commands**",
    "• `!config list` — show all configurable keys with current values",
    "• `!config get <KEY>` — read one key",
    "• `!config set <KEY> <value>` — write (validated, persisted to Neon)",
    "• `!config reset <KEY>` — clear override, revert to default",
    "",
    "Changes apply within ~30 seconds (cache TTL). Every change is logged.",
  ].join("\n");
}

function helpText(): string {
  return [
    "**Begility Lead Engine bot — commands**",
    "",
    "• `!register sales` / `!register ops` / `!register devops` — bind this channel",
    "• `!config help` — manage runtime settings (thresholds, scraper, outreach)",
    "• `!sends today` / `!sends recent` / `!sends lead <id>` — send log",
    "• `!help` — this message",
  ].join("\n");
}
