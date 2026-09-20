// Семантика scope (пункт 4б задания): ожидание считается ИЗ СМЫСЛА области
// правки по затравке и патчу, а не из того, что сделал планировщик. В
// src/ical/edit.ts этот файл не заглядывает: правила взяты из описания
// языка правки (src/ical/plan.ts) и решений Р1, О7, О11.
//
// Что проверяется всегда:
// - вне области правки встречи тождественны: адрес, момент начала, момент
//   конца, всесуточность и видимые поля;
// - встреч не прибавилось и не убавилось (кроме правки повтора и удаления);
// - удалённые действительно исчезли, и только они;
// - конец серии («проба за концом») изменился только там, где это оправдано
//   патчем;
// - у каждой встречи, кроме названной при scope "this", конец строго позже
//   начала, а длительность — либо прежняя, либо ровно та, которую назвал
//   патч;
// - перенесённая встреча (своё DTSTART мимо слота) под патчем времени серии
//   остаётся на своём времени, если план не назвал её в потерях или
//   пояснениях;
// - напоминание письмом не остаётся без адресата.
//
// Что проверяется, когда ожидание считается точно:
// - патч поля (summary, description, location, участники) не двигает ни одну
//   встречу области и ставит новое значение слотам без своего компонента;
// - патч времени не трогает видимые поля и ставит слотам без своего
//   компонента ровно то время, которое следует из смысла области: у "this" —
//   названный момент целиком, у "this_and_following" и "all_series" — только
//   время суток и длительность, дата слота прежняя (Р1).
//
// Встречи со своим компонентом (переопределения, оторванные, перенесённые)
// в точное ожидание не входят: у них своё время и свои поля (О7), и оракул
// требует от них только того, что обязано выполняться всегда, — не пропасть
// и не размножиться.
import ICAL from "ical.js";
import type { CalendarObject } from "../../src/ical/object.js";
import type { EditScope } from "../../src/types.js";
import type { OraclePatch } from "./corpus.js";
import { ENV, SEP, fieldSigOf, rdateKeysOf, keyAtLeast, keyOfAddress, msOf, showSnap, sigOf, timeSigOf, type Snap, type World } from "./world.js";

export interface SemanticsCase {
  o: CalendarObject;
  before: World;
  after: World;
  op: "update" | "delete";
  scope: EditScope;
  address?: string;
  entry?: OraclePatch;
  /**
   * Адреса встреч, которые план объявил потерянными (plan.removed, О11):
   * пользователь их подтвердил, и исчезнуть им позволено. Всё остальное
   * вне области правки обязано остаться тождественным.
   */
  declaredLosses?: readonly string[];
  /**
   * Пояснения плана (plan.notices): ими план называет встречи, с которыми
   * обошёлся не как обычно. Названную в пояснении встречу оракул от
   * требования «перенесённая остаётся на своём времени» освобождает: про неё
   * пользователю сказали.
   */
  notices?: readonly string[];
}

/** Множество строк с подсчётом: сравнение наборов встреч без порядка. */
class Bag {
  private readonly counts = new Map<string, number>();

  constructor(values: Iterable<string>) {
    for (const value of values) this.counts.set(value, (this.counts.get(value) ?? 0) + 1);
  }

  take(value: string): boolean {
    const n = this.counts.get(value) ?? 0;
    if (n === 0) return false;
    if (n === 1) this.counts.delete(value);
    else this.counts.set(value, n - 1);
    return true;
  }

  rest(): string[] {
    const out: string[] = [];
    for (const [value, n] of this.counts) for (let i = 0; i < n; i += 1) out.push(value);
    return out.sort();
  }
}

const WALL = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  dateOnly: boolean;
}

function wallOf(iso: string | undefined): Wall | undefined {
  if (iso === undefined) return undefined;
  const m = WALL.exec(iso);
  if (!m) return undefined;
  return {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4] ?? 0),
    minute: Number(m[5] ?? 0),
    second: Number(m[6] ?? 0),
    dateOnly: m[4] === undefined,
  };
}

