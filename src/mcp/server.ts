import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../config.js";

export async function main(): Promise<void> {
  loadConfig(process.env);
  const server = new McpServer({ name: "yandex-calendar", version: "0.1.0" });
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error(String(error));
  process.exit(1);
});
