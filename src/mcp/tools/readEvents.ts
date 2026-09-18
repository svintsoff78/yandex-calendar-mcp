import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defineTool, ok } from "../defineTool.js";
import { readEvent, readEvents } from "../../domain/events.js";
import type { Context } from "../context.js";

export function registerReadTools(server: McpServer, context: Context): void {
  defineTool(
    server,
    "list_events",
    "События за период. Повторяющиеся события по умолчанию раскрываются в отдельные экземпляры.",
    {
      from: z.string().describe("Начало окна, ISO 8601 со смещением"),
      to: z.string().describe("Конец окна, ISO 8601 со смещением"),
      calendarIds: z.array(z.string()).optional().describe("Календари; по умолчанию все"),
      query: z.string().optional().describe("Подстрока в заголовке, описании или месте"),
      expandRecurring: z.boolean().optional().describe("Раскрывать повторы, по умолчанию да"),
    },
    async (args) => ok(await readEvents(context, args as never)),
  );

  defineTool(
    server,
    "get_event",
    "Одно событие целиком, включая исходное правило повтора.",
    {
      calendarId: z.string(),
      id: z.string().describe("UID события"),
    },
    async (args) => {
      const { calendarId, id } = args as unknown as { calendarId: string; id: string };
      return ok(await readEvent(context, calendarId, id));
    },
  );
}
