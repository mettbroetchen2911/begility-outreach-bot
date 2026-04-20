import { Router, Request, Response } from "express";
import { getBotAdapter, BotService } from "../services/bot.service.js";

const router = Router();
const botService = new BotService();

router.post("/api/messages", async (req: Request, res: Response) => {
  const adapter = getBotAdapter();

  try {
    await adapter.processActivity(req, res, async (context) => {
      await botService.handleActivity(context);
    });
  } catch (err) {
    console.error("[Bot] processActivity error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Bot processing failed" });
    }
  }
});

export default router;
