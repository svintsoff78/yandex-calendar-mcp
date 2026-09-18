import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineTool, ok } from "../defineTool.js";
import type { Context } from "../context.js";

export function registerListCalendars(server: McpServer, context: Context): void {
  defineTool(
    server,
    "list_calendars",
    "Список календарей аккаунта: идентификатор, название, цвет, часовой пояс, доступен ли для записи.",
    {},
    async () => ok(await context.calendars()),
  );
}
