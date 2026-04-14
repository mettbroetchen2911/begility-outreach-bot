import { prisma } from "./prisma.js";

export async function logError(opts: {
  scenario: string;
  module: string;
  code: string;
  message: string;
  leadId?: string;
  killSwitch?: boolean;
}): Promise<void> {
  console.error(`[${opts.scenario}/${opts.module}] ${opts.code}: ${opts.message}`);
  try {
    await prisma.errorLog.create({
      data: {
        scenarioName: opts.scenario,
        moduleName: opts.module,
        errorCode: opts.code,
        errorMessage: opts.message.slice(0, 4000),
        leadId: opts.leadId,
        killSwitchFired: opts.killSwitch ?? false,
      },
    });
  } catch {
    console.error("Failed to persist error to ErrorLog table");
  }
}

export function info(tag: string, message: string): void {
  console.log(`[${tag}] ${message}`);
}
