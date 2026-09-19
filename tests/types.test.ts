// Контракт типов src/types.ts для переделки правки и удаления повторяющихся
// встреч (docs/superpowers/plans/2026-09-19-recurring-events-rework.md, §2 и
// задача З04): новые поля CalendarEvent и Recurrence, порт ObjectIO,
// Context.io и Context.now.
//
// Типов во время выполнения нет, и tsconfig.json проекта проверяет только
// src/. Поэтому тест ниже запускает tsc над ЭТИМ ЖЕ файлом через
// tests/tsconfig.types.json (он наследует настройки проекта): утверждения
// функции typeContract проверяются компилятором, а не vitest. Сама функция
// не вызывается. Строки с @ts-expect-error — отрицательные проверки: если
// недопустимое станет допустимым, tsc сообщит о неиспользованной директиве.
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, expectTypeOf, test } from "vitest";
import type { RawObject } from "../src/caldav/objects.js";
import type { CaldavClient } from "../src/caldav/request.js";
import type { Config } from "../src/config.js";
import type {
  Calendar,
  CalendarEvent,
  Context,
  EventException,
  EventStatus,
  ExceptionState,
  ObjectIO,
  PutOutcome,
  Recurrence,
  RemoveOutcome,
  WriteCondition,
  WriteFailure,
  WriteOutcome,
} from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function runTsc(): Promise<{ code: number; output: string }> {
  const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
  const args = [tsc, "-p", join(here, "tsconfig.types.json"), "--pretty", "false"];
  return new Promise((resolve) => {
    execFile(process.execPath, args, { cwd: root }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, output: `${stdout}${stderr}` });
    });
  });
}

test("типы src/types.ts удовлетворяют контракту плана (проверка tsc)", async () => {
  const { code, output } = await runTsc();
  expect(output).toBe("");
  expect(code).toBe(0);
}, 60_000);

