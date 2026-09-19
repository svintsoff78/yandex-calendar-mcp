// Наблюдение за стендом после каждого шага цепочки (§6 плана переделки,
// docs/superpowers/plans/2026-09-19-recurring-events-rework.md):
//
// - `visible(ctx)` — точный список того, что видит пользователь через
//   настоящий readEvents, строками вида
//   "2026-10-21 11:30–12:30 Планёрка @Переговорная [слот 2026-10-21 10:00]";
// - `assertStoredInvariants(fake)` — инварианты О12а у каждого объекта
//   стенда относительно его затравки и чужих правок;
// - `assertPropsPreserved(before, after)` — правка не тронула того, что не
//   называла: свойства и вложенные компоненты «до» есть и «после»;
// - `expectNoWrites(fake, mark)` — отказ ничего не записал.
//
// Формат строк не зависит ни от пояса процесса, ни от того, в каком поясе
// код выразил время (старый код и новый пишут смещения по-разному): время
// переводится в стенное время пояса показа, у встреч на весь день берётся
// буквальная дата.
import { readEvents } from "../../src/domain/events.js";
import type { CalendarEvent, Context } from "../../src/types.js";
import type { FakeCaldav } from "./fakeCaldav.js";
import {
  assertInvariants,
  InvariantError,
  lineName,
  parseRawComponents,
  unfold,
  utcMsOf,
  wallInZone,
  wallOf,
  type RawComponent,
} from "./invariants.js";

/** Окно чтения по умолчанию: с запасом покрывает все затравки и цепочки. */
export const DEFAULT_WINDOW = { from: "2026-01-01T00:00:00Z", to: "2030-01-01T00:00:00Z" };
/** Пояс показа по умолчанию — пояс затравок и конфигурации стенда. */
export const DEFAULT_ZONE = "Europe/Moscow";

export interface FormatOptions {
  /** Пояс, в котором показывается время; по умолчанию Europe/Moscow. */
  zone?: string;
  /** Дописать " #<id>" — чтобы различать серию и её продолжение после разреза. */
  showId?: boolean;
}

export interface VisibleOptions extends FormatOptions {
  from?: string;
  to?: string;
  calendarIds?: string[];
  query?: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Стенное время ISO-строки в поясе zone: "2026-10-21 10:00" (секунды — если
 * не ноль). Дата без времени и время без смещения возвращаются как есть.
 */
export function wallTime(iso: string, zone: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(iso);
  if (!match) throw new Error(`wallTime: не ISO 8601: ${iso}`);
  const [, date, hh, mm, ss = "00", offset] = match;
  if (hh === undefined) return date;
  const show = (h: string, m: string, s: string) => `${h}:${m}${s === "00" ? "" : `:${s}`}`;
  if (offset === undefined) return `${date} ${show(hh, mm, ss)}`;
  const wall = wallOf(`${date}T${hh}:${mm}:${ss}`)!;
  let offsetMs = 0;
  if (offset !== "Z") {
    const sign = offset[0] === "-" ? -1 : 1;
    const digits = offset.slice(1).replace(":", "");
    offsetMs = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4))) * 60_000;
  }
  const seen = wallInZone(utcMsOf(wall) - offsetMs, zone);
  if (!seen) throw new Error(`wallTime: неизвестный пояс ${zone}`);
  return `${seen.year}-${pad(seen.month)}-${pad(seen.day)} ${show(pad(seen.hour), pad(seen.minute), pad(seen.second))}`;
}

// Последний день встречи на весь день: конец в iCalendar исключающий.
function lastAllDayDate(start: string, end: string): string {
  const [y, m, d] = end.split("-").map(Number);
  const previous = new Date(Date.UTC(y, m - 1, d) - 86_400_000).toISOString().slice(0, 10);
  return previous > start ? previous : start;
}

/** Одна строка выдачи readEvents в формате цепочек. */
export function formatEvent(event: CalendarEvent, options: FormatOptions = {}): string {
  const zone = options.zone ?? DEFAULT_ZONE;
  let head: string;
  let slot: string | undefined;
  let start: string;
  if (event.allDay) {
    start = event.start.slice(0, 10);
    const last = lastAllDayDate(start, event.end.slice(0, 10));
    head = `${last === start ? start : `${start}–${last}`} весь день`;
    slot = event.instanceStart?.slice(0, 10);
  } else {
    start = wallTime(event.start, zone);
    const end = wallTime(event.end, zone);
    head = `${start}–${end.slice(0, 10) === start.slice(0, 10) ? end.slice(11) : end}`;
    slot = event.instanceStart === undefined ? undefined : wallTime(event.instanceStart, zone);
  }
  let line = `${head} ${event.summary}`;
  if (event.location) line += ` @${event.location}`;
  if (slot !== undefined && slot !== start) line += ` [слот ${slot}]`;
  if (event.status === "cancelled") line += " [отменена]";
  if (options.showId) line += ` #${event.id}`;
  return line;
}

