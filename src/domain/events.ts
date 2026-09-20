import { hrefFor, queryEventByUid, queryEvents, type RawObject } from "../caldav/objects.js";
import { buildEvent, type BuildOptions } from "../ical/build.js";
import { continuationUid, planDelete, planUpdate } from "../ical/edit.js";
import { expandOccurrences } from "../ical/expand.js";
import { verifyPlan } from "../ical/guard.js";
import { AddressError, parseAddress } from "../ical/instances.js";
import { isUnparsable, loadObject, semanticDigest, type CalendarObject, type Unparsable } from "../ical/object.js";
import { eventOfObject } from "../ical/parse.js";
import { EditRefusal, type EventPatch, type Loss, type WritePlan } from "../ical/plan.js";
import type { IcalEnv } from "../ical/values.js";
import { resolveCalendarIn } from "./calendars.js";
import { deliver, ioFor, writeSplit, type DeliveryIO, type KnownState } from "./writes.js";
import type { Calendar, CalendarEvent, Context, EditScope, Attendee, Recurrence, Reminder } from "../types.js";

/**
 * Чтение, создание, правка и удаление событий — то, что видят средства MCP.
 *
 * Правка и удаление здесь ничего не решают сами. Они складывают один и тот
 * же путь из готовых частей:
 *
 *   чтение объекта → планировщик (src/ical/edit.ts: planUpdate, planDelete)
 *   → предохранитель (src/ical/guard.ts: verifyPlan)
 *   → доставка (src/domain/writes.ts: deliver, writeSplit)
 *
 * Второго пути правки нет намеренно: прежний собирал объект заново из
 * разобранной модели и терял всё, чего модель не выражает (переопределения
 * встреч, исключения серии, чужие свойства), а условную запись и разбор
 * ответа сервера делал по-своему. Теперь запись объекта существует ровно в
 * одном месте, а «что записать» решает только планировщик.
 *
 * Договор с предохранителем: при каждой правке ему передаётся тот же патч,
 * который получил планировщик (`verifyPlan(..., { now, patch })`). Без патча
 * часть проверок молчит — так прямо сказано в шапке guard.ts, — и сторожить
 * это некому, кроме вызывающего. Поэтому патч передаётся в одном-единственном
 * месте (`runPlan`), а не в каждой ветке.
 *
 * Отказ планировщика (`EditRefusal`) наружу уходит понятным пользователю
 * текстом: что случилось, что будет потеряно и каким etag это подтвердить.
 * Отказ предохранителя (`GuardError`) и неудача доставки (`DeliveryError`)
 * уже несут свой текст и код и проходят как есть.
 *
 * Пояс процесса не участвует: время читается в поясе календаря
 * (`IcalEnv.floatingZone` из настроек), «сейчас» берётся из `Context.now`.
 */

export interface ReadParams {
  from: string;
  to: string;
  calendarIds?: string[];
  query?: string;
  expandRecurring?: boolean;
}

export function matchesQuery(event: CalendarEvent, query?: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return [event.summary, event.description, event.location]
    .filter((value): value is string => Boolean(value))
    .some((value) => value.toLowerCase().includes(needle));
}

// Путь нового объекта переехал в слой CalDAV (src/caldav/objects.ts): им
// пользуются и правка, и доставка, а взаимный импорт двух модулей домена —
// круг. Здесь он только перевыставлен, чтобы прежние вызывающие не менялись.
export { hrefFor };

// ---------------------------------------------------------------------------
// Общее для чтения и записи
// ---------------------------------------------------------------------------

/**
 * Окружение разбора: пояс календаря из настроек (в нём читаются даты и
 * время без смещения) и полный адрес владельца.
 */
function envFor(context: Context): IcalEnv {
  return { floatingZone: context.config.defaultTimeZone, ownerEmail: context.config.login };
}

/** «Сейчас» для DTSTAMP, LAST-MODIFIED и горизонтов проверок. */
function nowOf(context: Context): Date {
  return context.now ? context.now() : new Date();
}

