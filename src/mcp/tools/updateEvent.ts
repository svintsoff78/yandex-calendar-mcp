import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defineTool, ok } from "../defineTool.js";
import { updateEvent } from "../../domain/events.js";
import type { Context } from "../context.js";

// Отступление от брифа (тот же приём, что и в createEvents.ts, по прямому
// указанию диспетчера, не самовольно): byWeekday в брифе — фиксированный
// перечень из семи кодов. Тип в src/types.ts допускает у элемента
// порядковый префикс ("2MO", "-1FR"), схема должна это пропускать, иначе
// правка recurrence на такое значение отвалится валидацией раньше, чем
// дойдёт до домена.
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

// Отступление от брифа (тот же приём, что и в createEvents.ts, по прямому
// указанию диспетчера): minutesBefore в брифе — nonnegative(). src/types.ts
// (Reminder.minutesBefore) отдал знаку смысл: положительное — раньше
// начала, отрицательное — позже начала (валидный по RFC 5545 триггер
// «после»). Урезать до неотрицательных значит запретить единственный способ
// выразить «после начала».
const reminderSchema = z.object({
  minutesBefore: z
    .number()
    .int()
    .describe(
      "Смещение от начала события в минутах. Положительное — раньше начала " +
        "(обычный случай), отрицательное — позже начала.",
    ),
  method: z.enum(["display", "email"]),
});

const attendeeSchema = z.object({
  email: z.string().email(),
  status: z.enum(["accepted", "declined", "tentative", "needs-action"]).default("needs-action"),
});

const patchSchema = z
  .object({
    summary: z.string().optional(),
    description: z.string().optional(),
    location: z.string().optional(),
    start: z.string().optional(),
    end: z.string().optional(),
    timeZone: z.string().optional(),
    allDay: z.boolean().optional(),
    recurrence: recurrenceSchema.optional(),
    reminders: z.array(reminderSchema).optional(),
    attendees: z.array(attendeeSchema).optional(),
  })
  .describe("Только изменяемые поля; остальные останутся прежними");

export function registerUpdateTool(server: McpServer, context: Context): void {
  defineTool(
    server,
    "update_event",
    "Изменить событие. У повторяющихся событий по умолчанию меняется только " +
      "названный экземпляр (scope: this); чтобы задеть хвост серии или всю " +
      "серию, передайте scope: this_and_following или all_series явно.",
    {
      calendarId: z.string().optional().describe("Календарь; по умолчанию первый"),
      id: z.string().describe("UID события"),
      scope: z
        .enum(["this", "this_and_following", "all_series"])
        .optional()
        .describe("Область правки для повторяющегося события, по умолчанию this"),
      instanceStart: z
        .string()
        .optional()
        .describe(
          "Начало правимого экземпляра, ISO 8601 со смещением; обязательно при " +
            "scope this и this_and_following",
        ),
      patch: patchSchema,
    },
    async (args) => ok(await updateEvent(context, args as never)),
  );
}
