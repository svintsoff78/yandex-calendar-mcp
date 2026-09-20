import type ICAL from "ical.js";
import { deleteObject, putObjectWithStatus, queryEventByUid, type RawObject } from "../caldav/objects.js";
import { CaldavError } from "../caldav/request.js";
import { isUnparsable, loadObject, semanticDigest, shownOverride, type CalendarObject } from "../ical/object.js";
import { SERIES_CAP, SlotScanError, iterateSlots } from "../ical/slots.js";
import { compareSlotKeys, formatForModel, type IcalEnv, type SlotKey } from "../ical/values.js";
import type { Calendar, Context, ObjectIO, RemoveOutcome, WriteCondition, WriteFailure } from "../types.js";
import { hrefFor } from "./events.js";

/**
 * Доставка записи на сервер (задача З12 плана переделки,
 * docs/superpowers/plans/2026-09-19-recurring-events-rework.md, решения Р8 и
 * Р9 с поправками по живой сверке — docs/yandex-caldav-capabilities.md,
 * Ж12–Ж16).
 *
 * - PUT и DELETE уходят на сервер ровно один раз (транспорт их не
 *   повторяет, src/caldav/request.ts). Ответ разбирается так:
 *   – 2xx на правке (PUT с If-Match прочитанного ETag) — успех, но только
 *     если это 204 или 200, то есть заменён существующий объект. Ответ 201
 *     значит, что объекта по пути не было: Яндекс такой PUT не отклоняет, а
 *     создаёт объект нашим текстом (Ж16). Между нашим чтением и записью
 *     событие удалил другой клиент, и мы его воскресили — уже с правкой.
 *     Это конфликт, а не успех: `DeliveryError` с кодом conflict и пометкой
 *     `recreated`, в тексте сказано и про удаление, и про то, что событие
 *     создано заново. Компенсирующего DELETE нет: в воскрешённом объекте
 *     лежит правка пользователя, а удалять вслепую — стирать данные, которых
 *     мы не читали (тот же запрет, что при разрезе серии, J-B1, J-B8).
 *     У создания (PUT с If-None-Match) 201 — обычный исход и ничего не
 *     значит: там объекта и не должно было быть;
 *   – 412 на правке — событие изменили после чтения (Ж14), 404 — объекта по
 *     пути нет; обе записи не выполнены, обе — конфликт;
 *   – прочий 4xx — отказ сервера, ничего не изменено.
 *   Если исход неизвестен (сеть, таймаут, 5xx), объект перечитывается по
 *   UID и правила проверяются строго по порядку (Р8):
 *   1. объекта нет — DELETE «уже удалено», правка — конфликт, создание —
 *      одна повторная попытка с If-None-Match;
 *   2. ETag и смысл прежние — запись не дошла, одна повторная попытка;
 *   3. смысл равен ожидаемому и отличается от прежнего — «применено»;
 *   4. иначе — «результат неизвестен» с текущим состоянием.
 *   Смысл — `semanticDigest` (раскрытые слоты, основные поля, переопределения
 *   по RECURRENCE-ID): ETag меняется при любой записи (Ж12), текст правила и
 *   VTIMEZONE сервер переписывает (Ж5, Ж10). Если ожидаемый смысл равен
 *   прежнему (запись меняла только то, что в дайджест не входит), применённую
 *   запись от недошедшей по смыслу не отличить — решает ETag.
 * - Дайджест прежнего состояния считает вызывающий, один раз, и передаёт в
 *   `before`: у давней частой серии он считается около секунды. Здесь
 *   считается только то, без чего правило не проверить: при успехе — ничего.
 * - Каждое удаление предваряется чтением и сверкой ETag с прочитанным ранее:
 *   If-Match на DELETE Яндекс не соблюдает (Ж15). Несовпадение — отказ
 *   «событие изменили», DELETE не уходит. Узкое окно гонки между чтением и
 *   DELETE остаётся.
 * - Разрез серии (`writeSplit`, Р9): продолжение создаётся раньше усечения
 *   исходной серии. Существует ли продолжение, узнаётся чтением до создания:
 *   If-None-Match Яндекс не соблюдает и молча перезаписывает (Ж13).
 *   Компенсирующего DELETE при сбое нет (J-B1, J-B8).
 *
 * Сбой чтения до первой записи (поиск перед DELETE, поиск продолжения)
 * бросается как есть: ничего не записано. Все прочие неудачи — `DeliveryError`
 * с кодом.
 */

// ─────────────────────────────── порт ввода-вывода ───────────────────────────────

/**
 * Исход PUT с одной добавкой к `PutOutcome`: `created` — сервер ответил 201,
 * то есть объекта по пути не было и он создан этой записью. Поле
 * необязательное, поэтому обычный `ObjectIO` этому порту удовлетворяет:
 * подставной ввод-вывод, который кода ответа не знает, просто его не ставит,
 * и всё работает как раньше.
 */
