import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defineTool, ok } from "../defineTool.js";
import { createEvent, createEvents } from "../../domain/events.js";
import type { Context } from "../context.js";

// Отступление от брифа (по прямому указанию диспетчера, не самовольно):
// byWeekday в брифе — фиксированный перечень из семи кодов
// (z.enum(["MO", ...])). Это устарело после ревью задачи 6 — тип в
// src/types.ts допускает у элемента порядковый префикс: "MO" (просто
// понедельник), "2MO" (второй понедельник месяца), "-1FR" (последняя
// пятница месяца). Без префикса эти правила невыразимы, а разбор и сборка
// (src/ical/build.ts, toRrule) их уже поддерживают. Схема ниже — знак
// (только вместе с числом, отдельный "-MO" без цифры смысла не несёт),
// число, затем ровно один из семи двухбуквенных кодов.
const BY_WEEKDAY_PATTERN = /^(-?\d+)?(MO|TU|WE|TH|FR|SA|SU)$/;
const BY_WEEKDAY_MESSAGE =
  "Код дня недели (MO, TU, WE, TH, FR, SA, SU) с необязательным порядковым префиксом: " +
  "2MO — второй понедельник месяца, -1FR — последняя пятница месяца.";

const recurrenceSchema = z.object({
  frequency: z.enum(["daily", "weekly", "monthly", "yearly"]),
  interval: z.number().int().positive().default(1),
  byWeekday: z
    .array(z.string().regex(BY_WEEKDAY_PATTERN, BY_WEEKDAY_MESSAGE))
    .optional()
    .describe(
      "Дни недели для BYDAY. Обычный день — двухбуквенный код (MO, TU, ...). " +
        "С порядковым префиксом — конкретное вхождение дня в месяце: 2MO — " +
        "второй понедельник месяца, -1FR — последняя пятница месяца.",
    ),
  until: z.string().optional(),
  count: z.number().int().positive().optional(),
});

const eventShape = {
  calendarId: z.string().optional().describe("Календарь; по умолчанию первый"),
  summary: z.string().describe("Заголовок события"),
  description: z.string().optional(),
  location: z.string().optional(),
  start: z.string().describe("Начало, ISO 8601 со смещением"),
  end: z.string().describe("Конец, ISO 8601 со смещением"),
  timeZone: z.string().optional().describe("IANA-зона; по умолчанию из настроек"),
  allDay: z.boolean().optional(),
  recurrence: recurrenceSchema.optional(),
  reminders: z
    .array(
      z.object({
        // Отступление от брифа (по прямому указанию диспетчера): в брифе
        // minutesBefore — nonnegative(). Это устарело после ревью задачи 6 —
        // src/types.ts (Reminder.minutesBefore) отдал знаку смысл:
        // положительное значение — раньше начала (обычный случай,
        // TRIGGER:-PT15M), отрицательное — позже начала (TRIGGER:PT15M без
        // минуса, валидный по RFC 5545 триггер «после»). Урезать до
        // неотрицательных значит запретить единственный способ выразить
        // «после начала».
        minutesBefore: z
          .number()
          .int()
          .describe(
            "Смещение от начала события в минутах. Положительное — раньше " +
              "начала (обычный случай), отрицательное — позже начала.",
          ),
        method: z.enum(["display", "email"]),
      }),
    )
    .optional(),
  attendees: z
    .array(
      z.object({
        email: z.string().email(),
        status: z.enum(["accepted", "declined", "tentative", "needs-action"]).default("needs-action"),
      }),
    )
    .optional(),
};

export function registerCreateTools(server: McpServer, context: Context): void {
  defineTool(server, "create_event", "Создать одно событие.", eventShape, async (args) =>
    ok(await createEvent(context, args as never)),
  );

  defineTool(
    server,
    "create_events",
    "Создать несколько событий за один вызов. Отчёт приходит по каждому: успех или причина отказа.",
    { events: z.array(z.object(eventShape)).min(1).describe("Список событий") },
    async (args) => {
      const { events } = args as unknown as { events: Array<Record<string, unknown>> };
      return ok(await createEvents(context, events as never));
    },
  );
}
