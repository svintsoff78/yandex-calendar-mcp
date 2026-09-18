import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defineTool, ok } from "../defineTool.js";
import { deleteEvent } from "../../domain/events.js";
import type { Context } from "../context.js";

export function registerDeleteTool(server: McpServer, context: Context): void {
  defineTool(
    server,
    "delete_event",
    "Удалить событие. Это необратимая операция — удалённое событие не " +
      "восстановить. У повторяющихся событий по умолчанию исчезает только " +
      "названный экземпляр (scope: this); чтобы обрезать хвост серии или " +
      "удалить всю серию целиком, передайте scope: this_and_following или " +
      "all_series явно. У одиночного (неповторяющегося) события удалять " +
      "нечего, кроме самого события, поэтому оно удаляется целиком в любом " +
      "случае.",
    {
      calendarId: z.string().optional().describe("Календарь; по умолчанию первый"),
      id: z.string().describe("UID события"),
      scope: z
        .enum(["this", "this_and_following", "all_series"])
        .optional()
        .describe(
          "Область удаления для повторяющегося события. По умолчанию this " +
            "(только названный экземпляр) — для одиночного события всегда " +
            "трактуется как all_series.",
        ),
      instanceStart: z
        .string()
        .optional()
        .describe(
          "Начало удаляемого экземпляра, ISO 8601 со смещением; обязательно " +
            "при scope this и this_and_following",
        ),
    },
    async (args) => ok(await deleteEvent(context, args as never)),
  );
}