/**
 * Время суток патча поверх даты снимка, сдвинутой на `days` суток (Р1: у
 * серии берётся только время суток). Сдвиг обязателен: без него конец,
 * названный на следующие сутки после начала, ложился бы на дату начала и
 * встреча выходила бы вырожденной — см. `seriesEnd`.
 */
function timeOfDayOn(base: ICAL.Time, wall: Wall, days = 0): ICAL.Time {
  const time = base.clone();
  time.isDate = false;
  time.hour = wall.hour;
  time.minute = wall.minute;
  time.second = wall.second;
  if (days !== 0) time.adjust(days, 0, 0, 0);
  return time;
}

/** Номер дня стенной даты: разница дат считается без пояса процесса. */
function dayNumber(wall: Wall): number {
  const time = ICAL.Time.fromData(
    { year: wall.year, month: wall.month, day: wall.day, hour: 0, minute: 0, second: 0, isDate: false },
    ICAL.Timezone.utcTimezone,
  );
  return Math.round(time.toUnixTime() / 86_400);
}

/**
 * Ожидаемый конец слота у серии (Р1: из патча берутся время суток и
 * длительность, дата слота прежняя).
 *
 * - `start` и `end` вместе: у конца та же разница дат, что у них в патче, —
 *   патч «23:00 → 01:00 следующих суток» задаёт двухчасовую встречу, а не
 *   отрицательную. Прежний расчёт эту разницу терял и клал время суток конца
 *   на дату начала;
 * - `end` без `start`: дату конец выбирает сам — ближайшее такое время суток
 *   после начала, то есть следующие сутки, когда названное время суток не
 *   позже начала.
 */
function seriesEnd(start: ICAL.Time, patchStart: Wall | undefined, patchEnd: Wall): ICAL.Time {
  const days = patchStart
    ? dayNumber(patchEnd) - dayNumber(patchStart)
    : secondsOfDay(patchEnd) <= secondsOfDay(start)
      ? 1
      : 0;
  return timeOfDayOn(start, patchEnd, days);
}

/** Названный момент целиком в форме и поясе снимка (scope "this"). */
function wholeMoment(base: ICAL.Time, wall: Wall): ICAL.Time {
  const time = base.clone();
  time.isDate = false;
  time.year = wall.year;
  time.month = wall.month;
  time.day = wall.day;
  time.hour = wall.hour;
  time.minute = wall.minute;
  time.second = wall.second;
  return time;
}

/** Область правки: встречи, которых операция вправе коснуться. */
function affectedOf(c: SemanticsCase): { affected: Snap[]; known: boolean } {
  const { before, scope, address, o } = c;
  if (scope === "all_series") return { affected: [...before.snaps], known: true };
  if (address === undefined) {
    // Без адреса область называет только одиночное событие.
    if (before.snaps.length <= 1) return { affected: [...before.snaps], known: true };
    return { affected: [], known: false };
  }
  if (scope === "this") {
    return { affected: before.snaps.filter((s) => s.address === address), known: true };
  }
  const boundary = keyOfAddress(o, address);
  if (boundary === undefined) return { affected: [], known: false };
  return { affected: before.snaps.filter((s) => keyAtLeast(s.key, boundary)), known: true };
}

const TIME_FIELDS = new Set(["start", "end", "timeZone", "allDay"]);

function touchesTime(patch: Record<string, unknown>): boolean {
  return Object.keys(patch).some((key) => TIME_FIELDS.has(key));
}

function lastStart(snaps: readonly Snap[]): number {
  return snaps.length === 0 ? Number.POSITIVE_INFINITY : snaps[snaps.length - 1].startMs;
}

/**
 * Нарушения семантики области правки. Пустой список — расхождений нет.
 * Каждая строка — готовое пояснение по-русски для findings.json.
 */