export type DeliveryPutOutcome = { status: "applied"; etag: string; created?: true } | WriteFailure;

/** Порт `ObjectIO`, чей `put` отличает создание объекта от замены (Ж16). */
export interface DeliveryIO extends Omit<ObjectIO, "put"> {
  put(href: string, ics: string, condition: WriteCondition): Promise<DeliveryPutOutcome>;
}

/**
 * Порт `DeliveryIO` для контекста: `Context.io`, если задан, иначе — CalDAV
 * через `queryEventByUid`, `putObjectWithStatus` и `deleteObject`. Путь и
 * ETag берутся из ответа сервера, а не собираются из UID (Ж2 в
 * «Особенностях» docs/yandex-caldav-capabilities.md). `put` и `remove` не
 * бросают: исход записи — значение.
 *
 * Пустой ETag (сервер его не прислал) транспорт в If-Match не ставит: запись
 * тогда безусловная (src/caldav/objects.ts, putObjectWithStatus и
 * deleteObject).
 */
export function ioFor(ctx: Context): DeliveryIO {
  if (ctx.io) return ctx.io;
  const client = ctx.client;
  return {
    find: (calendar, uid) => queryEventByUid(client, calendar.href, uid),
    async put(href, ics, condition): Promise<DeliveryPutOutcome> {
      const options = condition.ifMatch !== undefined ? { ifMatch: condition.ifMatch } : { ifNoneMatch: true };
      try {
        const { status, etag } = await putObjectWithStatus(client, href, ics, options);
        // 201 Created: по пути ничего не лежало, объект создан этой записью.
        // Что это значит, решает вызывающий: у создания — ничего, у правки —
        // что событие успели удалить (Ж16).
        return status === 201 ? { status: "applied", etag, created: true } : { status: "applied", etag };
      } catch (error) {
        return failureOf(error);
      }
    },
    async remove(href, ifMatch): Promise<RemoveOutcome> {
      try {
        await deleteObject(client, href, ifMatch);
        return { status: "applied" };
      } catch (error) {
        return failureOf(error);
      }
    },
  };
}

// Исход неудачной записи по ошибке транспорта (Р8): 412 и 404 — отдельно,
// прочие 4xx — запись точно не применена, всё остальное — неизвестно. Ошибка
// не от транспорта (её быть не должно) — тоже «неизвестно»: это ведёт к
// перечитыванию, а не к ложному «не применено».
function failureOf(error: unknown): WriteFailure {
  if (error instanceof CaldavError) {
    if (error.status === 412) return { status: "precondition-failed" };
    if (error.status === 404) return { status: "not-found" };
    if (error.applied === "no") return { status: "rejected", error };
    return { status: "unknown", error };
  }
  return { status: "unknown", error: error instanceof Error ? error : new Error(String(error)) };
}

// ─────────────────────────────── типы ───────────────────────────────

/**
 * Состояние объекта, прочитанное в этом же вызове (`io.find`): основа
 * условной записи и сверки по Р8.
 */
export interface KnownState {
  uid: string;
  href: string;
  etag: string;
  /** `semanticDigest` прочитанного текста — посчитан вызывающим один раз. */
  digest: string;
}

/**
 * Что записать:
 * - `put` — замена объекта из `before` с If-Match его ETag;
 * - `create` — новый объект по пути `href` с If-None-Match: *;
 * - `delete` — удаление объекта из `before` (с чтением и сверкой ETag до DELETE).
 * `digest` — ожидаемый дайджест `ics`, если вызывающий его уже посчитал.
 */
export type Write =
  | { kind: "put"; ics: string; digest?: string }
  | { kind: "create"; uid: string; href: string; ics: string; digest?: string }
  | { kind: "delete" };

/** Запись дошла. */
export interface Delivered {
  /** Путь объекта (у DELETE — удалённого). */
  href: string;
  /** ETag после записи; "" — сервер его не прислал, а также у DELETE. */
  etag: string;
  /** Исход установлен перечитыванием (Р8), а не ответом сервера. */
  confirmedByReread: boolean;
  /** Понадобилась одна повторная попытка: первая запись не дошла (правило 2, у создания — 1). */
  retried: boolean;
  /** DELETE: объект удалил кто-то другой — до нашего DELETE или вместо него (404). */
  alreadyGone?: true;
  /** Создание: объект с тем же смыслом уже был на сервере (412 и сверка). */
  alreadyExists?: true;
}

