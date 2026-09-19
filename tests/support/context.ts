// Контекст домена поверх фейкового сервера: настоящий createClient(config,
// fake.fetch), без подмен get/put/remove и без Context.io — весь путь
// домен → src/caldav/objects.ts → src/caldav/request.ts исполняется боевым
// кодом (§6 плана переделки,
// docs/superpowers/plans/2026-09-19-recurring-events-rework.md).
//
// Как пользоваться в цепочках (tests/chains/*):
//
//   const { fake, ctx } = makeStand();              // сервер «как Яндекс», строгий режим
//   const path = plant(fake, seeds.weeklyMoscow);    // чужая серия по пути Яндекса
//   const before = fake.ics(path);
//   const events = await readEvents(ctx, {...});     // instanceStart — только из выдачи
//   const mark = fake.mark();
//   await updateEvent(ctx, { id: seeds.weeklyMoscow.uid, scope: "this", instanceStart, patch });
//   expect(await visible(ctx)).toEqual([...]);        // точный список, observe.ts
//   assertStoredInvariants(fake);                     // О12а у каждого объекта
//   assertPropsPreserved(before, lastPutBody(fake, path)!, { except: ["SUMMARY"] });
//   expect(fake.writesSince(mark)).toHaveLength(1);   // PUT ровно один; отказ — expectNoWrites
//
// Сбои: fake.loseResponse({ method: "PUT" }, 503), fake.dropRequest(...),
// fake.rejectBeforeApply({ method: "PUT", ifMatch: true }, 507); гонка —
// fake.beforeRequest = (r) => { if (r.method === "DELETE") fake.externalEdit(path, f) }.
// Условные заголовки: conditions "yandex" (по умолчанию: If-None-Match и
// If-Match на DELETE не соблюдаются, Ж13–Ж16) или "rfc" (всё даёт 412).
// Сообщение упавшей цепочки удобно дополнять describeStand(fake).
import { createClient } from "../../src/caldav/request.js";
import type { Config } from "../../src/config.js";
import { resolveCalendarIn } from "../../src/domain/calendars.js";
import type { Calendar, Context } from "../../src/types.js";
import { FAKE_BASE_URL, FakeCaldav, type FakeCaldavOptions } from "./fakeCaldav.js";
import type { Seed } from "./seeds.js";

/** Логин владельца аккаунта стенда (config.login). */
export const OWNER = "user@yandex.ru";

// Пути коллекций — как у Яндекса: логин с %40 (docs/yandex-caldav-capabilities.md).
export const calendarA: Calendar = {
  id: "events-default",
  href: "/calendars/user%40yandex.ru/events-default/",
  displayName: "Мои события",
  readOnly: false,
};

export const calendarB: Calendar = {
  id: "events-work",
  href: "/calendars/user%40yandex.ru/events-work/",
  displayName: "Работа",
  readOnly: false,
};

export const calendarReadOnly: Calendar = {
  id: "events-shared",
  href: "/calendars/user%40yandex.ru/events-shared/",
  displayName: "Общий, только чтение",
  readOnly: true,
};

/** Неподвижные часы стенда по умолчанию: до начала всех затравок. */
export const STAND_NOW = "2026-10-01T09:00:00Z";

export interface ContextOptions {
  calendars?: Calendar[];
  defaultTimeZone?: string;
  login?: string;
  /**
   * Часы Context.now. По умолчанию неподвижные STAND_NOW; null — не задавать
   * now вовсе (код возьмёт системные часы).
   */
  now?: (() => Date) | null;
}

/** Контекст домена, чьи запросы уходят в fake. */
export function makeContext(fake: FakeCaldav, options: ContextOptions = {}): Context {
  const calendars = options.calendars ?? [calendarA];
  const config: Config = {
    login: options.login ?? OWNER,
    appPassword: "not-a-real-password",
    defaultTimeZone: options.defaultTimeZone ?? "Europe/Moscow",
    baseUrl: fake.baseUrl,
  };
  const client = createClient(config, fake.fetch as typeof fetch);
  const context: Context = {
    client,
    config,
    discover: async () => calendars,
    calendars: async () => calendars,
    resolveCalendar: async (idOrName) => resolveCalendarIn(calendars, idOrName),
  };
  const now = options.now === undefined ? () => new Date(STAND_NOW) : options.now;
  if (now) context.now = now;
  return context;
}

export interface Stand {
  fake: FakeCaldav;
  ctx: Context;
  /** Первый календарь — тот, куда кладёт plant по умолчанию. */
  calendar: Calendar;
}

/** Сервер и контекст одним вызовом; имена календарей уходят серверу для CATEGORIES (Ж8). */
export function makeStand(options: ContextOptions & FakeCaldavOptions = {}): Stand {
  const calendars = options.calendars ?? [calendarA];
  const fake = new FakeCaldav({
    baseUrl: FAKE_BASE_URL,
    calendarNames: Object.fromEntries(calendars.map((calendar) => [calendar.href, calendar.displayName])),
    owner: options.login ?? OWNER,
    ...options,
  });
  return { fake, ctx: makeContext(fake, { ...options, calendars }), calendar: calendars[0] };
}

/** Путь чужого объекта, как его кладёт Яндекс: UID без собаки. */
export function yandexPath(calendar: Calendar, uid: string): string {
  return `${calendar.href}${uid.replace(/@/g, "")}.ics`;
}

/** Кладёт затравку по пути Яндекса и возвращает путь. Текст — дословно (seedRaw). */
export function plant(fake: FakeCaldav, seed: Seed, calendar: Calendar = calendarA): string {
  const path = yandexPath(calendar, seed.uid);
  fake.seedRaw(path, seed.ics);
  return path;
}
