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
// число в диапазоне 1..53, затем ровно один из семи двухбуквенных кодов.
//
// Правка по ревью задачи 12 (Important, находка 2): диапазон 1..53 — это
// не произвольное ужесточение, а само определение порядкового номера
// недели в BYDAY по RFC 5545 §3.3.10 ("a signed integer... where 53 is the
// maximum" — ноль и числа больше 53 в грамматику не входят). Прежняя версия
// схемы (`-?\d+`) принимала "0MO"/"54MO" — синтаксически похоже на BYDAY, но
// бессмысленно, и `toRrule` (src/ical/build.ts) кладёт значение в правило
// как есть, без своей проверки диапазона, так что такое значение ушло бы на
// сервер. `src/types.ts` при этом намеренно не сужен (там `${number}` —
// любое число): сужение до осмысленного диапазона — забота схемы
// инструмента, а не доменного типа.
const BY_WEEKDAY_ORDINAL = "(?:[1-9]|[1-4][0-9]|5[0-3])";
const BY_WEEKDAY_PATTERN = new RegExp(`^(-?${BY_WEEKDAY_ORDINAL})?(MO|TU|WE|TH|FR|SA|SU)$`);
const BY_WEEKDAY_MESSAGE =
  "Код дня недели (MO, TU, WE, TH, FR, SA, SU) с необязательным порядковым префиксом " +
  "от 1 до 53 (со знаком минус или без): 2MO — второй понедельник месяца, " +
  "-1FR — последняя пятница месяца.";

export const byWeekdaySchema = z.string().regex(BY_WEEKDAY_PATTERN, BY_WEEKDAY_MESSAGE);

const recurrenceSchema = z.object({
  frequency: z.enum(["daily", "weekly", "monthly", "yearly"]),
  interval: z.number().int().positive().default(1),
  byWeekday: z
    .array(byWeekdaySchema)
    .optional()
    .describe(
      "Дни недели для BYDAY. Обычный день — двухбуквенный код (MO, TU, ...). " +
        "С порядковым префиксом от 1 до 53 — конкретное вхождение дня в месяце: " +
        "2MO — второй понедельник месяца, -1FR — последняя пятница месяца.",
    ),
  until: z.string().optional(),
  count: z.number().int().positive().optional(),
});

// Отступление от брифа (по прямому указанию диспетчера): в брифе
// minutesBefore — nonnegative(). Это устарело после ревью задачи 6 —
// src/types.ts (Reminder.minutesBefore) отдал знаку смысл: положительное
// значение — раньше начала (обычный случай, TRIGGER:-PT15M), отрицательное —
// позже начала (TRIGGER:PT15M без минуса, валидный по RFC 5545 триггер
// «после»). Урезать до неотрицательных значит запретить единственный способ
// выразить «после начала».
export const minutesBeforeSchema = z
  .number()
  .int()
  .describe(
    "Смещение от начала события в минутах. Положительное — раньше начала " +
      "(обычный случай), отрицательное — позже начала.",
  );

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
        minutesBefore: minutesBeforeSchema,
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
