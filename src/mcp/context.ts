import { createClient } from "../caldav/request.js";
import { discoverCalendars } from "../caldav/discovery.js";
import { listCalendars, resolveCalendarIn } from "../domain/calendars.js";
import { loadConfig } from "../config.js";
import type { Context } from "../types.js";

export type { Context } from "../types.js";

export function createContext(env: NodeJS.ProcessEnv): Context {
  const config = loadConfig(env);
  const client = createClient(config);

  const context: Context = {
    client,
    config,
    discover: () => discoverCalendars(client),
    calendars: () => listCalendars(context),
    resolveCalendar: async (idOrName) => resolveCalendarIn(await context.calendars(), idOrName),
  };

  return context;
}