export function checkSemantics(c: SemanticsCase): string[] {
  const problems: string[] = [];
  const { op, scope, entry } = c;
  const patch = (entry?.patch ?? {}) as Record<string, unknown>;
  // Упор в 400 встреч (бесконечная серия) делает хвосты миров несравнимыми:
  // сравнивается общее окно — до последней встречи, которую видели оба.
  // Запас в двое суток и рез по границе суток: у краёв упора встречи «до» и
  // «после» приходятся на разное время суток, и оба мира должны кончаться в
  // одном и том же месте, иначе счёт разойдётся на единицу.
  const edge = Math.min(lastStart(c.before.snaps), lastStart(c.after.snaps)) - 2 * 86_400_000;
  const limit = c.before.capped || c.after.capped ? Math.floor(edge / 86_400_000) * 86_400_000 : Number.POSITIVE_INFINITY;
  // Встречи со своим компонентом вне горизонта (World.beyond) прибавляются
  // после реза по упору: рез — про хвост окна, а они не в окне вовсе.
  // Без них встреча, которую scope "this" увёл к краю календаря (патч
  // start: 9999-12-31), считалась бы пропавшей — хотя она записана, годна и
  // адресуется.
  const before = { ...c.before, snaps: [...c.before.snaps.filter((s) => s.startMs < limit), ...c.before.beyond] };
  const after = { ...c.after, snaps: [...c.after.snaps.filter((s) => s.startMs < limit), ...c.after.beyond] };
  const { affected, known } = affectedOf({ ...c, before });
  const losses = new Set(c.declaredLosses ?? []);
  const affectedSet = new Set(affected);
  for (const snap of before.snaps) if (losses.has(snap.address)) affectedSet.add(snap);
  const unaffected = before.snaps.filter((s) => !affectedSet.has(s));

  // 1. Вне области правки — тождественность.
  const pool = new Bag(after.snaps.map(sigOf));
  const missing: Snap[] = [];
  for (const snap of unaffected) if (!pool.take(sigOf(snap))) missing.push(snap);
  if (missing.length > 0) {
    problems.push(
      `вне области правки изменились или исчезли встречи (${missing.length}): ` +
        missing.slice(0, 4).map(showSnap).join("; ") +
        `; после записи остались: ${after.snaps.slice(0, 8).map(showSnap).join("; ")}`,
    );
  }
  const leftovers = pool.rest();

  // 2. Число встреч в области правки. Подтверждённые потери (О11) исчезают,
  // остальные встречи области остаются: правка встреч не убирает.
  const staying = [...affectedSet].filter((s) => !losses.has(s.address)).length;
  // У бесконечной серии края упора «до» и «после» не совпадают на одну
  // встречу: сдвиг времени суток или переход на «весь день» переносит
  // последнюю встречу окна через границу суток. Поэтому у миров с упором
  // счёт сверяется с допуском в одну встречу.
  const tolerance = c.before.capped || c.after.capped ? 1 : 0;
  const recurrencePatch = patch.recurrence !== undefined;
  if (missing.length === 0 && known) {
    if (op === "delete") {
      if (leftovers.length > 0) {
        problems.push(
          `удаление оставило или добавило встречи в названной области (${leftovers.length}): ${leftovers.slice(0, 4).join("; ")}`,
        );
      }
    } else if (!recurrencePatch && Math.abs(leftovers.length - staying) > tolerance) {
      problems.push(
        `в области правки должно было остаться ${staying} встреч, после записи их ${leftovers.length}: ${leftovers.slice(0, 4).join("; ")}`,
      );
    }
  }

  // 3. Точное ожидание — только для правки (update) и только когда область известна.
  if (op === "update" && known && missing.length === 0 && affected.length > 0 && entry && losses.size === 0) {
    problems.push(...checkUpdate(c, affected, leftovers, entry));
  }

  // 4. Проба за концом серии.
  if (before.ends !== after.ends) {
    const justified = recurrencePatch || (op === "delete" && scope !== "this");
    if (!justified) {
      problems.push(
        before.ends
          ? "до записи серия кончалась в пределах горизонта, после — нет, а патч конца серии не касался"
          : "до записи серия уходила за горизонт, после — кончилась, а патч конца серии не касался",
      );
    }
  }

  // 5. Длительность встреч.
  problems.push(...checkDurations(c, before, after));

  // 6. Время перенесённых встреч под патчем времени серии.
  if (op === "update" && known && missing.length === 0) {
    problems.push(...checkMovedKeepsTime(c, affected, after, losses));
  }

  // 7. Напоминание письмом без адресата.
  problems.push(...checkEmailRecipients(before, after));

  return problems;
}