/** Точный список видимых встреч через настоящий readEvents, в порядке выдачи. */
export async function visible(ctx: Context, options: VisibleOptions = {}): Promise<string[]> {
  const events = await readEvents(ctx, {
    from: options.from ?? DEFAULT_WINDOW.from,
    to: options.to ?? DEFAULT_WINDOW.to,
    calendarIds: options.calendarIds,
    query: options.query,
  });
  return events.map((event) => formatEvent(event, options));
}

// ---------------------------------------------------------------------------
// Журнал и инварианты
// ---------------------------------------------------------------------------

/** Бросает, если после отметки в журнале есть PUT или DELETE (отказ обязан ничего не писать). */
export function expectNoWrites(fake: FakeCaldav, mark: number): void {
  const writes = fake.writesSince(mark);
  if (writes.length > 0) {
    throw new Error(
      `Ожидалось, что записей не будет, а в журнале: ${writes.map((w) => `${w.method} ${w.path} → ${w.status}`).join("; ")}`,
    );
  }
}

/** Тело последнего PUT по пути (или вообще последнего PUT) — то, что прислал клиент. */
export function lastPutBody(fake: FakeCaldav, path?: string): string | undefined {
  for (let i = fake.log.length - 1; i >= 0; i -= 1) {
    const entry = fake.log[i];
    if (entry.method === "PUT" && (path === undefined || entry.path === path)) return entry.body;
  }
  return undefined;
}

/**
 * Инварианты О12а у каждого объекта стенда: нарушения сверх тех, что уже
 * были в затравке или в чужих правках этого пути, — ошибка.
 */
export function assertStoredInvariants(fake: FakeCaldav): void {
  const problems: string[] = [];
  for (const [path, object] of fake.objects) {
    try {
      assertInvariants(object.ics, fake.externalVersions(path));
    } catch (error) {
      if (!(error instanceof InvariantError)) throw error;
      problems.push(`${path}:\n${error.violations.map((v) => `  - ${v.kind}: ${v.detail}`).join("\n")}`);
    }
  }
  if (problems.length > 0) throw new Error(`Объекты стенда нарушают инварианты (О12а):\n${problems.join("\n")}`);
}

// ---------------------------------------------------------------------------
// Сохранность свойств
// ---------------------------------------------------------------------------

/** Метаданные, которые правка обязана менять (О10): по умолчанию не сверяются. */
export const METADATA = ["DTSTAMP", "LAST-MODIFIED", "SEQUENCE"];

export interface PreserveOptions {
  /**
   * Какие компоненты «до» сверять: "all" (по умолчанию) — все компоненты
   * VCALENDAR, "master" — основной VEVENT, "overrides" — переопределения,
   * или предикат.
   */
  scope?: "all" | "master" | "overrides" | ((component: RawComponent) => boolean);
  /** Сверять только эти свойства и вложенные компоненты (имена без учёта регистра). */
  only?: string[];
  /** Этим свойствам и вложенным компонентам можно меняться. */
  except?: string[];
  /** Сверять и DTSTAMP, LAST-MODIFIED, SEQUENCE. */
  keepMetadata?: boolean;
  /**
   * Сверять строки дословно (после снятия переносов строк). По умолчанию
   * имена свойств и параметров — без учёта регистра, значения параметров —
   * без кавычек, порядок параметров не важен: так сериализует ical.js
   * (lib/ical/stringify.js, paramPropertyValue снимает ненужные кавычки).
   */
  exact?: boolean;
}