/**
 * Коды неудачи доставки:
 * - conflict — событие изменили или удалили после чтения; запись не
 *   выполнена, и только в одном случае выполнена не так, как задумано:
 *   правка ушла по пути удалённого события и создала его заново (Ж16) —
 *   у такой ошибки стоит `recreated`, и об этом сказано в тексте;
 * - rejected — сервер отклонил запись (4xx), ничего не изменено;
 * - not-delivered — запись не дошла и после одной повторной попытки;
 *   объект на сервере прежний;
 * - unknown — результат неизвестен: перечитать не удалось или на сервере
 *   ни прежнее, ни ожидаемое состояние (`current` — что там сейчас);
 * - exists — создаваемый объект уже есть на сервере и отличается;
 * - split-stale-continuation — продолжение разреза уже есть и не совпадает
 *   с планом; ничего не записано (`differences`);
 * - split-incomplete — продолжение создано, исходную серию усечь не удалось;
 *   причина — в `cause`, хвост виден дважды, повтор того же вызова безопасен.
 */
export type DeliveryErrorCode =
  | "conflict"
  | "rejected"
  | "not-delivered"
  | "unknown"
  | "exists"
  | "split-stale-continuation"
  | "split-incomplete";

export interface DeliveryErrorDetails {
  /** Что делать пользователю; в `message` идёт после `reason`. */
  advice?: string;
  current?: RawObject;
  continuation?: { uid: string; href: string };
  differences?: readonly string[];
  /** Правка создала удалённое событие заново (ответ 201, Ж16). */
  recreated?: true;
  cause?: unknown;
}

export class DeliveryError extends Error {
  readonly code: DeliveryErrorCode;
  /** Что случилось, без совета: для вложения в текст другой ошибки (разрез). */
  readonly reason: string;
  /** Что делать пользователю. */
  readonly advice?: string;
  /** Объект на сервере, каким его увидело последнее чтение. */
  readonly current?: RawObject;
  /** Продолжение разреза, о котором идёт речь. */
  readonly continuation?: { uid: string; href: string };
  /** Чем продолжение на сервере отличается от плана (split-stale-continuation). */
  readonly differences?: readonly string[];
  /**
   * Запись не просто не удалась: она ушла по пути события, удалённого после
   * нашего чтения, и сервер создал его заново нашим текстом (Ж16). Объект на
   * сервере есть, но это уже не то событие, которое мы правили.
   */
  readonly recreated?: true;