// ---------------------------------------------------------------------------
// Инварианты, которые обязаны выполняться после любой правки
// ---------------------------------------------------------------------------

/** Длительность по-русски: «75 мин», «20 ч 30 мин». */
function lengthOf(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (Math.abs(minutes) < 90) return `${minutes} мин`;
  const hours = Math.trunc(minutes / 60);
  const rest = Math.abs(minutes % 60);
  return rest === 0 ? `${hours} ч` : `${hours} ч ${rest} мин`;
}

/**
 * Длительности, которые встреча вправе иметь после правки: своя прежняя —
 * либо ровно та, которую назвал патч. Названная считается так же, как
 * ожидаемое время слотов (Р1): у одиночного события и у scope "this" патч
 * называет момент целиком, у серии из него берутся время суток и
 * длительность. Набор общий на всю область: точное соответствие «встреча ↔
 * длительность» считает checkTime, здесь проверяется только то, что
 * длительность вообще взялась откуда-то.
 *
 * Названная патчем длительность считается по слотам без своего компонента:
 * им патч времени и адресован. У встреч со своим компонентом время своё
 * (О7), и патч серии новых длительностей им не назначает — прежняя у них уже
 * учтена.
 */
function allowedDurations(c: SemanticsCase, before: World): Set<number> {
  const patch = (c.entry?.patch ?? {}) as { start?: string; end?: string };
  const out = new Set<number>();
  for (const snap of before.snaps) out.add(snap.endMs - snap.startMs);
  const start = wallOf(patch.start);
  const end = wallOf(patch.end);
  if (!start && !end) return out;
  const whole = c.scope === "this" || c.o.kind !== "series";
  const plain = before.snaps.filter((s) => s.plain);
  const shift = start && !whole && plain.length > 0 ? secondsOfDay(start) - secondsOfDay(plain[0].startTime) : 0;
  for (const snap of plain) {
    const startTime = start ? (whole ? wholeMoment(snap.startTime, start) : shifted(snap.startTime, shift)) : snap.startTime;
    const startMs = start ? msOf(startTime, ENV) : snap.startMs;
    let endMs: number;
    if (end) endMs = msOf(whole ? wholeMoment(startTime, end) : seriesEnd(startTime, start, end), ENV);
    else if (start) endMs = whole ? startMs + (snap.endMs - snap.startMs) : msOf(shifted(snap.endTime, shift), ENV);
    else continue;
    if (endMs > startMs) out.add(endMs - startMs);
  }
  return out;
}

/**
 * Инвариант длительности. После любой правки у каждой встречи — кроме той,
 * которую операция назвала при scope "this", — конец строго позже начала, а
 * длительность либо прежняя, либо ровно та, которую назвал патч.
 *
 * Вырожденные встречи бывают уже в затравке (испорченное чужим клиентом
 * время): нарушением считается только новая такая встреча, а не та, что была
 * до записи. Патч, меняющий всесуточность, длительность меняет по замыслу —
 * у него сверяется только «конец позже начала».
 */
