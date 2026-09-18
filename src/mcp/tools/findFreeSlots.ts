import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defineTool, ok } from "../defineTool.js";
import { findFreeSlots } from "../../domain/freeSlots.js";
import type { Context } from "../context.js";

export function registerFreeSlotsTool(server: McpServer, context: Context): void {
  defineTool(
    server,
    "find_free_slots",
    "Свободные окна в собственных календарях с учётом рабочих часов. Свободно/занято " +
      "чужих людей Яндекс не отдаёт — поиск идёт только по календарям текущего аккаунта.",
    {
      from: z.string().describe("Начало поиска, ISO 8601"),
      to: z.string().describe("Конец поиска, ISO 8601"),
      durationMinutes: z.number().int().positive().describe("Минимальная длина окна в минутах"),
      workingHours: z
        .object({ start: z.string(), end: z.string() })
        .optional()
        .describe("Рабочие часы в формате ЧЧ:ММ, по умолчанию 10:00–19:00"),
      weekdays: z
        .array(z.number().int().min(0).max(6))
        .optional()
        .describe("Дни недели, 0 — воскресенье; по умолчанию с понедельника по пятницу"),
      calendarIds: z.array(z.string()).optional(),
    },
    async (args) => ok(await findFreeSlots(context, args as never)),
  );
}