/**
 * Логин владельца обязан быть полным адресом с доменом (name@yandex.ru).
 *
 * По нему отличаются свои встречи от чужих: участник с этим адресом — сам
 * пользователь (его не перечисляют как приглашённого), организатор с этим
 * адресом — свой (иначе встречу считают чужой и правят осторожнее), и он же
 * получатель напоминания письмом, без которого такое напоминание не собрать.
 * Логин без домена не совпадёт ни с одним настоящим адресом, и все три
 * сверки молча дадут неверный ответ. Молчать об этом нельзя, гадать домен —
 * тем более.
 */
function assertOwnerEmail(context: Context): void {
  const login = context.config.login.trim();
  if (/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(login)) return;
  throw new Error(
    `Логин владельца календаря указан как «${context.config.login}» — это не полный адрес. ` +
      "По адресу владельца определяются свои участники, свой организатор и получатель напоминания письмом; " +
      "без домена все три сверки дают неверный ответ. Укажите в YANDEX_LOGIN полный адрес вида name@yandex.ru.",
  );
}

async function writableCalendar(context: Context, calendarId: string | undefined): Promise<Calendar> {
  const calendar = await context.resolveCalendar(calendarId);
  if (calendar.readOnly) {
    throw new Error(`Календарь «${calendar.displayName}» открыт только для чтения.`);
  }
  return calendar;
}

/** Событие с таким UID в календаре не найдено. */
export class EventNotFoundError extends Error {
  readonly code = "not-found";

  constructor(message: string) {
    super(message);
    this.name = "EventNotFoundError";
  }
}

type QueryFn = (calendar: Calendar, from: Date, to: Date) => Promise<RawObject[]>;

function queryFor(context: Context): QueryFn {
  const injected = (context as unknown as { query?: QueryFn }).query;
  if (injected) return injected;
  return (calendar, from, to) => queryEvents(context.client, calendar.href, from, to);
}