function checkDurations(c: SemanticsCase, before: World, after: World): string[] {
  const patch = (c.entry?.patch ?? {}) as Record<string, unknown>;
  const problems: string[] = [];
  const named = c.scope === "this" ? c.address : undefined;
  const skip = (s: Snap) => named !== undefined && s.address === named;

  const wasDegenerate = before.snaps.filter((s) => !skip(s) && s.endMs <= s.startMs).length;
  const degenerate = after.snaps.filter((s) => !skip(s) && s.endMs <= s.startMs);
  if (degenerate.length > wasDegenerate) {
    problems.push(
      `после записи конец встречи не позже её начала (таких ${degenerate.length}, до записи было ${wasDegenerate}): ` +
        degenerate.slice(0, 4).map(showSnap).join("; "),
    );
  }

  if (patch.allDay !== undefined) return problems;
  const allowed = allowedDurations(c, before);
  const wrong = after.snaps.filter((s) => !skip(s) && s.endMs > s.startMs && !allowed.has(s.endMs - s.startMs));
  if (wrong.length > 0) {
    const sample = wrong.slice(0, 4).map((s) => `${showSnap(s)} — ${lengthOf(s.endMs - s.startMs)}`);
    const could = [...allowed]
      .filter((ms) => ms > 0)
      .sort((a, b) => a - b)
      .slice(0, 8)
      .map(lengthOf);
    problems.push(
      `после записи длительность встречи не прежняя и не названная патчем (таких ${wrong.length}): ${sample.join("; ")}; ` +
        `допустимы были ${could.join(", ")}`,
    );
  }
  return problems;
}

/**
 * Время перенесённой встречи. У переопределения со своим DTSTART, не
 * совпадающим со слотом, время своё (О7), и патч времени серии его не
 * двигает: сдвигаются слоты, а не перенесённые встречи. Освобождается от
 * требования только та встреча, которую план сам назвал — в removed или в
 * пояснениях (О11): про неё пользователю сказано.
 */
function checkMovedKeepsTime(c: SemanticsCase, affected: Snap[], after: World, losses: Set<string>): string[] {
  const patch = (c.entry?.patch ?? {}) as { start?: string; end?: string };
  if (c.scope === "this") return [];
  if (patch.start === undefined && patch.end === undefined) return [];
  const spoken = (c.notices ?? []).join(" ");
  // Пояснение, в котором назван только адрес самого вызова, про встречу
  // ничего не говорит: это пересказ запроса (граница области), а не «с этой
  // встречей обошлись иначе». Названной считается встреча с другим адресом.
  const named = (snap: Snap) => snap.address !== c.address && spoken.includes(snap.address);
  const moments = new Bag(after.snaps.map((s) => `${s.startMs}${SEP}${s.endMs}`));
  const problems: string[] = [];
  for (const snap of affected) {
    if (!snap.moved) continue;
    if (losses.has(snap.address) || named(snap)) continue;
    if (moments.take(`${snap.startMs}${SEP}${snap.endMs}`)) continue;
    problems.push(
      `перенесённая встреча ${snap.address} под патчем времени серии не осталась на своём времени: было ` +
        `${new Date(snap.startMs).toISOString()}–${new Date(snap.endMs).toISOString()}, ` +
        `таких моментов после записи нет; план её ни в потерях, ни в пояснениях не назвал. ` +
        `После записи: ${after.snaps.slice(0, 8).map(showSnap).join("; ")}`,
    );
    break;
  }
  return problems;
}

/**
 * Напоминание письмом без адресата. RFC 5545 §3.6.6 требует у VALARM
 * ACTION:EMAIL хотя бы один ATTENDEE: письму нужен получатель. Сверяются
 * подписи напоминаний, а не их число: у серии один и тот же компонент виден
 * столько раз, сколько у неё встреч.
 */
function checkEmailRecipients(before: World, after: World): string[] {
  const without = (world: World) =>
    new Set(world.snaps.filter((s) => s.alarms.emailWithoutRecipient > 0).map((s) => s.alarms.signature));
  const was = without(before);
  const fresh = [...without(after)].filter((signature) => !was.has(signature));
  if (fresh.length === 0) return [];
  return [`после записи напоминание письмом осталось без адресата (ATTENDEE): ${fresh.slice(0, 2).join(" | ")}`];
}

