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

export const recurrenceSchema = z.object({
  frequency: z
    .enum(["daily", "weekly", "monthly", "yearly"])
    .optional()
    .describe("Частота повтора. Не передана — прежняя частота серии не меняется."),
  interval: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .describe("Шаг повтора: каждый N-й день, неделю, месяц или год. null снимает шаг (то же, что 1)."),
  byWeekday: z
    .array(z.string().regex(BY_WEEKDAY_PATTERN, BY_WEEKDAY_MESSAGE))
    .nullable()
    .optional()
    .describe(
      "Дни недели для BYDAY. Обычный день — двухбуквенный код (MO, TU, ...). " +
        "С порядковым префиксом — конкретное вхождение дня в месяце: 2MO — " +
        "второй понедельник месяца, -1FR — последняя пятница месяца. " +
        "null или пустой список снимают привязку к дням недели.",
    ),
  until: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Последняя встреча серии включительно, ISO 8601. null снимает конец по дате, " +
        "и серия становится бесконечной. Вместе с count передавать нельзя: конец " +
        "серии задаётся либо датой, либо числом встреч.",
    ),
  count: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .describe(
      "Сколько всего встреч в серии. null снимает счёт, и серия становится " +
        "бесконечной. Вместе с until передавать нельзя.",
    ),
  replace: z
    .boolean()
    .optional()
    .describe(
      "Собрать правило заново только из переданных частей, а не менять части " +
        "прежнего правила. Осторожно: части, которые не названы, будут потеряны — " +
        "такая правка требует подтверждения (confirm).",
    ),
})
  .describe(
    "Правка повтора по частям: меняются только переданные части правила, " +
      "остальные остаются как были. Умолчаний нет — не переданное не трогается. " +
      "Работает при scope all_series и this_and_following; у одной встречи " +
      "(scope: this) повтор не меняется.",
  );

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

// Умолчания у status нет намеренно (О9): не переданный статус не трогает
// PARTSTAT уже приглашённого участника, а новый получает NEEDS-ACTION сам.
// С .default("needs-action") любая правка списка сбрасывала бы чужие ответы
// «приду» и «не приду» в «не ответил».
export const attendeeSchema = z.object({
  email: z.string().email(),
  status: z
    .enum(["accepted", "declined", "tentative", "needs-action"])
    .optional()
    .describe(
      "Ответ участника. Не передан — ответ уже приглашённого участника не " +
        "трогается, а новый добавляется как не ответивший.",
    ),
});

export const patchSchema = z
  .object({
    summary: z.string().optional(),
    description: z.string().optional(),
    location: z.string().optional(),
    start: z.string().optional(),
    end: z.string().optional(),
    timeZone: z.string().optional(),
    allDay: z.boolean().optional(),
    status: z
      .enum(["confirmed", "tentative", "cancelled"])
      .nullable()
      .optional()
      .describe(
        "Состояние встречи. null снимает состояние вовсе. Отменённая " +
          "(cancelled) встреча остаётся видимой в списке, но перестаёт занимать " +
          "время при поиске свободных окон. Умолчания нет: не переданное " +
          "состояние не трогается.",
      ),
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
      etag: z
        .string()
        .optional()
        .describe(
          "Метка состояния события, которое вы видели последним; её отдают " +
            "get_event и предыдущая правка. Нужна вместе с confirm.",
        ),
      confirm: z
        .boolean()
        .optional()
        .describe(
          "Подтверждение потерь. Если правка убирает встречи сверх названной, " +
            "она сначала отказывает и перечисляет, что именно пропадёт, вместе с " +
            "меткой состояния (etag). Покажите перечень пользователю, и только " +
            "получив его согласие, повторите вызов с confirm: true и той же " +
            "меткой. Метка обязательна: подтверждать потери можно лишь по тому " +
            "состоянию, в котором их перечислили.",
        ),
    },
    async (args) => ok(await updateEvent(context, args as never)),
  );
}