export async function readEvents(context: Context, params: ReadParams): Promise<CalendarEvent[]> {
  const from = new Date(params.from);
  const to = new Date(params.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new Error("Параметры from и to должны быть датами в формате ISO 8601.");
  }
  if (from >= to) throw new Error("Начало окна должно быть раньше конца.");

  const all = await context.calendars();
  const selected = params.calendarIds?.length
    ? params.calendarIds.map((id) => resolveCalendarIn(all, id))
    : all;

  const env = envFor(context);
  const expand = params.expandRecurring !== false;
  const query = queryFor(context);
  const collected: CalendarEvent[] = [];

  // Календари опрашиваются последовательно, в цикле: если их станет много
  // (например десять), время сложится из времени всех REPORT-запросов, а не
  // одного самого медленного. Для типичного личного аккаунта (единицы
  // календарей) это неощутимо; при явном требовании параллельности —
  // см. отчёт задачи, это осознанный компромисс, а не недосмотр.
  for (const calendar of selected) {
    // Ошибка чтения одного календаря не должна тихо срезать часть выдачи:
    // неполный список, отданный как полный, опаснее явного отказа —
    // пользователь не заметит пропавшие встречи. Поэтому распространяем
    // ошибку наружу, но оборачиваем её, чтобы в тексте было имя отказавшего
    // календаря (иначе наружу ушло бы сообщение уровня CalDAV, из которого
    // не видно, какой именно календарь виноват), сохраняя исходную ошибку
    // как cause.
    let objects: RawObject[];
    try {
      objects = await query(calendar, from, to);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Не удалось прочитать календарь «${calendar.displayName}»: ${reason}`,
        { cause: error },
      );
    }
    for (const object of objects) {
      const meta = { calendarId: calendar.id, etag: object.etag, href: object.href };
      const events = expand
        ? expandOccurrences(object.ics, calendar.id, from, to, object.etag, env)
        : [eventOfObject(loadObject(object.ics, env), meta, env)];
      for (const event of events) {
        if (matchesQuery(event, params.query)) collected.push({ ...event, href: object.href });
      }
    }
  }

  return collected.sort(
    (left, right) => new Date(left.start).getTime() - new Date(right.start).getTime(),
  );
}

export async function readEvent(
  context: Context,
  calendarId: string,
  eventId: string,
): Promise<CalendarEvent> {
  const calendar = await context.resolveCalendar(calendarId);

  // Путь к объекту нельзя построить из UID: сервер Яндекса не выводит имя
  // файла из UID (docs/yandex-caldav-capabilities.md) — собака выброшена, а
  // не закодирована. Это верно для любого события, заведённого не нами (веб,
  // телефон), то есть почти для всех событий в реальном аккаунте. Поэтому
  // объект ищется REPORT'ом calendar-query по UID, а href и etag берутся из
  // ответа сервера.
  const env = envFor(context);
  const object = await queryEventByUid(context.client, calendar.href, eventId);
  if (!object) {
    throw new EventNotFoundError(
      `Событие с идентификатором «${eventId}» не найдено в календаре «${calendar.displayName}».`,
    );
  }

  return eventOfObject(loadObject(object.ics, env), { calendarId: calendar.id, etag: object.etag, href: object.href }, env);
}

// ---------------------------------------------------------------------------
// Создание
// ---------------------------------------------------------------------------

// Поля события на границе создания: без id/etag/href (их присваивает
// сервер и hrefFor — вызывающий код их не выбирает) и без timeZone как
// обязательного поля — если его не передали, используется пояс из
// конфигурации (YANDEX_DEFAULT_TZ).
export interface EventInput {
  calendarId?: string;
  summary: string;
  description?: string;
  location?: string;
  start: string;
  end: string;
  timeZone?: string;
  allDay?: boolean;
  recurrence?: Recurrence;
  reminders?: Reminder[];
  attendees?: Attendee[];
}

export interface BulkResult {
  ok: boolean;
  summary: string;
  id?: string;
  error?: string;
}

// Предел размера пачки. CalDAV не умеет пакетные операции — createEvents
// (ниже) кладёт каждое событие отдельным PUT-запросом последовательно, без
// параллелизма и без отката при частичной неудаче. Такая пачка не
// сломается и на сотне событий, но время линейно растёт с числом событий и
// рискует упереться в таймаут вызывающей стороны (MCP-клиента) или в лимиты
// сервера Яндекса на частоту запросов. 50 — заведомо достаточно для
// разумного сценария (перенести неделю или месяц встреч разом) и заведомо
// укладывается в единицы-десятки секунд при обычной задержке CalDAV-запроса.
const MAX_BATCH_SIZE = 50;

/**
 * Окружение сборки нового текста. Полный адрес владельца календаря —
 * получатель напоминания письмом: без него VALARM с ACTION:EMAIL собрать
 * нельзя (RFC 5545 §3.6.6, src/ical/build.ts), и сборка отказывает
 * «получатель неизвестен».
 */
function buildOptionsFor(context: Context): BuildOptions {
  return { ownerEmail: context.config.login };
}

export async function createEvent(context: Context, input: EventInput): Promise<CalendarEvent> {
  // Дешёвые проверки формы входа — до resolveCalendar и уж тем более до сети.
  if (!input.summary.trim()) {
    throw new Error("Заголовок события не может быть пустым.");
  }
  const start = new Date(input.start);
  const end = new Date(input.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error("Параметры start и end должны быть датами в формате ISO 8601.");
  }
  if (start >= end) {
    throw new Error("Конец события должен быть позже начала.");
  }

  assertOwnerEmail(context);
  const calendar = await writableCalendar(context, input.calendarId);

  const event = {
    calendarId: calendar.id,
    summary: input.summary,
    description: input.description,
    location: input.location,
    start: input.start,
    end: input.end,
    timeZone: input.timeZone ?? context.config.defaultTimeZone,
    allDay: input.allDay ?? false,
    recurrence: input.recurrence,
    reminders: input.reminders ?? [],
    attendees: input.attendees ?? [],
  };

  const { ics, uid } = buildEvent(event, buildOptionsFor(context));
  const href = hrefFor(calendar, uid);
  // Создание идёт той же доставкой, что правка и удаление: один PUT без
  // слепых повторов, а потерянный ответ выясняется перечитыванием по UID, а
  // не вторым PUT'ом (который у Яндекса молча перезаписал бы уже созданное).
  const written = await deliver(ioFor(context), calendar, { kind: "create", uid, href, ics }, undefined, envFor(context));

  return { ...event, id: uid, href: written.href, etag: written.etag };
}

// Пачка намеренно не откатывается при частичной неудаче: транзакций в
// CalDAV нет, а отчёт по каждой строке позволяет повторить только
// неудавшиеся события, не трогая уже созданные.
export async function createEvents(
  context: Context,
  inputs: EventInput[],
): Promise<BulkResult[]> {
  if (inputs.length > MAX_BATCH_SIZE) {
    throw new Error(
      `Пачка из ${inputs.length} событий превышает предел в ${MAX_BATCH_SIZE}: разбейте на несколько вызовов.`,
    );
  }

  const results: BulkResult[] = [];
  for (const input of inputs) {
    try {
      const event = await createEvent(context, input);
      results.push({ ok: true, summary: input.summary, id: event.id });
    } catch (error) {
      results.push({
        ok: false,
        summary: input.summary,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Правка и удаление: один путь
// ---------------------------------------------------------------------------

export interface UpdateParams {
  calendarId?: string;
  id: string;
  scope?: EditScope;
  instanceStart?: string;
  patch: EventPatch;
  /** Подтверждение потерь; принимается только вместе с `etag`. */
  confirm?: boolean;
  /** ETag состояния, которое пользователь видел последним. */
  etag?: string;
}

export interface DeleteParams {
  calendarId?: string;
  id: string;
  scope?: EditScope;
  instanceStart?: string;
  confirm?: boolean;
  /**
   * ETag состояния, которое пользователь видел последним. Несовпадение —
   * отказ без единой записи: удаляется то, что показали, а не то, что успел
   * записать другой клиент между показом и вызовом.
   *
   * По смыслу удаления он обязателен, и необязательным оставлен только
   * потому, что средство delete_event его пока не принимает: сделать его
   * обязательным здесь значит сегодня же сломать удаление целиком. Как
   * только схема средства получит поле, его следует затребовать.
   */
  etag?: string;
}

/** Ответ правки. */
export interface UpdateResult {
  /** UID объекта, который несёт встречу после правки (у разреза — продолжения). */
  id: string;
  calendarId: string;
  href: string;
  /** ETag после записи; "" — сервер его не прислал (перечитыванием не добирается). */
  etag: string;
  scope: EditScope;
  /** Адрес правимой встречи, как его передал вызывающий. */
  instanceStart?: string;
  /** false — менять было нечего, на сервер ничего не ушло. */
  changed: boolean;
  /** Встречи, которых правка лишила, — то же, что подтверждалось confirm. */
  removed: Loss[];
  /** Пояснения по-русски о том, что правка сделала не буквально. */
  notices: string[];
  /** Исходная серия после разреза «эта и следующие». */
  series?: { id: string; href: string; etag: string };
  /** Событие, каким оно записано. */
  event?: CalendarEvent;
}

/** Ответ удаления. */
export interface DeleteResult {
  /** Что удалено: адрес встречи, «адрес и далее» или сам идентификатор события. */
  deleted: string;
  id: string;
  calendarId: string;
  scope: EditScope;
  /** Объект удалён с сервера целиком (в нём не осталось ни одной встречи). */
  objectRemoved: boolean;
  /** Встречи, которых удаление лишило сверх названной. */
  removed: Loss[];
  notices: string[];
  href: string;
}

/**
 * Отказ правки или удаления, переведённый для пользователя: к тексту
 * планировщика добавлены перечень потерь и etag, которым их подтверждают.
 * Поля `code`, `needsConfirm`, `losses` и `hint` — те же, что у отказа
 * планировщика: по ним вызывающий различает причины.
 */
export class EditRefused extends EditRefusal {
  /** ETag прочитанного состояния: его передают вместе с confirm. */
  readonly etag: string;

  constructor(refusal: EditRefusal, etag: string) {
    super(refusal.code, textOfRefusal(refusal, etag), {
      needsConfirm: refusal.needsConfirm,
      losses: refusal.losses,
      hint: refusal.hint,
    });
    this.name = "EditRefusal";
    this.etag = etag;
    this.cause = refusal;
  }
}

function textOfRefusal(refusal: EditRefusal, etag: string): string {
  const parts = [refusal.message];
  if (refusal.losses.length > 0) {
    parts.push(`Будет потеряно: ${refusal.losses.map(describeLoss).join("; ")}.`);
  }
  if (refusal.hint) parts.push(refusal.hint);
  if (refusal.needsConfirm && etag) {
    parts.push(`Подтвердить эти потери можно повтором того же вызова с confirm: true и etag ${etag}.`);
  }
  return parts.join(" ");
}

function describeLoss(loss: Loss): string {
  const title = loss.summary ? ` «${loss.summary}»` : "";
  const when = loss.start && loss.start !== loss.instanceStart ? ` (фактически ${loss.start})` : "";
  return `${loss.instanceStart}${title}${when} — ${loss.reason}`;
}

/**
 * Прочитанное состояние объекта: путь, ETag и дайджест для доставки.
 *
 * Дайджест считается лениво (и один раз): у давней частой серии он стоит
 * около секунды, а нужен он только там, где ответа сервера не было и исход
 * выясняется перечитыванием. На обычном пути он не считается вовсе.
 */
function knownState(raw: RawObject, uid: string, env: IcalEnv): KnownState {
  let digest: string | undefined;
  return {
    uid,
    href: raw.href,
    etag: raw.etag,
    get digest(): string {
      return (digest ??= semanticDigest(raw.ics, env));
    },
  };
}

interface Loaded {
  raw: RawObject;
  object: CalendarObject | Unparsable;
  before: KnownState;
}

async function readForEdit(io: DeliveryIO, calendar: Calendar, uid: string, env: IcalEnv): Promise<Loaded> {
  const raw = await io.find(calendar, uid);
  if (!raw) {
    throw new EventNotFoundError(
      `Событие с идентификатором «${uid}» не найдено в календаре «${calendar.displayName}».`,
    );
  }
  return { raw, object: loadObject(raw.ics, env), before: knownState(raw, uid, env) };
}

/**
 * Отказ по устаревшему etag: пользователь назвал состояние, которого на
 * сервере уже нет. Своя ошибка, а не отказ планировщика: о состоянии
 * сервера планировщик не знает.
 */
export class StaleEtagError extends Error {
  readonly code = "stale-etag";
  readonly needsConfirm = false;
  readonly losses: readonly Loss[] = [];
  readonly hint = "Перечитайте событие (get_event или list_events) и повторите вызов с новым etag.";
  /** ETag состояния, которое лежит на сервере сейчас. */
  readonly etag: string;

  constructor(what: string, given: string, current: string) {
    super(
      `${what} с etag ${given}, а событие на сервере уже изменилось (сейчас его etag ${current}): ` +
        "возможно, его правил другой клиент, и на экране не то, что на сервере. Ничего не записано. " +
        "Перечитайте событие (get_event или list_events) и повторите вызов с новым etag.",
    );
    this.name = "EditRefusal";
    this.etag = current;
  }
}

/**
 * Построить план и сверить его с предохранителем. Запись отсюда не уходит:
 * всё, что здесь отказало, не тронуло сервер.
 *
 * `patch` передаётся предохранителю ВСЕГДА, когда он есть у планировщика, —
 * это договор guard.ts: без патча часть проверок молчит. У удаления патча
 * нет вовсе, и он не передаётся.
 */
function runPlan(
  beforeIcs: string,
  plan: () => WritePlan,
  env: IcalEnv,
  now: Date,
  patch: EventPatch | undefined,
  etag: string,
): WritePlan {
  let built: WritePlan;
  try {
    built = plan();
  } catch (error) {
    if (error instanceof EditRefusal) throw new EditRefused(error, etag);
    throw error;
  }
  verifyPlan(beforeIcs, built, env, patch === undefined ? { now } : { now, patch });
  return built;
}

/** Что легло на сервер. */
interface Written {
  href: string;
  etag: string;
  objectRemoved: boolean;
  /** UID объекта, который несёт встречу после записи. */
  uid: string;
  /** Текст этого объекта — из него строится событие ответа. */
  ics?: string;
  /** Исходная серия после разреза. */
  series?: { id: string; href: string; etag: string };
}

async function applyPlan(
  io: DeliveryIO,
  calendar: Calendar,
  plan: WritePlan,
  before: KnownState,
  env: IcalEnv,
): Promise<Written> {
  switch (plan.kind) {
    case "noop":
      return { href: before.href, etag: before.etag, objectRemoved: false, uid: before.uid };
    case "put": {
      const done = await deliver(io, calendar, { kind: "put", ics: plan.ics }, before, env);
      return { href: done.href, etag: done.etag, objectRemoved: false, uid: before.uid, ics: plan.ics };
    }
    case "delete-object": {
      const done = await deliver(io, calendar, { kind: "delete" }, before, env);
      return { href: done.href, etag: "", objectRemoved: true, uid: before.uid };
    }
    case "split": {
      const done = await writeSplit(io, calendar, before, { continuation: plan.continuation, truncated: plan.truncated }, env);
      return {
        href: done.continuation.href,
        etag: done.continuation.etag,
        objectRemoved: false,
        uid: plan.continuation.uid,
        ics: plan.continuation.ics,
        series: { id: before.uid, href: done.truncated.href, etag: done.truncated.etag },
      };
    }
  }
}

/** Событие, каким его записали, — из текста плана, без похода на сервер. */
function writtenEvent(written: Written, calendar: Calendar, env: IcalEnv, fallback: string): CalendarEvent {
  const ics = written.ics ?? fallback;
  return eventOfObject(loadObject(ics, env), { calendarId: calendar.id, etag: written.etag, href: written.href }, env);
}

export async function updateEvent(context: Context, params: UpdateParams): Promise<UpdateResult> {
  assertOwnerEmail(context);
  const calendar = await writableCalendar(context, params.calendarId);
  const env = envFor(context);
  const now = nowOf(context);
  const io = ioFor(context);

  const { raw, object, before } = await readForEdit(io, calendar, params.id, env);
  // У правки без confirm etag необязателен: патч ложится на свежее
  // состояние, и это честно — правка называет поля, а не переписывает весь
  // объект. Устаревший etag вместе с confirm ловит планировщик: подтверждать
  // потери можно только по тому состоянию, в котором их перечислили.
  const scope: EditScope = params.scope ?? "this";
  const request = {
    scope,
    instanceStart: params.instanceStart,
    patch: params.patch,
    confirm: params.confirm,
    etag: params.etag,
    now,
    defaultTimeZone: context.config.defaultTimeZone,
  };

  let plan: WritePlan;
  try {
    plan = runPlan(raw.ics, () => planUpdate(object, { ...request, currentEtag: raw.etag }), env, now, params.patch, raw.etag);
  } catch (error) {
    // Разрез этой серии по этой же границе мог быть выполнен раньше: тогда
    // встреч с границы в исходной серии уже нет, и она честно отвечает «такой
    // встречи нет». Ответ верный, но бесполезный: разрез не пропал, а уехал в
    // отдельное событие. Найдём его и скажем об этом.
    const already = await splitAlreadyDone(io, calendar, object, request, env, now, error);
    if (already) return already;
    throw error;
  }

  const written = await applyPlan(io, calendar, plan, before, env);
  const result: UpdateResult = {
    id: written.uid,
    calendarId: calendar.id,
    href: written.href,
    etag: written.etag,
    scope,
    changed: plan.kind !== "noop",
    removed: [...plan.removed],
    notices: [...plan.notices],
    event: writtenEvent(written, calendar, env, raw.ics),
  };
  if (params.instanceStart !== undefined) result.instanceStart = params.instanceStart;
  if (written.series) result.series = written.series;
  return result;
}

/** Запрос правки, как его получает планировщик, без `currentEtag`. */
type UpdateRequestBody = {
  scope: EditScope;
  instanceStart?: string;
  patch: EventPatch;
  confirm?: boolean;
  etag?: string;
  now: Date;
  defaultTimeZone?: string;
};

/**
 * Повтор уже выполненного разреза «эта и следующие».
 *
 * После разреза встречи с границы и дальше живут отдельным объектом с
 * детерминированным идентификатором: тот же разрез той же серии даёт тот же
 * идентификатор. Поэтому повторный вызов по исходной серии узнаётся точно —
 * чтением по этому идентификатору, а не догадками.
 *
 * Что отвечаем:
 * - продолжение есть, и тот же патч на нём ничего не меняет — разрез уже
 *   выполнен, вызов повторный: успех без единой записи;
 * - продолжение есть, а патч другой — отказ с идентификатором продолжения:
 *   резать исходную серию второй раз нечего, а новую правку надо адресовать
 *   продолжению, иначе она молча пропала бы;
 * - продолжения нет — это не повтор разреза, и отвечает исходная ошибка.
 */
async function splitAlreadyDone(
  io: DeliveryIO,
  calendar: Calendar,
  object: CalendarObject | Unparsable,
  request: UpdateRequestBody,
  env: IcalEnv,
  now: Date,
  cause: unknown,
): Promise<UpdateResult | undefined> {
  if (request.scope !== "this_and_following" || request.instanceStart === undefined) return undefined;
  if (!(cause instanceof AddressError) || cause.code !== "not-found") return undefined;
  if (isUnparsable(object)) return undefined;

  let uid: string;
  try {
    uid = continuationUid(object.uid, parseAddress(object, request.instanceStart));
  } catch {
    return undefined; // адрес не разобрать — отвечает исходная ошибка
  }
  const found = await io.find(calendar, uid);
  if (!found) return undefined;

  const continuation = loadObject(found.ics, env);
  let plan: WritePlan | undefined;
  try {
    plan = runPlan(
      found.ics,
      () => planUpdate(continuation, { ...request, currentEtag: found.etag }),
      env,
      now,
      request.patch,
      found.etag,
    );
  } catch {
    plan = undefined; // патч на продолжении не ложится — тем более это не повтор
  }

  if (!plan || plan.kind !== "noop") {
    throw new EditRefused(
      new EditRefusal(
        "split-already-done",
        `Серия уже разрезана по ${request.instanceStart}: встречи с этой границы и дальше живут отдельным событием ` +
          `(id ${uid}), а в исходной серии их больше нет. Ничего не записано.`,
        {
          hint: `Правьте продолжение по его идентификатору: update_event с id ${uid}. Если менять нужно встречи ДО границы, передайте адрес одной из них.`,
        },
      ),
      found.etag,
    );
  }

  return {
    id: uid,
    calendarId: calendar.id,
    href: found.href,
    etag: found.etag,
    scope: request.scope,
    instanceStart: request.instanceStart,
    changed: false,
    removed: [],
    notices: [`Разрез по ${request.instanceStart} уже был выполнен раньше: встречи с этой границы лежат в событии ${uid} и уже такие, как просили. Менять нечего.`],
    event: eventOfObject(continuation, { calendarId: calendar.id, etag: found.etag, href: found.href }, env),
  };
}

export async function deleteEvent(context: Context, params: DeleteParams): Promise<DeleteResult> {
  assertOwnerEmail(context);
  const calendar = await writableCalendar(context, params.calendarId);
  const env = envFor(context);
  const now = nowOf(context);
  const io = ioFor(context);

  const { raw, object, before } = await readForEdit(io, calendar, params.id, env);
  // Удаление необратимо, поэтому назвать состояние обязательно: удаляется то,
  // что пользователю показали. Чужая правка, попавшая между показом и
  // вызовом, — отказ, а не молчаливое стирание.
  if (params.etag !== undefined && params.etag !== raw.etag) {
    throw new StaleEtagError("Удаление запрошено", params.etag, raw.etag);
  }

  const scope: EditScope = params.scope ?? "this";
  const plan = runPlan(
    raw.ics,
    () =>
      planDelete(object, {
        scope,
        instanceStart: params.instanceStart,
        confirm: params.confirm,
        etag: params.etag,
        currentEtag: raw.etag,
        now,
      }),
    env,
    now,
    undefined,
    raw.etag,
  );

  const written = await applyPlan(io, calendar, plan, before, env);
  return {
    deleted: deletedAddress(scope, params.instanceStart, params.id, written.objectRemoved),
    id: params.id,
    calendarId: calendar.id,
    scope,
    objectRemoved: written.objectRemoved,
    removed: [...plan.removed],
    notices: [...plan.notices],
    href: written.href,
  };
}

// Что именно удалено, по-русски: у всей серии и у объекта, от которого не
// осталось встреч, — само событие; у хвоста — «адрес и далее»; у одной
// встречи — её адрес.
function deletedAddress(scope: EditScope, instanceStart: string | undefined, id: string, objectRemoved: boolean): string {
  if (scope === "all_series" || instanceStart === undefined) return id;
  if (objectRemoved) return id;
  return scope === "this_and_following" ? `${instanceStart} и далее` : instanceStart;
}

// UID продолжения разреза считает планировщик; здесь он перевыставлен для
// вызывающих, которым нужно найти продолжение по исходной серии и границе.
export { continuationUid };
