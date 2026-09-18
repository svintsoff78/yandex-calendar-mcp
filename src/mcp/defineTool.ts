import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShape } from "zod";

export type ToolResult = { content: Array<{ type: "text"; text: string }> };

export function ok(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

// Единственное место в проекте, знающее форму API SDK. Если она изменится,
// правится только эта функция — остальные инструменты вызывают только её.
export function defineTool(
  server: McpServer,
  name: string,
  description: string,
  shape: ZodRawShape,
  handler: (args: Record<string, never>) => Promise<ToolResult>,
): void {
  server.registerTool(name, { description, inputSchema: shape }, handler as never);
}
