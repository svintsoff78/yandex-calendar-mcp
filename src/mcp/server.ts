import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createContext } from "./context.js";
import { registerListCalendars } from "./tools/listCalendars.js";
import { registerReadTools } from "./tools/readEvents.js";

export async function main(): Promise<void> {
  const context = createContext(process.env);
  const server = new McpServer({ name: "yandex-calendar", version: "0.1.0" });

  registerListCalendars(server, context);
  registerReadTools(server, context);

  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