function splitOutsideQuotes(text: string, separator: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    if (char === separator && !quoted) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

function normalizeLine(line: string, exact: boolean): string {
  if (exact) return line;
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '"') quoted = !quoted;
    if (line[i] === ":" && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return line;
  const [name, ...params] = splitOutsideQuotes(line.slice(0, colon), ";");
  const normalizedParams = params
    .map((param) => {
      const eq = param.indexOf("=");
      const key = (eq < 0 ? param : param.slice(0, eq)).toUpperCase();
      const value = eq < 0 ? "" : splitOutsideQuotes(param.slice(eq + 1), ",").map((v) => v.replace(/^"(.*)"$/, "$1")).join(",");
      return `${key}=${value}`;
    })
    .sort();
  return [name.toUpperCase(), ...normalizedParams].join(";") + line.slice(colon);
}

function isOverride(component: RawComponent): boolean {
  return component.name === "VEVENT" && component.lines.some((line) => lineName(line) === "RECURRENCE-ID");
}

function componentKeys(components: RawComponent[], exact: boolean): string[] {
  const counters = new Map<string, number>();
  return components.map((component) => {
    let base = component.name;
    if (component.name === "VEVENT") {
      const rid = component.lines.find((line) => lineName(line) === "RECURRENCE-ID");
      base = rid ? `VEVENT ${normalizeLine(rid, exact)}` : "VEVENT основной";
    } else if (component.name === "VTIMEZONE") {
      const tzid = component.lines.find((line) => lineName(line) === "TZID");
      base = `VTIMEZONE ${tzid ?? ""}`;
    }
    const n = counters.get(base) ?? 0;
    counters.set(base, n + 1);
    return n === 0 ? base : `${base} #${n + 1}`;
  });
}

function flatten(component: RawComponent, exact: boolean): string {
  return [
    `BEGIN:${component.name}`,
    ...component.lines.map((line) => normalizeLine(line, exact)),
    ...component.children.map((child) => flatten(child, exact)),
    `END:${component.name}`,
  ].join("\n");
}

/**
 * Бросает, если свойство или вложенный компонент выбранных компонентов
 * `before` пропал или изменился в `after`. Компоненты сопоставляются по
 * роли: основной VEVENT с основным, переопределение — по RECURRENCE-ID,
 * VTIMEZONE — по TZID.
 */
export function assertPropsPreserved(before: string, after: string, options: PreserveOptions = {}): void {
  const exact = options.exact ?? false;
  const only = options.only?.map((name) => name.toUpperCase());
  const except = new Set([
    ...(options.except ?? []).map((name) => name.toUpperCase()),
    ...(options.keepMetadata ? [] : METADATA),
  ]);
  const wanted = (name: string) => (only === undefined || only.includes(name)) && !except.has(name);
  const scope = options.scope ?? "all";
  const selects = (component: RawComponent) =>
    typeof scope === "function"
      ? scope(component)
      : scope === "all"
        ? true
        : scope === "master"
          ? component.name === "VEVENT" && !isOverride(component)
          : isOverride(component);

  const beforeRoot = parseRawComponents(before)[0];
  const afterRoot = parseRawComponents(after)[0];
  if (!beforeRoot || !afterRoot) throw new Error("assertPropsPreserved: нет VCALENDAR до или после");
  const afterByKey = new Map<string, RawComponent>();
  componentKeys(afterRoot.children, exact).forEach((key, i) => afterByKey.set(key, afterRoot.children[i]));

  const problems: string[] = [];
  componentKeys(beforeRoot.children, exact).forEach((key, i) => {
    const was = beforeRoot.children[i];
    if (!selects(was)) return;
    const now = afterByKey.get(key);
    if (!now) {
      problems.push(`компонент пропал: ${key}`);
      return;
    }
    const remaining = now.lines.map((line) => normalizeLine(line, exact));
    for (const line of was.lines) {
      if (!wanted(lineName(line))) continue;
      const normalized = normalizeLine(line, exact);
      const at = remaining.indexOf(normalized);
      if (at < 0) problems.push(`${key}: пропала или изменилась строка ${line}`);
      else remaining.splice(at, 1);
    }
    const remainingChildren = now.children.map((child) => flatten(child, exact));
    for (const child of was.children) {
      if (!wanted(child.name)) continue;
      const text = flatten(child, exact);
      const at = remainingChildren.indexOf(text);
      if (at < 0) problems.push(`${key}: пропал или изменился вложенный ${child.name}:\n${text}`);
      else remainingChildren.splice(at, 1);
    }
  });
  if (problems.length > 0) throw new Error(`Правка тронула то, чего не называла:\n${problems.join("\n")}`);
}

// ---------------------------------------------------------------------------
// Описание для сообщений об ошибках
// ---------------------------------------------------------------------------

const DESCRIBED = new Set([
  "UID",
  "RECURRENCE-ID",
  "DTSTART",
  "DTEND",
  "DURATION",
  "RRULE",
  "RDATE",
  "EXDATE",
  "SUMMARY",
  "LOCATION",
  "STATUS",
  "SEQUENCE",
]);

/** Краткое описание VEVENT объекта: сначала основные, затем переопределения. */
export function describeObject(ics: string): string[] {
  const root = parseRawComponents(ics)[0];
  if (!root) return [`не iCalendar: ${unfold(ics).slice(0, 80)}`];
  const events = root.children.filter((child) => child.name === "VEVENT");
  const ordered = [...events.filter((e) => !isOverride(e)), ...events.filter(isOverride)];
  return ordered.map((event) => {
    const title = isOverride(event) ? "VEVENT переопределение" : "VEVENT основной";
    const lines = event.lines.filter((line) => DESCRIBED.has(lineName(line)));
    return [title, ...lines.map((line) => `  ${line}`)].join("\n");
  });
}

/** Описание всех объектов стенда — для сообщений упавших цепочек. */
export function describeStand(fake: FakeCaldav): string {
  return [...fake.objects.entries()]
    .map(([path, object]) => [`${path} (ETag ${object.etag})`, ...describeObject(object.ics)].join("\n"))
    .join("\n\n");
}