function checkUpdate(c: SemanticsCase, affected: Snap[], leftovers: string[], entry: OraclePatch): string[] {
  const problems: string[] = [];
  const patch = entry.patch as Record<string, unknown> & { timeZone?: string; start?: string; end?: string; allDay?: boolean };
  const changed = new Set(leftovers);

  if (entry.kind === "field" && entry.field) {
    // Патч поля не вправе двигать встречи: адрес, моменты и всесуточность те же.
    const times = new Bag(leftovers.map((sig) => sig.split(SEP).slice(0, 4).join(SEP)));
    const moved = affected.filter((s) => !times.take(timeSigOf(s)));
    if (moved.length > 0) {
      problems.push(
        `патч поля ${entry.field} сдвинул встречи или сменил их адрес (${moved.length}): ${moved.slice(0, 4).map(showSnap).join("; ")}`,
      );
    }
    // Слоты без своего компонента обязаны принять новое значение.
    const want = entry.field === "attendees" ? "oracle@example.com" : String(patch[entry.field] ?? "");
    const index = new Map<string, string[]>();
    for (const sig of changed) {
      const parts = sig.split(SEP);
      const key = parts.slice(0, 4).join(SEP);
      const list = index.get(key) ?? [];
      list.push(sig);
      index.set(key, list);
    }
    const position = { summary: 4, description: 5, location: 6, status: 7, attendees: 8 }[entry.field];
    for (const snap of affected) {
      if (!snap.plain) continue;
      const list = index.get(timeSigOf(snap));
      if (!list || list.length === 0) continue;
      const value = list[0].split(SEP)[position];
      const ok = entry.field === "attendees" ? value.includes(want) : value === want;
      if (!ok) {
        problems.push(`слоту ${snap.address} патч ${entry.field} не применён: ожидалось ${JSON.stringify(want)}, в выдаче ${JSON.stringify(value)}`);
        break;
      }
    }
    return problems;
  }

  if (entry.kind === "time") {
    // Патч времени не вправе менять видимые поля.
    const fields = new Bag(leftovers.map((sig) => sig.split(SEP).slice(4).join(SEP)));
    const spoiled = affected.filter((s) => !fields.take(fieldSigOf(s)));
    if (spoiled.length > 0 && patch.summary === undefined) {
      problems.push(
        `патч времени изменил видимые поля встреч (${spoiled.length}): ${spoiled.slice(0, 4).map(showSnap).join("; ")}`,
      );
    }
    problems.push(...checkTime(c, affected, leftovers, entry));
    return problems;
  }

  // Патч одного пояса: моменты сохраняются у начала серии (якорь), дальше
  // ими правит стенное время нового пояса (перевод часов).
  if (patch.timeZone !== undefined && patch.start === undefined && patch.end === undefined && patch.allDay === undefined) {
    // Якорь — первая встреча области: её момент смена пояса сохраняет
    // (DTSTART серии или начало продолжения). Если первая встреча области
    // со своим компонентом, якоря нет: у неё своё время (О7).
    const anchor = affected[0]?.plain ? affected[0] : undefined;
    if (anchor) {
      const moments = new Bag(leftovers.map((sig) => sig.split(SEP).slice(1, 4).join(SEP)));
      if (!moments.take([anchor.startMs, anchor.endMs, anchor.allDay ? "D" : "T"].join(SEP))) {
        problems.push(
          `смена пояса без start сдвинула начало области: у ${anchor.address} было ` +
            `${new Date(anchor.startMs).toISOString()}–${new Date(anchor.endMs).toISOString()}, ` +
            `в выдаче таких моментов нет: ${leftovers.slice(0, 4).join("; ")}`,
        );
      }
    }
    return problems;
  }

  // kind "invariant": сверх инвариантов области ожидания нет.
  if (!touchesTime(patch) && patch.recurrence === undefined) {
    const fields = new Bag(leftovers.map((sig) => sig.split(SEP).slice(0, 4).join(SEP)));
    const moved = affected.filter((s) => !fields.take(timeSigOf(s)));
    if (moved.length > 0) {
      problems.push(`патч ${entry.name} сдвинул встречи, хотя времени не касался (${moved.length}): ${moved.slice(0, 3).map(showSnap).join("; ")}`);
    }
  }
  return problems;
}