  constructor(code: DeliveryErrorCode, reason: string, details: DeliveryErrorDetails = {}) {
    super(details.advice ? `${reason} ${details.advice}` : reason, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "DeliveryError";
    this.code = code;
    this.reason = reason;
    if (details.advice) this.advice = details.advice;
    if (details.current) this.current = details.current;
    if (details.continuation) this.continuation = details.continuation;
    if (details.differences) this.differences = details.differences;
    if (details.recreated) this.recreated = details.recreated;
  }
}

// ─────────────────────────────── deliver ───────────────────────────────

/**
 * Доставляет одну запись по правилам Р8 (см. шапку модуля). `before` —
 * состояние, прочитанное в этом вызове; для `put` и `delete` обязательно,
 * для `create` не нужно. Успех — `Delivered`, неудача — `DeliveryError`.
 */
export async function deliver(
  io: DeliveryIO,
  calendar: Calendar,
  write: Write,
  before: KnownState | undefined,
  env: IcalEnv,
): Promise<Delivered> {
  if (write.kind === "create") return deliverCreate(io, calendar, write, env);
  if (!before) {
    throw new Error("Правке и удалению нужно прочитанное в этом же вызове состояние объекта (before): путь, ETag и дайджест.");
  }
  return write.kind === "put" ? deliverPut(io, calendar, write, before, env) : deliverDelete(io, calendar, before, env);
}

const TRY_LATER = "Повторите операцию позже.";
const REREAD = "Перечитайте событие и решите, повторять ли операцию.";
const RETRY_FRESH = "Перечитайте событие и повторите операцию.";
const RETRY_DELETE = "Перечитайте событие и повторите удаление с новым etag.";

async function deliverPut(
  io: DeliveryIO,
  calendar: Calendar,
  write: Extract<Write, { kind: "put" }>,
  before: KnownState,
  env: IcalEnv,
): Promise<Delivered> {
  const expected = lazy(() => write.digest ?? semanticDigest(write.ics, env));
  for (let attempt = 1; ; attempt += 1) {
    const retried = attempt > 1;
    const outcome = await io.put(before.href, write.ics, { ifMatch: before.etag });
    switch (outcome.status) {
      case "applied":
        // Ответ 201 на замену прочитанного объекта: по пути ничего не было,
        // и Яндекс не отказал, а создал событие нашим текстом (Ж16).
        if (outcome.created) throw recreatedError(before.href);
        return { href: before.href, etag: outcome.etag, confirmedByReread: false, retried };
      case "precondition-failed":
        throw new DeliveryError("conflict", "Событие изменили после того, как его прочитали: запись не выполнена.", { advice: RETRY_FRESH });
      case "not-found":
        throw new DeliveryError("conflict", `Событие удалили после того, как его прочитали: по пути ${before.href} его больше нет, запись не выполнена.`);
      case "rejected":
        throw rejectedError(outcome.error);
      case "unknown":
        break;
    }

    const current = await reread(io, calendar, before.uid, outcome);
    const verdict = judge(current, before, expected, env);
    switch (verdict) {
      case "absent":
        throw new DeliveryError(
          "conflict",
          "Событие удалили, пока шла запись: ответа сервера не было, а при перечитывании события на сервере нет; правка не записана.",
          { cause: outcome.error },
        );
      case "applied":
        return { href: current!.href, etag: current!.etag, confirmedByReread: true, retried };
      case "unchanged":
        if (!retried) continue;
        throw notDelivered(outcome.error);
      case "other":
        throw unknownError(current!, outcome.error);
    }
  }
}

async function deliverCreate(
  io: DeliveryIO,
  calendar: Calendar,
  write: Extract<Write, { kind: "create" }>,
  env: IcalEnv,
): Promise<Delivered> {
  const expected = lazy(() => write.digest ?? semanticDigest(write.ics, env));
  for (let attempt = 1; ; attempt += 1) {
    const retried = attempt > 1;
    const outcome = await io.put(write.href, write.ics, { ifNoneMatch: "*" });
    switch (outcome.status) {
      case "applied":
        return { href: write.href, etag: outcome.etag, confirmedByReread: false, retried };
      case "not-found":
        throw rejectedError(new Error(`Сервер не нашёл, куда создать событие (${write.href}): ответ 404.`));
      case "rejected":
        throw rejectedError(outcome.error);
      case "precondition-failed":
      case "unknown":
        break;
    }

    // 412 (сервер соблюдает If-None-Match) или неизвестный исход: что лежит
    // на сервере под этим UID.
    const occupied = outcome.status === "precondition-failed";
    const current = await reread(io, calendar, write.uid, outcome);
    if (!current) {
      if (occupied) {
        throw new DeliveryError("conflict", `По пути ${write.href} уже лежит другой объект (ответ 412): событие с UID ${write.uid} не создано.`);
      }
      if (!retried) continue; // правило 1: создание не дошло — одна повторная попытка
      throw notDelivered(outcome.status === "unknown" ? outcome.error : undefined);
    }
    if (semanticDigest(current.ics, env) === expected()) {
      return {
        href: current.href,
        etag: current.etag,
        confirmedByReread: true,
        retried,
        ...(occupied ? { alreadyExists: true as const } : {}),
      };
    }
    if (occupied) {
      throw new DeliveryError("exists", `Событие с UID ${write.uid} уже есть на сервере и отличается от создаваемого; ничего не записано.`, {
        current,
      });
    }
    throw unknownError(current, outcome.status === "unknown" ? outcome.error : undefined);
  }
}

async function deliverDelete(io: DeliveryIO, calendar: Calendar, before: KnownState, env: IcalEnv): Promise<Delivered> {
  // Ж15: If-Match на DELETE Яндекс не соблюдает — ETag сверяется здесь, по
  // свежему чтению. Сбой этого чтения бросается как есть: ничего не записано.
  const found = await io.find(calendar, before.uid);
  if (!found) return { href: before.href, etag: "", confirmedByReread: true, retried: false, alreadyGone: true };
  if (found.etag !== before.etag || found.href !== before.href) {
    throw new DeliveryError(
      "conflict",
      `Событие изменили после того, как его прочитали (${
        found.href !== before.href ? `теперь оно по пути ${found.href}, а не ${before.href}` : `ETag ${found.etag} вместо ${before.etag}`
      }): удаление не выполнено.`,
      { current: found, advice: RETRY_DELETE },
    );
  }

  for (let attempt = 1; ; attempt += 1) {
    const retried = attempt > 1;
    const outcome = await io.remove(before.href, before.etag);
    if (outcome.status === "applied") return { href: before.href, etag: "", confirmedByReread: false, retried };
    if (outcome.status === "rejected") throw rejectedError(outcome.error);

    // Неизвестный исход, 404 или 412 — перечитывание (Р8).
    const current = await reread(io, calendar, before.uid, outcome);
    if (!current) {
      return {
        href: before.href,
        etag: "",
        confirmedByReread: true,
        retried,
        ...(outcome.status === "not-found" ? { alreadyGone: true as const } : {}),
      };
    }
    const verdict = judge(current, before, undefined, env);
    if (verdict === "unchanged") {
      if (!retried) continue;
      throw notDelivered(outcome.status === "unknown" ? outcome.error : undefined);
    }
    if (outcome.status === "unknown") {
      throw unknownError(current, outcome.error, "Удаление не подтверждено: событие на сервере есть, но уже не в том виде, в каком его прочитали, — возможно, его изменил другой клиент.");
    }
    // 412 или 404: сервер ответил, DELETE точно не применён.
    throw new DeliveryError(
      "conflict",
      `Событие изменили после того, как его прочитали (ответ ${outcome.status === "precondition-failed" ? 412 : 404}): удаление не выполнено.`,
      { current, advice: RETRY_DELETE },
    );
  }
}

// ─────────────────────────────── правила Р8 ───────────────────────────────

type Verdict = "absent" | "unchanged" | "applied" | "other";

/**
 * Правила Р8 по перечитанному состоянию, строго по порядку: 1 — объекта нет;
 * 2 — ETag и смысл прежние (запись не дошла); 3 — смысл равен ожидаемому
 * (применено); 4 — прочее. `expected` не задан у DELETE: там ожидается
 * отсутствие объекта. Дайджест перечитанного считается не больше одного
 * раза и только если без него правило не решить.
 *
 * Если ожидаемый смысл равен прежнему (запись меняла только то, что в
 * дайджест не входит), правило 3 срабатывает лишь при сменившемся ETag —
 * при прежнем ETag раньше срабатывает правило 2. То есть решает ETag, как
 * требует Р8: он меняется при любой записи (Ж12).
 */
function judge(current: RawObject | undefined, before: KnownState, expected: (() => string) | undefined, env: IcalEnv): Verdict {
  if (!current) return "absent";
  const digest = lazy(() => semanticDigest(current.ics, env));
  if (current.etag === before.etag && digest() === before.digest) return "unchanged";
  if (expected && digest() === expected()) return "applied";
  return "other";
}

async function reread(io: DeliveryIO, calendar: Calendar, uid: string, outcome: WriteFailure): Promise<RawObject | undefined> {
  try {
    return await io.find(calendar, uid);
  } catch (error) {
    const reason = messageOf(error);
    if (outcome.status === "precondition-failed") {
      throw new DeliveryError("conflict", `Сервер ответил 412: событие изменили после чтения, запись не выполнена (перечитать его не удалось: ${reason}).`, {
        cause: error,
        advice: RETRY_FRESH,
      });
    }
    const what =
      outcome.status === "unknown"
        ? `ответа сервера на запись нет (${transportNote(outcome.error)})`
        : `сервер ответил ${outcome.status === "not-found" ? 404 : 412}`;
    throw new DeliveryError("unknown", `Результат записи неизвестен: ${what}, а перечитать событие не удалось (${reason}).`, {
      cause: error,
      advice: REREAD,
    });
  }
}

// Правка ушла по пути события, удалённого после нашего чтения, и сервер
// создал его заново (Ж16). Компенсирующего DELETE нет: в объекте лежит
// правка пользователя, а между нашим PUT и таким DELETE объект мог успеть
// измениться — стереть его вслепую значит потерять чужие данные.
function recreatedError(href: string): DeliveryError {
  return new DeliveryError(
    "conflict",
    `Событие удалили после того, как его прочитали: по пути ${href} его уже не было, и сервер не отклонил запись, а создал событие заново — сейчас оно снова на сервере, уже с вашими изменениями.`,
    {
      advice: "Проверьте событие: если его удаляли намеренно, удалите заново; если нет — изменения уже на месте.",
      recreated: true,
    },
  );
}

function rejectedError(error: Error): DeliveryError {
  return new DeliveryError("rejected", `Сервер отклонил запись, ничего не изменено: ${error.message}`, { cause: error });
}

function notDelivered(cause: Error | undefined): DeliveryError {
  return new DeliveryError(
    "not-delivered",
    `Запись не дошла до сервера и после одной повторной попытки, событие на сервере прежнее${cause ? ` (${transportNote(cause)})` : ""}.`,
    cause ? { cause, advice: TRY_LATER } : { advice: TRY_LATER },
  );
}

function unknownError(current: RawObject, cause: Error | undefined, lead?: string): DeliveryError {
  const text =
    lead ??
    "Результат записи неизвестен: ответа сервера не было, а событие на сервере не совпадает ни с прежним, ни с записываемым — возможно, его изменил другой клиент.";
  return new DeliveryError("unknown", text, cause ? { current, cause, advice: REREAD } : { current, advice: REREAD });
}

// ─────────────────────────────── writeSplit ───────────────────────────────

/**
 * Записи разреза серии «эта и следующие» (Р9): продолжение с новым UID и
 * усечённая исходная серия. Вариант `split` плана записи (src/ical/plan.ts)
 * подходит структурно.
 */
export interface SplitWrite {
  continuation: { uid: string; ics: string };
  truncated: { ics: string };
}

export interface SplitDelivered {
  continuation: {
    uid: string;
    href: string;
    /** ETag продолжения; "" — сервер его не прислал. */
    etag: string;
    /** false — продолжение уже было на сервере и совпало с планом (повтор разреза). */
    created: boolean;
  };
  truncated: Delivered;
}

/**
 * Разрез серии (Р9 с поправкой по Ж13):
 * 1. Чтение продолжения по UID. Есть и по смыслу равно плану — его не пишем
 *    (повтор после сорванного усечения). Есть и отличается —
 *    `split-stale-continuation` с различиями, без записей (J-A2).
 * 2. Иначе PUT продолжения с If-None-Match по пути `hrefFor(calendar, uid)`;
 *    при 412 или неизвестном исходе — перечитывание и сверка с дайджестом
 *    плана (правила Р8, `deliver`).
 * 3. Усечение исходной серии с If-Match прочитанного ETag (`current`) — только
 *    после того, как продолжение подтверждено.
 * Сорвалось усечение — `split-incomplete`: продолжение названо, хвост виден
 * дважды, повтор того же вызова дописывает только усечение. Компенсирующего
 * DELETE нет. Отдельно назван случай, когда исходную серию удалили до
 * усечения и наша запись создала её заново (Ж16): дописывать нечего, но
 * серия, которую удалили, вернулась — об этом сказано в отказе.
 */
export async function writeSplit(
  io: DeliveryIO,
  calendar: Calendar,
  current: KnownState,
  plan: SplitWrite,
  env: IcalEnv,
): Promise<SplitDelivered> {
  const { uid, ics } = plan.continuation;
  if (uid === current.uid) throw new Error(`У продолжения разреза тот же UID, что у исходной серии (${uid}).`);
  const href = hrefFor(calendar, uid);
  const expected = lazy(() => semanticDigest(ics, env));

  let continuation: SplitDelivered["continuation"];
  const existing = await io.find(calendar, uid);
  if (existing) {
    if (semanticDigest(existing.ics, env) !== expected()) throw staleContinuation(existing, plan, env);
    continuation = { uid, href: existing.href, etag: existing.etag, created: false };
  } else {
    let created: Delivered;
    try {
      created = await deliver(io, calendar, { kind: "create", uid, href, ics }, undefined, env);
    } catch (error) {
      if (!(error instanceof DeliveryError)) throw error;
      if (error.current && (error.code === "exists" || error.code === "unknown")) throw staleContinuation(error.current, plan, env, error);
      throw continuationFailed(error, { uid, href });
    }
    continuation = { uid, href: created.href, etag: created.etag, created: !created.alreadyExists };
  }

  try {
    return { continuation, truncated: await deliver(io, calendar, { kind: "put", ics: plan.truncated.ics }, current, env) };
  } catch (error) {
    if (!(error instanceof DeliveryError)) throw error;
    // Исходная серия точно прежняя, только если усечение не дошло или сервер
    // его отклонил; иначе её, похоже, изменил или удалил другой клиент.
    const intact = error.code === "not-delivered" || error.code === "rejected";
    // Особый случай: исходную серию удалили до нашего усечения, и сервер
    // создал её заново усечённым текстом (Ж16). Усечение на сервере есть, но
    // это уже не та серия, которую читал разрез.
    const state = intact
      ? "Исходная серия не тронута, поэтому встречи от границы разреза сейчас видны дважды — в ней и в продолжении; ничего не потеряно."
      : error.recreated
        ? "Ничего не удалено: на сервере сейчас и продолжение, и заново созданная усечённая серия."
        : "Продолжение осталось на сервере; ничего не удалено.";
    const what = error.recreated ? "усечение создало исходную серию заново" : "исходную серию усечь не удалось";
    throw new DeliveryError(
      "split-incomplete",
      `Продолжение серии создано (id ${uid}), но ${what}: ${nested(error.reason)} ${state}`,
      {
        advice: error.recreated
          ? "Проверьте серию: если её удаляли намеренно, удалите заново и её, и продолжение; если нет — разрез дописывать не нужно."
          : "Повторите тот же вызов: он перечитает серию, найдёт продолжение и, если оно совпадает с планом, допишет только усечение.",
        cause: error,
        continuation: { uid, href: continuation.href },
        ...(error.current ? { current: error.current } : {}),
      },
    );
  }
}

// Продолжение не создано или не подтверждено: исходная серия не тронута,
// код — от вложенной ошибки.
function continuationFailed(error: DeliveryError, where: { uid: string; href: string }): DeliveryError {
  const unknown = error.code === "unknown";
  const reason = unknown
    ? `Разрез не завершён: создано ли продолжение серии (id ${where.uid}), неизвестно — ${nested(error.reason)} Исходная серия не тронута.`
    : `Разрез не выполнен: продолжение серии (id ${where.uid}) не создано — ${nested(error.reason)} Исходная серия не тронута.`;
  const advice = unknown ? "Повторите тот же вызов: он сначала проверит, есть ли продолжение." : error.advice;
  return new DeliveryError(error.code, reason, {
    cause: error,
    continuation: where,
    ...(advice ? { advice } : {}),
    ...(error.current ? { current: error.current } : {}),
  });
}

// Продолжение на сервере не совпадает с планом: исходную серию не усекаем.
// `cause` — неудача нашего PUT продолжения: при 412 (exists) он не применён,
// при неизвестном исходе (unknown) — мог примениться, и продолжение потом
// изменили.
function staleContinuation(actual: RawObject, plan: SplitWrite, env: IcalEnv, cause?: DeliveryError): DeliveryError {
  const differences = describeDifferences(plan.continuation.ics, actual.ics, env);
  const { uid } = plan.continuation;
  const written =
    cause?.code === "unknown"
      ? "исходная серия не тронута, а дошла ли наша запись продолжения, неизвестно."
      : "ничего не записано.";
  return new DeliveryError(
    "split-stale-continuation",
    `Продолжение серии (id ${uid}) уже есть на сервере, но не совпадает с тем, что даёт разрез сейчас: ${differences.join("; ")}. ` +
      `Похоже, исходную серию или продолжение меняли после прошлого разреза; ${written}`,
    {
      advice: "Посмотрите продолжение, поправьте или удалите его и повторите разрез.",
      current: actual,
      continuation: { uid, href: actual.href },
      differences,
      ...(cause === undefined ? {} : { cause }),
    },
  );
}

// ─────────────────────────── различия продолжения ───────────────────────────

/** Сколько встреч перечислять в различиях и сколько слотов сравнивать. */
const LISTED = 5;
const COMPARED_SLOTS = 500;

/**
 * Чем объект на сервере отличается от плана — по-русски, для отказа
 * `split-stale-continuation`. Решение уже принято по дайджесту; здесь только
 * объяснение: поля основного компонента и переопределений, встречи серии
 * (первые COMPARED_SLOTS незакрытых слотов). Текст правила и VTIMEZONE не
 * сравниваются: Яндекс их переписывает (Ж5, Ж10).
 */
function describeDifferences(planned: string, actual: string, env: IcalEnv): string[] {
  const want = loadObject(planned, env);
  const have = loadObject(actual, env);
  if (isUnparsable(have)) return [`продолжение на сервере не разбирается (${have.error})`];
  if (isUnparsable(want)) return [`план продолжения не разбирается (${want.error})`];

  const out: string[] = [];
  compareComponents("основная встреча", want.master, have.master, out);
  compareSlots(want, have, env, out);

  const keys = [...new Set([...want.overrides.keys(), ...have.overrides.keys()])].sort(compareSlotKeys);
  for (const key of keys) {
    const a = want.overrides.get(key);
    const b = have.overrides.get(key);
    const label = `встреча ${formatForModel((a ?? b)![0].recurrenceId, env, "instance")}`;
    if (!a) out.push(`${label}: изменена только на сервере`);
    else if (!b) out.push(`${label}: изменена в плане, на сервере — нет`);
    else compareComponents(label, shownOverride(a).component, shownOverride(b).component, out);
  }
  if (out.length === 0) out.push("различаются данные, которые здесь не расписаны (например, протяжённость серии за первыми встречами)");
  return out;
}

// Поля компонента, которые пишет модель: как в semanticDigest (object.ts,
// fieldsOf). Значения — из jCal (property.js: jCal[3] — первое значение,
// getParameter — параметр, строки 242–249); свойства —
// component.js:290 (getFirstProperty), :333 (getAllProperties),
// :235 (getAllSubcomponents).
function compareComponents(label: string, a: ICAL.Component | null, b: ICAL.Component | null, out: string[]): void {
  if (!a || !b) {
    if (a !== b) out.push(`${label}: ${a ? "есть только в плане" : "есть только на сервере"}`);
    return;
  }
  const fields: Array<[string, (c: ICAL.Component) => string]> = [
    ["название", (c) => text(c, "summary")],
    ["место", (c) => text(c, "location")],
    ["описание", (c) => text(c, "description")],
    ["статус", (c) => text(c, "status").toUpperCase()],
    ["начало", (c) => timeText(c.getFirstProperty("dtstart"))],
    ["конец", (c) => (c.hasProperty("dtend") ? timeText(c.getFirstProperty("dtend")) : raw(c.getFirstProperty("duration")))],
    [
      "участники",
      (c) =>
        c
          .getAllProperties("attendee")
          .map((p) => `${raw(p).replace(/^mailto:/i, "").toLowerCase()} ${String(p.getParameter("partstat") ?? "NEEDS-ACTION").toUpperCase()}`)
          .sort()
          .join(", "),
    ],
    [
      "напоминания",
      (c) =>
        c
          .getAllSubcomponents("valarm")
          .map((alarm) => `${text(alarm, "action").toUpperCase()} ${raw(alarm.getFirstProperty("trigger"))}`)
          .sort()
          .join(", "),
    ],
  ];
  for (const [name, read] of fields) {
    const x = read(a);
    const y = read(b);
    if (x !== y) out.push(`${label}, ${name}: в плане «${x || "—"}», на сервере «${y || "—"}»`);
  }
}

// Незакрытые слоты обеих серий: чего нет на сервере и что там лишнее. Если
// перебор одной из серий оборван пределом, сравнение — до меньшего из
// последних пройденных ключей.
function compareSlots(want: CalendarObject, have: CalendarObject, env: IcalEnv, out: string[]): void {
  const a = liveSlots(want);
  const b = liveSlots(have);
  const bounds = [a, b].flatMap((s) => (s.cut && s.last !== undefined ? [s.last] : []));
  const bound = bounds.length ? bounds.reduce((x, y) => (compareSlotKeys(x, y) <= 0 ? x : y)) : undefined;
  const within = (key: SlotKey) => bound === undefined || compareSlotKeys(key, bound) <= 0;
  const missing = [...a.times.keys()].filter((key) => within(key) && !b.times.has(key));
  const extra = [...b.times.keys()].filter((key) => within(key) && !a.times.has(key));
  const list = (keys: SlotKey[], times: Map<SlotKey, ICAL.Time>) =>
    keys.slice(0, LISTED).map((key) => formatForModel(times.get(key)!, env, "instance")).join(", ") + (keys.length > LISTED ? ` и ещё ${keys.length - LISTED}` : "");
  if (missing.length) out.push(`на сервере нет встреч продолжения: ${list(missing, a.times)}`);
  if (extra.length) out.push(`на сервере лишние встречи: ${list(extra, b.times)}`);
  if (a.failed || b.failed) out.push("встречи одной из серий перебрать не удалось");
}

function liveSlots(o: CalendarObject): { times: Map<SlotKey, ICAL.Time>; cut: boolean; last?: SlotKey; failed: boolean } {
  const times = new Map<SlotKey, ICAL.Time>();
  let seen = 0;
  let last: SlotKey | undefined;
  try {
    for (const slot of iterateSlots(o)) {
      if (++seen > SERIES_CAP) return { times, cut: true, last, failed: false };
      last = slot.key;
      if (slot.excluded) continue;
      times.set(slot.key, slot.time);
      if (times.size >= COMPARED_SLOTS) return { times, cut: true, last, failed: false };
    }
  } catch (error) {
    if (!(error instanceof SlotScanError)) throw error;
    return { times, cut: true, last, failed: true };
  }
  return { times, cut: false, last, failed: false };
}

function text(c: ICAL.Component, name: string): string {
  return raw(c.getFirstProperty(name));
}

// Первое значение свойства как записано (jCal[3]); у структурных значений — строкой JSON.
function raw(property: ICAL.Property | null): string {
  if (!property) return "";
  const value: unknown = property.jCal[3];
  if (value === undefined || value === null) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

// Время как записано, с поясом: «2026-10-26T10:00:00 Europe/Moscow».
function timeText(property: ICAL.Property | null): string {
  if (!property) return "";
  const tzid = property.getParameter("tzid");
  const value = raw(property);
  return tzid ? `${value} ${String(tzid)}` : value;
}

// ─────────────────────────────── мелочи ───────────────────────────────

function lazy<T>(compute: () => T): () => T {
  let done = false;
  let value: T;
  return () => {
    if (!done) {
      value = compute();
      done = true;
    }
    return value;
  };
}

// Причина вложенной ошибки внутри фразы: со строчной буквы.
function nested(reason: string): string {
  return reason.charAt(0).toLowerCase() + reason.slice(1);
}

// Коротко, что ответил транспорт: код или «ответа нет». Подсказка CaldavError
// («дошла ли запись, неизвестно») сюда не идёт: исход здесь уже выяснен.
function transportNote(error: Error): string {
  if (error instanceof CaldavError) return error.status > 0 ? `ответ сервера ${error.status}` : "ответа сервера нет";
  return error.message;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