// Не вызывается: только для tsc.
export function typeContract(calendar: Calendar, client: CaldavClient, config: Config): void {
  // ── Recurrence.unmodeled ────────────────────────────────────────────────
  expectTypeOf<Recurrence["unmodeled"]>().toEqualTypeOf<string | undefined>();
  // Прежний вид без новых полей по-прежнему годится.
  const plainRecurrence: Recurrence = { frequency: "weekly", interval: 1, byWeekday: ["2MO"] };
  const unmodeledRecurrence: Recurrence = {
    frequency: "monthly",
    interval: 1,
    byWeekday: ["MO", "TU"],
    unmodeled: "BYSETPOS=-1;WKST=SU",
  };
  void plainRecurrence;
  void unmodeledRecurrence;

  // ── CalendarEvent: новые поля, все необязательные ───────────────────────
  expectTypeOf<CalendarEvent["recurring"]>().toEqualTypeOf<boolean | undefined>();
  expectTypeOf<CalendarEvent["recurrenceRule"]>().toEqualTypeOf<string | undefined>();
  expectTypeOf<CalendarEvent["status"]>().toEqualTypeOf<EventStatus | undefined>();
  expectTypeOf<CalendarEvent["moved"]>().toEqualTypeOf<boolean | undefined>();
  expectTypeOf<CalendarEvent["detached"]>().toEqualTypeOf<boolean | undefined>();
  expectTypeOf<CalendarEvent["exceptions"]>().toEqualTypeOf<EventException[] | undefined>();
  expectTypeOf<CalendarEvent["anomalies"]>().toEqualTypeOf<string[] | undefined>();
  // STATUS VEVENT по RFC 5545 §3.8.1.11 — ровно три значения.
  expectTypeOf<EventStatus>().toEqualTypeOf<"tentative" | "confirmed" | "cancelled">();
  // Прежние поля не тронуты.
  expectTypeOf<CalendarEvent["instanceStart"]>().toEqualTypeOf<string | undefined>();
  expectTypeOf<CalendarEvent["seriesId"]>().toEqualTypeOf<string | undefined>();
  expectTypeOf<CalendarEvent["recurrence"]>().toEqualTypeOf<Recurrence | undefined>();

  const base = {
    id: "uid-1",
    calendarId: "cal",
    summary: "Встреча",
    start: "2026-10-21T10:00:00+03:00",
    end: "2026-10-21T11:00:00+03:00",
    timeZone: "Europe/Moscow",
    allDay: false,
    reminders: [],
    attendees: [],
  };
  // Объект без новых полей остаётся CalendarEvent: производители, которых
  // переделка ещё не коснулась, компилируются.
  const plainEvent: CalendarEvent = base;
  const hourly: CalendarEvent = {
    ...base,
    recurring: true,
    recurrenceRule: "RRULE:FREQ=HOURLY;INTERVAL=2",
    status: "cancelled",
    moved: true,
    detached: false,
    instanceStart: "2026-10-21T10:00:00+03:00",
    seriesId: "uid-1",
    exceptions: [
      { instanceStart: "2026-10-22T10:00:00+03:00", state: "moved", start: "2026-10-22T15:00:00+03:00" },
      { instanceStart: "2026-10-23T10:00:00+03:00", state: "excluded" },
      {
        instanceStart: "2026-12-01T10:00:00+03:00",
        state: "hidden",
        summary: "Сирота",
        reason: "RECURRENCE-ID за концом серии",
      },
    ],
    anomalies: ["duplicate-override: у встречи 21.10 два компонента с одним RECURRENCE-ID"],
  };
  void plainEvent;
  void hourly;
  // @ts-expect-error — такого STATUS у VEVENT нет.
  const badStatus: CalendarEvent = { ...base, status: "needs-action" };
  void badStatus;

  // ── EventException ──────────────────────────────────────────────────────
  expectTypeOf<ExceptionState>().toEqualTypeOf<
    "changed" | "moved" | "cancelled" | "excluded" | "hidden" | "detached" | "duplicate"
  >();
  // @ts-expect-error — состояния «след прежнего кода» нет: роли переопределений
  // только slot, hidden, detached (поправка к плану от 19.09.2026).
  const legacyState: ExceptionState = "legacy";
  void legacyState;
  expectTypeOf<EventException>().toEqualTypeOf<{
    instanceStart: string;
    state: ExceptionState;
    start?: string;
    end?: string;
    summary?: string;
    reason?: string;
  }>();
  // @ts-expect-error — адрес исключения обязателен.
  const noAddress: EventException = { state: "hidden" };
  void noAddress;

  // ── Context: необязательные io и now ────────────────────────────────────
  expectTypeOf<Context["io"]>().toEqualTypeOf<ObjectIO | undefined>();
  expectTypeOf<Context["now"]>().toEqualTypeOf<(() => Date) | undefined>();
  const contextBase = {
    client,
    config,
    discover: async () => [calendar],
    calendars: async () => [calendar],
    resolveCalendar: async () => calendar,
  };
  // Прежний вид без io и now годится: src/mcp/context.ts их не задаёт.
  const plainContext: Context = contextBase;
  void plainContext;

  // ── ObjectIO ────────────────────────────────────────────────────────────
  expectTypeOf<ObjectIO["find"]>().toEqualTypeOf<
    (calendar: Calendar, uid: string) => Promise<RawObject | undefined>
  >();
  expectTypeOf<ObjectIO["put"]>().toEqualTypeOf<
    (href: string, ics: string, condition: WriteCondition) => Promise<PutOutcome>
  >();
  expectTypeOf<ObjectIO["remove"]>().toEqualTypeOf<
    (href: string, ifMatch: string) => Promise<RemoveOutcome>
  >();

  // Исходы записи — ровно пять из плана (§2, Р8).
  expectTypeOf<PutOutcome["status"]>().toEqualTypeOf<
    "applied" | "precondition-failed" | "not-found" | "unknown" | "rejected"
  >();
  expectTypeOf<RemoveOutcome["status"]>().toEqualTypeOf<PutOutcome["status"]>();
  expectTypeOf<WriteOutcome>().toEqualTypeOf<PutOutcome | RemoveOutcome>();
  expectTypeOf<Extract<PutOutcome, { status: "applied" }>>().toEqualTypeOf<{
    status: "applied";
    etag: string;
  }>();
  expectTypeOf<Extract<RemoveOutcome, { status: "applied" }>>().toEqualTypeOf<{
    status: "applied";
  }>();
  expectTypeOf<Extract<WriteFailure, { status: "unknown" }>>().toEqualTypeOf<{
    status: "unknown";
    error: Error;
  }>();
  expectTypeOf<Extract<WriteFailure, { status: "rejected" }>>().toEqualTypeOf<{
    status: "rejected";
    error: Error;
  }>();
  expectTypeOf<WriteFailure["status"]>().toEqualTypeOf<
    "precondition-failed" | "not-found" | "unknown" | "rejected"
  >();
  // @ts-expect-error — после применённого PUT etag обязателен (пустая строка, если сервер его не прислал).
  const putWithoutEtag: PutOutcome = { status: "applied" };
  void putWithoutEtag;

  // Условие записи: ровно одно из If-Match и If-None-Match.
  const update: WriteCondition = { ifMatch: "1789383239000" };
  const create: WriteCondition = { ifNoneMatch: "*" };
  void update;
  void create;
  // @ts-expect-error — оба условия сразу недопустимы.
  const both: WriteCondition = { ifMatch: "1", ifNoneMatch: "*" };
  // @ts-expect-error — запись без условия недопустима.
  const none: WriteCondition = {};
  void both;
  void none;

  // Подделка для тестов реализует порт без приведения типов.
  const fake: ObjectIO = {
    find: async (_calendar, uid) => ({ href: `/cal/${uid}.ics`, etag: "1", ics: "BEGIN:VCALENDAR" }),
    put: async () => ({ status: "applied", etag: "2" }),
    remove: async () => ({ status: "unknown", error: new Error("таймаут") }),
  };
  const withIo: Context = { ...contextBase, io: fake, now: () => new Date(Date.UTC(2026, 9, 21)) };
  void withIo;
}