/**
 * Ожидаемое время слотов без своего компонента.
 *
 * У одиночного события и у scope "this" патч называет момент целиком. У
 * серии (this_and_following, all_series) из патча берутся только время суток
 * и длительность, а даты слотов остаются прежними (Р1); значения RDATE
 * сдвигаются на ту же стенную разницу, что и слоты правила, — поэтому
 * ожидание считается сдвигом стенного времени, одинаковым для всей области.
 */
function checkTime(c: SemanticsCase, affected: Snap[], leftovers: string[], entry: OraclePatch): string[] {
  const patch = entry.patch as { start?: string; end?: string; timeZone?: string };
  const start = wallOf(patch.start);
  const end = wallOf(patch.end);
  if (patch.start !== undefined && !start) return [];
  if (patch.end !== undefined && !end) return [];

  const moments = new Bag(leftovers.map((sig) => sig.split(SEP).slice(1, 4).join(SEP)));
  const problems: string[] = [];
  // У серии правка времени берёт из патча только время суток и длительность
  // (Р1), у одиночного события — названный момент целиком: даты серии, за
  // которую надо держаться, у него нет.
  const whole = c.scope === "this" || c.o.kind !== "series";
  const plain = affected.filter((s) => s.plain);
  if (plain.length === 0) return problems;
  // Стенной сдвиг области: время суток из патча минус время суток первой
  // встречи области. У правила он даёт ровно время суток патча, у RDATE —
  // тот же сдвиг (Р1).
  const shift = start && !whole ? secondsOfDay(start) - secondsOfDay(plain[0].startTime) : 0;
  const rdate = rdateKeysOf(c.o);

  for (const snap of plain) {
    if (snap.allDay && ((start && !start.dateOnly) || (end && !end.dateOnly))) continue; // отказ по форме — законный исход
    if (!snap.allDay && ((start && start.dateOnly) || (end && end.dateOnly))) continue;
    if (end && rdate.has(snap.key)) continue; // свой конец периода RDATE — своё правило

    let startMs = snap.startMs;
    let endMs = snap.endMs;
    let startTime: ICAL.Time | undefined;
    if (start) {
      startTime = whole ? wholeMoment(snap.startTime, start) : shifted(snap.startTime, shift);
      startMs = msOf(startTime, ENV);
    }
    if (end) {
      // Конец: у одиночного события и у "this" — названный момент, у серии —
      // то же время суток на дате начала встречи, сдвинутой на разницу дат
      // start и end в патче (seriesEnd).
      const base = startTime ?? snap.startTime;
      const time = whole ? wholeMoment(base, end) : seriesEnd(base, start, end);
      endMs = msOf(time, ENV);
    } else if (startTime) {
      // start без end сохраняет длительность: конец идёт тем же сдвигом.
      endMs = whole ? startMs + (snap.endMs - snap.startMs) : msOf(shifted(snap.endTime, shift), ENV);
    }
    if (endMs <= startMs) continue; // такой патч — законный отказ invalid-time

    const want = [startMs, endMs, snap.allDay ? "D" : "T"].join(SEP);
    if (!moments.take(want)) {
      problems.push(
        `слот ${snap.address}: ожидалось ${new Date(startMs).toISOString()}–${new Date(endMs).toISOString()}, ` +
          `в выдаче таких нет; изменённые встречи: ${leftovers.slice(0, 4).join("; ")}`,
      );
      break;
    }
  }
  return problems;
}

function secondsOfDay(t: ICAL.Time | Wall): number {
  return t.hour * 3600 + t.minute * 60 + t.second;
}

/** Стенное время, сдвинутое на seconds; момент считается по поясу значения. */
function shifted(t: ICAL.Time, seconds: number): ICAL.Time {
  const time = t.clone();
  time.isDate = false;
  if (seconds !== 0) time.adjust(0, 0, 0, seconds);
  return time;
}
