# Итоговый план: правка и удаление повторяющихся встреч (v2)

**Обозначения.** A — `wave-b/проект-сырое-дерево.recovered.md`, B — `wave-b/проект-семантика-из-rfc-и-клиентов.recovered.md`. Коды из `wave-a-results.json`: R13, R14, R8 — review13/14/8 (F — findings, N — new_breakage, O — out_of_scope, по порядку); AE, AD — adversaryEdit/Delete; T16 — task16.concerns; NEW — находки A; J-A, J-B — изъяны из вердиктов; П — пробелы проверки полноты v1. C01–C38 — цепочки A §6.2. RID — RECURRENCE-ID, t&f — this_and_following, S — слот, B — граница.

**Основа.** Семантика, confirm, предохранитель и схемы — из A; реализация на дереве ical.js (7 модулей вместо 13) — из B; свой сериализатор не нужен (`foldline` считает октеты UTF-8, `helpers.js:235`).

## 1. Главный принцип

Каждая запись начинается с объекта, который сервер отдал в этом же вызове (путь и ETag — из `queryEventByUid`). Объект разбирается в дерево ical.js, правка меняет только нужные узлы; `CalendarEvent` — лишь язык патча и ответа, из него ничего не пересобирается. Основной компонент — VEVENT без RID, где бы он ни стоял; серия — RRULE любой частоты или RDATE. Экземпляр адресуется только слотом (RID): момент, а у встреч на весь день — дата. COUNT считается по позициям правила; значения пишутся в форме DTSTART; пояс процесса не участвует. Пустота и конец серии — полным проходом правила, не горизонтом. Потеря сверх названной цели требует confirm. Независимый предохранитель сверяет дерево до и после. PUT и DELETE вслепую не повторяются, исход выясняется перечитыванием.

## 2. Модули

Границы слоёв прежние: `src/ical` без сети; `src/caldav` не импортирует `src/ical`; `src/mcp/tools` зависит только от `src/domain` и `src/types`.

```ts
// src/ical/values.ts — единственный путь к моменту
type TimeForm = "date"|"utc"|"zoned"|"floating"; type SlotKey = `D:${string}`|`T:${number}`|`F:${string}`;
interface IcalEnv { floatingZone: string; ownerEmail?: string }  // из config
formOf(p); slotKeyOf(t, seriesForm, env): SlotKey; instantOf(t, env): number; wallDateOf(t, env): string
parseModelTime(iso, zone): instant|wall|date  // регулярка, без Date
timeInForm(t, form, tzid, env); untilBefore(b, form): string   // UNTIL — jCal-строка
ruleDict(p); setRuleDict(p, d)  // живой jCal-словарь RRULE
listKeys(c, "exdate"|"rdate", o); addListValue(c, name, t); removeListValues(c, name, drop, o)
formatForModel(t, env, as: "time"|"instance")
// src/ical/object.ts
type OverrideRole = "slot"|"stale-shift"|"echo"|"detached"|"hidden";
interface CalendarObject { root; uid; master: ICAL.Component|null; form; tzid?; kind: "single"|"series"|"detached";
  overrides: ReadonlyMap<SlotKey, OverrideRef[]>; roles: Map<ICAL.Component, {role: OverrideRole; slot?: SlotKey}>;
  anomalies: Anomaly[]; env }
interface Unparsable { kind: "unparsable"; uid?; summary?; dtstartRaw?; error }
loadObject(ics, env): CalendarObject|Unparsable  // TZID вне дерева — из IANA до getFirstValue
serializeObject(o); ensureTimezones(root, tzids)  // только добавляет
semanticDigest(ics, env)  // без DTSTAMP, LAST-MODIFIED, SEQUENCE, X-*, VTIMEZONE; время — `ключ@TZID|форма`
blockingAnomalies(o, op, scope, target?)
// src/ical/slots.ts
interface Slot { key; time; origin: "dtstart"|"rrule"|"rdate"; position?; periodEnd?; excluded }
iterateSlots(o, bound?); findSlot(o, k); firstSlot(o); isDtstartSynced(o)
seriesExtent(o, cap = 200_000): {kind:"infinite"}|{kind:"finite"; count; last?: Slot}|{kind:"too-long"}
isEmpty(o); lastSlotUpTo(o, until)  // без горизонта
positionsBefore(o, k)  // позиции правила, EXDATE не влияет
sameTail(a, from, b, map, limit)
// src/ical/instances.ts
interface Instance { key; components; start; end; kind: "slot"|"override"|"detached"|"legacy"|"range"; moved; cancelled }
instancesBetween(o, fromMs, toMs); visibleMap(o, horizon); hiddenOverrides(o)
resolveTarget(o, instanceStart, op): {target: single|slot|detached|hidden; ambiguousWith?}
class AddressError { code: "invalid"|"not-found"|"excluded"|"actual-start"|"ambiguous"|"mismatch"; hint? }
toCalendarEvent(o, what: Instance|"object", meta)
// src/ical/plan.ts (типы) + src/ical/patch.ts
interface RecurrencePatch { frequency?; interval?; byWeekday?; until?: string|null; count?: number|null; replace? }
interface AttendeePatch { email; status? }  interface Loss { instanceStart; start; summary; reason }
interface Expectation { op; scope; target?; fields; keyMap?; removed; ruleChanged; datesFixed; tail?: {count; lastDate};
  touched: {properties: Set<ICAL.Property>; components: Set<ICAL.Component>} }
type WritePlan = noop | put{ics} | delete-object | split{continuation{uid,ics}, truncated{ics}, boundary} // + expect, removed, notices
applyFieldPatch(c, p, ctx); overrideFromMaster(o, slot); inheritFields(ovr, oldM, newM, fields)
patchRule(p, rp, form): {lostParts}; setRuleEnd(p, {count}|{until}); touchMetadata(c, now, significant, env)
// src/ical/edit.ts; src/ical/guard.ts
planUpdate(o, {scope, instanceStart?, patch, confirm, now, defaultTimeZone}); planDelete(o, {scope?, instanceStart?, confirm, now})
continuationUid(uid, b) = "ycm-" + sha256(uid+"\n"+b)[0..32]
class EditRefusal { code; needsConfirm; losses; hint? }; verifyPlan(beforeIcs, plan, env)  // GuardError
// src/domain/writes.ts
interface ObjectIO { find; put(href, ics, {ifMatch}|{ifNoneMatch}); remove(href, ifMatch) }
  // → applied(etag)|precondition-failed|not-found|unknown|rejected
ioFor(ctx); deliver(io, cal, write, before, env); writeSplit(io, cal, current, plan, env)
// src/domain/edit.ts (events.ts реэкспортирует)
updateEvent(ctx, {calendarId?, id, scope?, instanceStart?, patch, etag?, confirm?})
deleteEvent(ctx, {calendarId?, id, scope?, instanceStart?, etag, confirm?}) → {deleted, scope, objectRemoved, removed, notices?}
```

Прочие файлы: `types.ts` (`CalendarEvent`: `recurring`, `recurrenceRule`, `status`, `moved`, `detached`, `exceptions`, `anomalies`; `Recurrence.unmodeled`; `Context.io?`, `now?`); `expand.ts` — обёртка над `instancesBetween`; `timezones.ts` — `vtimezoneFor`; `request.ts` повторяет только GET, HEAD, OPTIONS, PROPFIND, REPORT, `CaldavError.applied: "no"|"unknown"`; из `events.ts` уходят `replaceMaster`, `veventOf`, `assertInstanceExists`, `occurrencesBefore`, `removeExistingOverride`, `merge`, `icalTimeOf`.

## 3. Семантика операций

- **О1.** Основной — VEVENT без RID; больше одного — аномалия.
- **О2.** Слоты = DTSTART ∪ позиции RRULE ∪ RDATE − EXDATE, множеством ключей. Позиции — из `Recur.iterator(истинный DTSTART)`, выдачи клонируются. DTSTART не на позиции итератор не выдаёт и не считает в `occurrence_number` (`recur_iterator.js:386-467`) — он добавляется отдельно. `RecurExpansion` не используется: ошибается на дублях EXDATE.
- **О3.** Ключ: `D:дата` — весь день (у унаследованного DATE-TIME — буквальная дата); `T:момент` — TZID и UTC (и RID в чужом TZID); `F:стенное` — плавающее.
- **О4.** RID, EXDATE, RDATE и UNTIL — в форме DTSTART: DATE → `VALUE=DATE`; TZID → тот же TZID, UNTIL в UTC; UTC → `Z`; плавающее → плавающее.
- **О5.** Правка на месте: меняются только свойства патча и метаданные; VTIMEZONE только добавляются.
- **О6.** Клон основного — всё, кроме RRULE, RDATE, EXDATE, EXRULE; DTSTART = RID = S. Конец — в форме основного: при DURATION — только DURATION, при DTEND — DTEND = S + длительность (у PERIOD — его конец). DTEND вместе с DURATION не пишется никогда (RFC 5545 §3.6.1).
- **О7.** Поле переопределения меняется, только если совпадало со старым значением основного. Неперенесённое (DTSTART = RID) следует за новым временем, перенесённое остаётся.
- **О8.** `start` без `end` сохраняет длительность; конец ≤ начала — `invalid-time`; ISO без смещения — стенное время в поясе события; `timeZone` без `start` сохраняет моменты; `end` пишется в имеющейся форме (DTEND или DURATION).
- **О9.** Участники — по адресу; без `status` PARTSTAT не трогается, новые — NEEDS-ACTION. Трогаются только VALARM DISPLAY и EMAIL с относительным TRIGGER. `""` снимает description или location; пустой summary — отказ.
- **О10.** DTSTAMP (UTC) и LAST-MODIFIED (если есть) обновляются у изменённых компонентов. SEQUENCE +1, только если он уже есть, менялись DTSTART, DTEND, DURATION, RRULE, RDATE или EXDATE и ORGANIZER нет или равен `config.login`. Отсутствующий SEQUENCE не добавляется.
- **О11.** Потеря сверх названной цели → `EditRefusal{needsConfirm, losses}` с etag прочитанного состояния; `confirm` принимается только с этим etag.
- **О12.** `verifyPlan`:
  - (а) ≤ 1 основного; один UID; нет новых дублей RID и EXDATE; VTIMEZONE на каждый TZID; формы по О4; UNTIL ≥ DTSTART; DTEND > DTSTART; нет DTEND вместе с DURATION; аномалий не больше, чем было;
  - (б) всё вне `touched` прежнее (deep-equal по jCal);
  - (в) видимые после записи = прежние через `keyMap` минус `removed`; при `datesFixed` даты слотов прежние. Горизонт: от первого слота до max(сейчас, цель, последний явный ключ) + 400 дней и ещё ≥ 5 слотов, ≤ 100 000 шагов (при нехватке — от «цель − 400 дней»);
  - (г) `delete-object` при scope ≠ all_series — только если `isEmpty` после плана (без горизонта);
  - (д) план меняет правило, время или конец конечной серии → полный `seriesExtent`: число позиций и дата последнего слота = `expect.tail`; `too-long` — отказ `series-too-long`.
- **О13.** Пустой план ничего не пишет.
- **О14.** Запись блокируют: `unparsable` (кроме delete all_series без дерева), `bad-rrule`, `no-positions`, `multiple-masters`, `mixed-uids`, `unknown-tzid` в затронутых значениях, `range-override`; `duplicate-override` в целевом слоте (кроме delete this); `legacy-override` для t&f, all_series и для update такой встречи без confirm (Р5); для разреза — EXRULE, несколько RRULE, `unsynced-dtstart` при COUNT, граница из RDATE при наличии RRULE. delete all_series не блокируется ничем.

| Операция | Одиночное | Основной компонент | Переопределения | EXDATE, RDATE | UNTIL, COUNT | Вне модели |
|---|---|---|---|---|---|---|
| update this | на месте; `instanceStart` ≠ DTSTART — отказ | не меняется | S — на месте, иначе клон (О6) + патч; RID неизменен; detached — на месте; скрытое — отказ | не меняются | не меняются | целы, в клон копируются |
| update t&f | как this | исходный: только конец правила; продолжение (`continuationUid`) — клон без SEQUENCE и CREATED, DTSTART = дата B + время патча (дата — только с recurrence) | RID ≥ B → в продолжение, RID сдвинут по позиции, поля по О7, B получает патч; RID < B остаются, в notice | ≥ B снимаются; в продолжение — со стенной дельтой | исходный: COUNT = `positionsBefore(B)` или UNTIL = `untilBefore(B)`; продолжение: COUNT минус позиции; обязателен `sameTail` | копируются |
| t&f, до B видимых нет | — | = all_series, тот же UID | | | | |
| update all_series | как this | на месте; время по Р1; RRULE только из recurrence (Р4) | по О7; сдвиг — по позиции; смена правила — по ключу, потери только с confirm | сдвиг — по позиции; при смене правила EXDATE без слота снимаются | COUNT не меняется; UNTIL — по Р1; из recurrence — как задано | целы |
| delete this | DELETE; `instanceStart` ≠ DTSTART — отказ | EXDATE на S; S из RDATE — снять значение RDATE | снимаются все компоненты встречи S (Р5); detached или скрытое — как компонент | +1 EXDATE, без дублей | не меняются | не меняются |
| delete this → `isEmpty` | | DELETE объекта, скрытые — в `removed` | | | | |
| delete t&f | DELETE | усечение, как в update t&f | RID ≥ B снимаются (фактически раньше B — только с confirm); RID < B остаются | ≥ B снимаются | как в update t&f | не меняются |
| delete t&f, до B видимых нет | | DELETE объекта | | | | |
| delete all_series | DELETE | DELETE; переданный `instanceStart` обязан разрешиться | | | | |

## 4. Решения по спорным вопросам

- **Р1. all_series меняет время или правило при перенесённых встречах.**
  - *Без recurrence:* дата DTSTART не меняется — из start и end берутся только время суток, длительность и пояс, другая дата даёт notice. Сопоставление позиционное (n → n, `datesFixed`): неперенесённые идут за серией, перенесённые остаются. RDATE сдвигается на стенную дельту, при смене одного пояса сохраняет моменты. UNTIL пересчитывается: U' = новое время на дате последнего старого слота `lastSlotUpTo(U)`, в форме О4 (проход ≤ 200 000 шагов, иначе `until-too-far`). COUNT не меняется. DTSTART не на первой позиции — `unsynced-rule`. Смена allDay при переопределениях — отказ.
  - *С recurrence:* по ключу; переопределения без пары снимаются только с confirm, EXDATE без пары — с notice.
  - *Почему:* start с чужого экземпляра не сдвигает серию (J-A1); позиции однозначны и для HOURLY (J-B7); пересчёт UNTIL не теряет и не добавляет последнюю встречу даже за горизонтом (П, AE11).
- **Р2. «Эта и следующие» с первой встречи.** Нет видимых экземпляров до B (включая перенесённые) → update = all_series с тем же UID, delete = DELETE объекта. *Почему:* по RFC DTSTART всегда экземпляр, UNTIL < DTSTART оставляет зомби (AE15, AD10).
- **Р3. Серия без встреч.** `isEmpty`: нет видимых detached и legacy-встреч и пусто множество слотов. Горизонта нет: бесконечное RRULE пустым не бывает (EXDATE конечны), конечная серия проходится целиком (> 200 000 шагов — «не пуст»). delete this, опустошающий объект, — это DELETE объекта, скрытые — в `removed` без confirm (следы прошлых удалений). Чужой зомби — `empty-series` в get_event, удаляется через all_series. *Почему:* S4, AD10; горизонт удалял серии с шагом > 400 дней (П: YEARLY;INTERVAL=2, 29.02).
- **Р4. Невыразимый повтор.**
  - Слоты — по сырому правилу; RRULE остаётся jCal-словарём (`_stringToData` хранит неизвестные части, `toJSON` их теряет).
  - `patch.recurrence` меняет только переданные FREQ, INTERVAL, BYDAY, COUNT, UNTIL; `null` снимает часть; COUNT и UNTIL взаимоисключающие; умолчаний нет. `replace:true` — только с confirm и перечнем теряемых частей.
  - Чтение: `recurrence` и `unmodeled`, для HOURLY, RDATE и нескольких RRULE ещё `recurrenceRule` дословно.
  - Плохой RRULE (FREQ вне списка, BYDAY=0MO, BYxxx вне диапазона, нечисловые COUNT/INTERVAL) роняет уже `ICAL.parse` (`parse.js:288,310` → `design.js:469` → `recur.js:498-569`), дерева нет. Такой объект — `Unparsable`: list_events и get_event выдают заглушку (UID, SUMMARY, DTSTART из построчного разбора, `anomalies:["unparsable: …"]`; нечитаемый DTSTART — отказ list_events с UID); find_free_slots отказывает с UID; update — отказ; delete all_series — без дерева: find → etag → DELETE.
  - Ошибки итерации (`recur_iterator.js` init/next) и правило без позиций за 100 000 шагов → `bad-rrule` или `no-positions`: читается один DTSTART, запись — только delete all_series.
  - *Почему:* AE5, AE6, NEW-5; поправка утверждения v1 об ical.js.
- **Р5. Переопределение без слота.** `loadObject` даёт роль по порядку:
  1. RID = слот → `slot`.
  2. RID под EXDATE или вне [первый слот, конец серии] → `hidden`: нет в list_events и free_slots, есть в `get_event.exceptions`, удаляется delete this по своему RID (R8-N1, виды B, C).
  3. `stale-shift` (след R13-N6/AE11: RID 10:00 после сдвига серии на 09:00): RID мимо позиций, в его стенной дате (пояс DTSTART) ровно один слот, у слота нет своего переопределения и дату не заявляет другое такое же → показывается как переопределение этого слота.
  4. `echo` (след AE12/R8-O1: второе переопределение с RID = новому времени перенесённой): RID мимо позиций и по моменту равен DTSTART другого переопределения O1 → одна встреча с временем и полями эха (последняя правка) по адресу слота O1; O1 скрыт; цепочка эха — по последнему.
  5. Иначе `detached`: показывается, занимает время, правится и удаляется по RID (J1).

  Случаи 3–4 — аномалия `legacy-override`. delete this по адресу встречи снимает её целиком (EXDATE на слот и все компоненты), по RID лишнего компонента — только его. update без confirm — отказ со списком компонентов; с confirm — ремонт (RID оставшегося компонента — на слот; у echo O1 — в `losses`), затем патч. t&f и all_series при `legacy-override` — отказ с адресами для ремонта. Дубли одного RID: показывается один (больший SEQUENCE, поздний DTSTAMP, последний в файле), delete this снимает все. *Почему:* ни вид R8-N1, ни хвосты старого кода не двоятся, а настоящие detached не выдаются за свободное время.
- **Р6. Объект из одних переопределений.** Каждое — detached, `instanceStart` = RID. update this — на месте; t&f и all_series — отказ. delete this снимает компонент (последний — с объектом), delete t&f — RID ≥ B, delete all_series — объект с notice «серия организатора не затронута». *Почему:* R8-N3.
- **Р7. Отменённые.** STATUS:CANCELLED — `status:"cancelled"`, время не занимает; update — отказ; delete this ставит EXDATE и снимает компонент. RANGE=THISANDFUTURE читается по RFC со сдвигом; запись — только delete all_series.
- **Р8. Повторы транспортом.** PUT и DELETE — ровно раз; сеть, таймаут, 5xx → `unknown`, 4xx → `no`. При `unknown` (и при 404/412 на DELETE) объект перечитывается по UID, проверки строго по порядку: (1) объекта нет → DELETE «уже удалено», правка — конфликт, создание — одна повторная попытка с If-None-Match; (2) ETag и digest прежние → запись не дошла, одна повторная попытка; (3) digest = ожидаемому и ≠ прежнему → «применено» (`confirmedByReread`); (4) иначе «результат неизвестен» с текущим состоянием. Digest ключует время вместе с TZID и формой, так что `{timeZone}` его меняет; если ожидаемый digest всё же равен прежнему, решает только ETag (П: потерянная смена пояса).
- **Р9. Разрез.** PUT продолжения с If-None-Match, затем усечение с If-Match по исходному ETag. Существующее продолжение (412 или сверка) перечитывается: digest = плану — усечение, иначе `split-stale-continuation` с различиями и без записей (J-A2). Компенсирующего DELETE нет (J-B1, J-B8). Сорвалось усечение — «продолжение X создано, хвост виден дважды; повторите тот же вызов». Повтор t&f, когда B за концом исходной серии и `continuationUid` есть: update — «уже выполнено», только если тот же патч на экземпляре B продолжения даёт пустой план, иначе `split-already-done` с id продолжения (П); delete — «уже удалено». До З00 разрез при чужих ATTENDEE требует confirm с предупреждением о письмах.
- **Р10. Адресация.** `instanceStart` — слот.
  - *Выдача:* ISO со смещением пояса DTSTART на слоте (UTC — `+00:00`, плавающее — пояс календаря); весь день — `YYYY-MM-DD`, start/end — полночь пояса календаря; перенесённая — `moved:true`.
  - *Приём:* ISO со смещением — по моменту, без смещения — стенное время серии; весь день — `YYYY-MM-DD` или `…T00:00:00` с любым смещением (буквальная дата), иное — `invalid` (J-B6).
  - *Отказы:* фактическое время перенесённой, не совпавшее со слотом, — `actual-start` с её `instanceStart`. Совпадение со слотом или detached и одновременно с фактическим временем другой, перенесённой встречи — `ambiguous` и для delete, и для update; в отказе оба адреса: перенесённая — её `instanceStart`, слот — повтор с confirm и etag (П: AD3 для правки). Слот под EXDATE — `excluded`.
- **Р11. etag.** В delete_event обязателен (AD9). В update_event необязателен: патч ложится на свежее состояние и не трогает чужие правки других полей. С confirm обязателен везде; несовпадение — отказ.
- **Р12. Испорченные прежним кодом объекты** читаются с `anomalies`; `legacy-override` чинится по Р5 через confirm; два основных и `mixed-uids` не чинятся — только delete all_series и delete this для дублей.

## 5. Таблица покрытия

| Поломка | Чем закрыто | Цепочки |
|---|---|---|
| R13-F1, R13-N1, AE4, AD1, AD4 | О1, О5, О12г | C01–C04 |
| R13-N2, AE8 / R13-O2 / R8-N3 | таблица, this / О1 / Р6 | C05 / C04 / C31 |
| R13-N3, AE1, AD7 | О5, О12б | C12, C15 |
| R13-N4, AE12, AD3, J-B3 | Р10 | C06–C08, C61 |
| R8-O1, AE12 (хвост на сервере) | Р5.4 | C55 |
| R13-N5, R13-O1, R8-O2, AE10, AD6 | таблица, t&f | C10, C11 |
| R13-N6, AE11 | Р1 (время, UNTIL), Р5.3 (хвосты) | C23–C25, C56, C58 |
| R13-N7, AE19 | О5, О12а | C23 |
| R13-N8, AE7, AE18, AD12, NEW-7 | Р8, Р9 | C26, C28, C59, C60 |
| R13-O3, AD10/AD11 на Яндексе, окно R8, T16-1, T16-2 | З00 | — |
| R13-O4, R14-O1..O3 | §6 | все |
| R13-F2, F3, R14-F1, F2, R8-F1, F3, F5..F7 (уже закрыты) | сохраняются: Р5, Р9, З09, `test:tz` | C05, C07, C09, C29 |
| R8-F2, R8-N5 / R8-F4 | О3, Р10 / З09 | C33 / C29 |
| R8-F8, R8-N4 | Р7 | C30, C32 |
| R8-N1 (все три вида) | Р5 | C09, C34, C55, C56 |
| R8-N2, R8-O3, AE3 | `positionsBefore`, О2 | C14 |
| AE2, AD8 | таблица, t&f | C13 |
| AE5, AD2 | Р4, таблица | C17, C18, C63 |
| AE6, NEW-5, J-B4 | Р4, О9, З14 | C16, C38, C43, C44 |
| AE9, AE14, AD11, NEW-6 | О3, О4, Р10 | C19, C35 |
| AE13, AD5 | таблица, Р10 | C07, C09 |
| AE15, AD10 | Р2, Р3 | C20, C21, C57 |
| AE16 / AE17 | О6, О8 / О7 | C22, C62 / C01 |
| AE20, NEW-1 | О2 | C17, C35 |
| AD9 / NEW-2 / NEW-3 | Р11 / О8 / О9 | C27, C52 / C36 / C37 |
| J-A1 / J-A2 / J-A3 | Р1 / Р9 / Р3, Р5, О9 | C39 / C40, C41 / C42, C45 |
| J-B1, J-B8 / J-B2 / J-B5 | Р9 / таблица, confirm / t&f | C28 / C50 / C49 |
| J-B6, J-B7 | Р10, Р1 | C47, C48 |
| J2: горизонт 5000 / T16-4 (byWeekday) | О12 / З14 | бюджет З11 / — |
| T16: письма, SEQUENCE | О10, Р9, З00 | C51, C54 |
| П: пустота и горизонт, UNTIL за горизонтом, digest, повтор разреза, DURATION, Unparsable | Р3, О12г-д, Р1, Р8, Р9, О6, Р4 | C57–C63 |

Не поломки: R13-O5, R8-O4, T16-3, T16-7. Вне задачи: T16-5 (free_slots в UTC, весь день), T16-6 (пояс в list_calendars, `main`, бит dist), ремонт двух основных (Р12).

## 6. Тесты

**Стенд** `tests/support/fakeCaldav.ts` — из стендов прошлых раундов (путь в R13-O4), через настоящий `createClient(config, fake.fetch)`. ETag — растущее голое число; REPORT — надмножество, text-match по UID — подстрока без регистра; 412 на условиях, 404 на DELETE отсутствующего; строгий режим — 400 при нарушении О12а. Крючки: `externalEdit`, `beforeRequest`, `loseResponse` (применить, затем TypeError/503/504), `dropRequest` (не применять, 504), `rejectBeforeApply`, `reorderComponents`, `normalizeOnStore`, `seedRaw` (любой текст). При отказе журнал пуст; самопроверка с отрицательным контролем. После каждого шага — точный список `readEvents`, `assertInvariants`, `assertPropsPreserved`.

**Цепочки.** C01–C38 из A §6.2 с поправками: C08 ждёт `ambiguous`, в C19 даты по Р10, в C25 — confirm с etag. Новые:

| № | Сценарий | Итог |
|---|---|---|
| C39 | DAILY COUNT=10 с 19.10 → delete this 21.10 → rename 23.10 → all_series `{start:"2026-10-22T11:00+03:00"}` | 9 встреч, прежние даты, 11:00 |
| C40 | t&f 26.10, 507 на усечении → rename/delete 04.11 в исходной → повтор | `split-stale-continuation` |
| C41 | t&f 26.10 → all_series `until` позже → t&f 26.10 | отказ |
| C42 | delete this всех слотов при detached / hidden | объект жив / DELETE, скрытые в `removed` |
| C43, C44, C45 | INTERVAL=2 → `{count}`; attendees без status; reminders при AUDIO | INTERVAL, PARTSTAT, чужой VALARM целы |
| C46, C47 | delete all_series с неразрешимым `instanceStart`; весь день `…T21:00:00Z` | отказ |
| C48 | HOURLY: delete this → all_series +1 ч | EXDATE переехал |
| C49 | delete 04.11 → t&f 26.10 со сменой времени | 04.11 не воскрес |
| C50, C51 | перенос 04.11 на 27.10 → delete t&f 28.10; разрез при ATTENDEE | `needsConfirm` |
| C52, C53 | устаревший etag; confirm с устаревшим etag | отказ |
| C54 | SEQUENCE нет или ORGANIZER чужой | SEQUENCE не тронут |
| C55 | затравка AE12: O1 (RID 21.10 10:00 → 15:00) + эхо (RID 15:00) | одна встреча; update без confirm — отказ, с confirm — один компонент с RID 10:00 |
| C56 | затравка R13-N6: серия 09:00, RID 21.10 10:00 → 11:30 | одна встреча 21.10 в 11:30; delete this — дата пуста |
| C57 | YEARLY;INTERVAL=2 с 19.10.2026 и YEARLY 29.02 → delete this ближайшей | объект жив |
| C58 | WEEKLY UNTIL=20281030T070000Z → all_series 11:00, затем 09:00 | последняя 30.10.2028 есть, лишних нет |
| C59 | `{timeZone}` + `dropRequest` | одна повторная попытка, пояс сменён |
| C60 | t&f 26.10 `{summary}` → тот же t&f `{location}` | `split-already-done` |
| C61 | перенос 26.10 на 28.10 10:00 → update this `28.10T10:00` | `ambiguous`, записей нет |
| C62 | основной с DURATION → update this, t&f | нет DTEND+DURATION |
| C63 | `seedRaw` FREQ=FOO, BYDAY=0MO | list_events жив; update — отказ; delete all_series удаляет |

**Прочее.** Оракул — З16. `npm run test:tz` — при TZ=UTC, Europe/Moscow, America/New_York, страж сверяет `resolvedOptions().timeZone` с `EXPECTED_TZ`; затравки Moscow, Berlin (переход времени), New_York, даты, плавающее. Цепочки против dd99d80 — `it.fails`; зелёная там цепочка — охранная, с обоснованием. Мутанты: M1–M12 из A §6.3; M13 дата в all_series; M14 412 без digest; M15 компенсирующий DELETE; M16 status и M17 interval по умолчанию; M18 delete t&f без confirm; M19 и M26 `ambiguous` без confirm в delete и update; M20 10 символов даты; M21 detached скрыты; M22 `isEmpty` по горизонту; M23 UNTIL не пересчитан; M24 digest без TZID или правило 3 раньше 2; M25 «уже выполнено» без сверки патча; M27 DTEND при DURATION; M28 эхо отдельно.

## 7. Задачи для исполнителей

**Правила для всех.** `.env` не читать; живые запросы — только в З00. API ical.js сверять по `node_modules/ical.js/lib/ical/<файл>` со ссылкой в комментарии. В `src/ical` и `src/domain` запрещены `toJSDate`, `getHours`, `setHours`, `new Date(y,m,d)`, `new Date(строка без смещения)`. Сообщения — по-русски. Готово: `npx vitest run` зелёный, в отчёте — упавшие на старом коде тесты с сообщениями.

**Волны** (задачи одной волны не пишут в общие файлы): 1 — З00, З01, З02, З03, З04; 2 — З05a, З05b, З05c, З06, З15; 3 — З07, З08, З12; 4 — З09, З10, З11; 5 — З13, З14; 6 — З16, З17; 7 — З18.

**З00. Живая сверка.** Контроллер, только с согласия пользователя, на отдельном календаре из веба. Файл `docs/yandex-caldav-capabilities.md`. Снять: порядок компонентов; приём `RECURRENCE-ID;VALUE=DATE`, `EXDATE;VALUE=DATE`, объекта без основного, UID `ycm-…`; X-свойства в новом UID; нормализацию RRULE, TZID, PARTSTAT; ETag при записи того же текста; «эту и следующие», отмену, сирот и эхо в вебе; письма при ATTENDEE и SEQUENCE; выдачу calendar-query для встречи, перенесённой в окно. Итог — таблица «факт → правило» до З13; без согласия — риски.

**З01. Стенд.** Файлы: `tests/support/{fakeCaldav,fakeCaldav.test,invariants,observe,seeds,context}.ts`; скрипты `test:tz`, `test:chains` в package.json; проект chains в `vitest.config.ts` вне `npm test`; `tests/meta/process-tz.test.ts`. Всё из §6; `makeContext` на настоящем `createClient`; в `seeds.ts` — затравки C55, C56, C62, C63 сырым текстом, как их записал старый код. Тесты: самопроверка; каждый инвариант (и DTEND+DURATION) ловит образец порчи.

**З02. Транспорт.** Файлы: `src/caldav/{request,objects}.ts` и тесты. Повторять только безопасные методы; PUT и DELETE — ровно раз; `applied` по Р8. Падают на старом коде: PUT на 503 уходит один раз; DELETE после TypeError не повторяется.

**З03. Значения и контракт ical.js.** Файлы: `src/ical/{values,timezones}.ts`, `tests/ical/{values,timezones,icaljs-contract}.test.ts`. О3, О4, `wallDateOf`; `ruleDict` — через `prop.jCal[3]` (`getFirstValue` кеширует `_values`, сериализуется jCal); UNTIL — jCal-строка (`toICAL` смотрит на `val.length > 10`). Контракт: свойства перед подкомпонентами; неизвестные части RRULE целы, `toJSON` их теряет; ошибка `RecurExpansion.next` на дубле EXDATE; RDATE-серия без DTSTART; `occurrence_number` считает только позиции правила — EXDATE итератор не знает, DTSTART во вторник при `BYDAY=MO,WE` не выдаётся, первая выдача — среда с номером 1; `ICAL.parse` бросает на `FREQ=FOO`, `BYDAY=0MO`, `BYMONTHDAY=32`, `COUNT=x`; неизвестный TZID — плавающее время; `getTimeZoneByID` ищет по дереву; `foldline` считает октеты.

**З04. Типы.** `src/types.ts`: поля из §2, `ObjectIO`; проверка — `tsc`.

**З15. Сборка новых событий** (после З03). Файлы: `build.ts` и тест. UNTIL на весь день — DATE; `YYYY-MM-DD` буквально; ISO без смещения — в поясе события. На старом коде все три падают под `TZ=America/New_York`.

**З05a–c. Цепочки на старом коде** (после З01). Только публичные функции; `instanceStart` — из выдачи; отказы — по `code`; каждая цепочка — `it.fails`. В отчёте — первое упавшее утверждение каждой цепочки на dd99d80.

| Задача | Файл в `tests/chains/` | Цепочки |
|---|---|---|
| З05a | `edit.test.ts` | C01–C06, C22–C25, C39, C43–C45, C53, C54, C58, C61 |
| З05a | `delete.test.ts` | C07–C10, C18, C20, C21, C42, C46, C50, C52, C57 |
| З05b | `split.test.ts` | C11–C14, C16, C28, C40, C41, C49, C51, C60 |
| З05b | `transport.test.ts` | C26, C27, C29, C59 |
| З05c | `foreign.test.ts` | C04, C15, C17, C30–C35, C37, C38, C48, C55, C56, C62, C63 |
| З05c | `allday.test.ts` | C19, C36, C47 |

**З06. Объект и слоты** (после З03, З04). Файлы: `src/ical/{object,slots}.ts` и тесты. `loadObject` по О1, О14, Р4 (`ICAL.parse` в try, иначе `Unparsable` построчно с развёрткой строк; TZID регистрируются до чтения значений); роли Р5 по порядку; `iterateSlots` по О2; `seriesExtent`, `isEmpty`, `lastSlotUpTo` без горизонта (≤ 200 000 шагов), `no-positions`; `positionsBefore`; `sameTail` на min(конец серии, 500 слотов, 5 лет), у YEARLY — 20 лет; digest по Р8, устойчивый к `normalizeOnStore`. Тесты: переопределение первым; дубль и «пустой» EXDATE; HOURLY; BYSETPOS; RID в поясе Berlin; COUNT при EXDATE; DTSTART в 1990; unsynced DTSTART; `isEmpty` у YEARLY;INTERVAL=2 и 29.02; роли `echo`, `stale-shift` у затравок C55, C56 и `detached` у настоящего; `Unparsable` на четырёх плохих RRULE; digest различает `{timeZone}`.

**З07. Экземпляры и адресация** (после З06). Файлы: `src/ical/instances.ts` и тест. Окно и сортировка — по фактическому времени; переопределение выдаётся только через слот, роль Р5 или как detached (прохода «по всем исключениям» нет); legacy-встреча — одна запись с `anomalies`; Р5–Р7. `resolveTarget`: слот или RID detached → RID скрытого или лишнего legacy-компонента (только delete) → фактические начала перенесённых; совпадение с другим экземпляром — `ambiguousWith`. Форматы Р10 — через `formatForModel`. Тесты: каждый код `AddressError`; S5c для delete и update; перенос из окна и в окно; прежний `…T00:00:00+00:00` у серии на весь день даёт ту же дату; C55, C56 без дублей.

**З08. Планы и правка** (после З06). Файлы: `src/ical/{plan,patch}.ts` и тест. О5–О10; `patchRule` по Р4; `overrideFromMaster` и `end` — с формой конца по О6, О8; ремонт legacy по Р5 (перенос RID, `losses`). Тесты: каждое поле трогает только свои `ICAL.Property`; PARTSTAT; чужие VALARM; SEQUENCE; WKST и неизвестные части целы; клон при DURATION и PERIOD.

**З12. Доставка** (после З02, З04, З06). Файлы: `src/domain/writes.ts` и тест. `ioFor` через `queryEventByUid`, `putObject`, `deleteObject`; `deliver` — Р8 строго по порядку правил 1–4 (прежние ETag и digest — в `before`); `writeSplit` — Р9, продолжение по пути `hrefFor(calendar, uid)`, при 412 или `unknown` с найденным объектом — перечитывание и сверка с `semanticDigest(plan.continuation.ics)`, усечение только после подтверждения; текст сбоя называет id продолжения и причину. Тесты на стенде: все ветки Р8, включая `dropRequest` для `{timeZone}`; 412 на продолжении с равным и другим digest; 507 на усечении; нет ложного «применено» при `normalizeOnStore`.

**З09. Чтение** (после З07). Файлы: `src/ical/{expand,parse}.ts`, `src/domain/freeSlots.ts` и тесты. Прежние экспорты сохранить, `env` необязателен; `parse.ts` — через основной компонент; `Unparsable` — по Р4. Падают на старом коде: сироты за UNTIL и под EXDATE скрыты; эхо и stale-shift не двоятся; объект из одних переопределений виден; CANCELLED; RANGE; RID в поясе Berlin; M1, M2 из R8; RDATE-серия с DTSTART; неразбираемый объект не роняет чтение.

**З10. Планировщики** (после З07, З08). Файл `src/ical/edit.ts` и тест. Таблица §3, Р1–Р7, Р9 без сети, Р12, О11, О13, О14. Порядок: `blockingAnomalies` → `resolveTarget` (`ambiguousWith` без confirm — отказ) → ветка по объекту и scope → `Expectation` (`touched` — из `patch.ts`, `tail` — из `seriesExtent`). UNTIL в all_series — через `lastSlotUpTo`; пустота — только `isEmpty`. Разрез: клон основного → DTSTART и дельта → `setRuleEnd`, `patchRule` → EXDATE и RDATE ≥ B со сдвигом → переопределения ≥ B с новыми UID и RID, `inheritFields` → VTIMEZONE → `sameTail` (иначе `split-mismatch`) → усечение исходного. Потери (Р1, `replace`, перенесённые раньше B, `ambiguous`, ремонт legacy) — в `losses` до плана. Тесты: C39, C41, C57, C58, C61 на уровне планов; `datesFixed`, `unsynced-rule`, `until-too-far`, `split-mismatch`; перечень потерь; каждая клетка таблицы §3 для одиночного, серии и объекта из одних переопределений.

**З11. Предохранитель** (после З07, З08; не автор З10). Файл `src/ical/guard.ts` и тест. О12 (а–д) только через `instances`, `slots`, `plan`. `GuardError` при: пересборке через `buildEvent`; снятом EXDATE; лишнем ключе; сдвиге даты при `datesFixed`; `delete-object` при живом detached; `delete-object` у YEARLY;INTERVAL=2 после delete this; потере последней встречи за горизонтом (UNTIL не пересчитан); DTEND вместе с DURATION; снятом чужом VALARM. Бюджет: 5 объектов по 20 000 позиций.

**З13. Оркестрация** (после З05a–c, З09–З12). Файлы: `src/domain/{edit,events}.ts`, `tests/domain/{update,delete,events,create}.test.ts`, `tests/chains/*` (снять `.fails`), `vitest.config.ts` (включить chains). Цикл: resolveCalendar → «только чтение» → `io.find` → etag (Р11) → `loadObject` → план → `verifyPlan` → `deliver` или `writeSplit` → ответ по записанному. Сделать: удалить старые помощники; `readEvents` передаёт `env` из `config` и оборачивает разбор каждого объекта; `readEvent` — основной компонент с `exceptions` и `anomalies`; `createEvent` через `deliver`; `Unparsable` — delete all_series без дерева и `verifyPlan`, прочее — `unparsable`; повтор разреза по Р9; `EditRefusal` → текст с кодом, потерями, etag, подсказкой; ответ — `loadObject` записанного текста; доменные тесты — на стенд. Готово: цепочки зелёные под тремя поясами, повторов PUT и DELETE в журнале нет.

**З14. MCP** (после З04; параллельно с З13 по сигнатурам). Файлы: `src/mcp/tools/{updateEvent,deleteEvent,readEvents}.ts`, `tests/mcp/{updateEvent,deleteEvent}.test.ts`. Частичный `recurrence` и `replace`; `status` без умолчания; общий `byWeekdaySchema` (T16-4); etag и confirm по Р11; описания `instanceStart` и кодов отказов. Падают на старом коде: status по умолчанию; `interval=1`; `0MO`; delete без etag.

**З16. Оракул и запреты** (после З13; не автор З10, З11). Файлы: `tests/random/{sequences.test,oracle}.ts`, `tests/meta/forbidden-apis.test.ts`. 300 зёрен по 6–8 операций; в генераторе редкие серии (YEARLY с INTERVAL ≥ 2), UNTIL за горизонтом, `dropRequest`; скан `src/ical` и `src/domain`, исключение — `instantOf`.

**З17. Документы** (после З00, З13, З14). `README.md` и разделы о правке, удалении, адресации и ошибках в `docs/superpowers/specs/2026-09-18-yandex-calendar-mcp-design.md`: новые поля, etag, confirm, форматы дат, коды отказов, ремонт legacy, письма.

**З18. Проверка** (после всех). Только отчёт в `.superpowers/sdd/…`. Готово, когда `npm test`, `test:chains`, `test:tz` зелёные, цепочки красные на dd99d80, M1–M28 убиты, ревью и разрушители выполнены.

## Поправки по итогам живой сверки (З00 выполнена 19.09.2026)

Факты и правила — таблица «Живая сверка поведения записи» в `docs/yandex-caldav-capabilities.md`, пункты Ж1–Ж18. Обязательные изменения к плану:

- **Р9 (разрез).** Яндекс не соблюдает `If-None-Match` (Ж13): повтор создания продолжения не даёт 412, а молча перезаписывает. Существование продолжения определять чтением перед созданием, а не по коду ответа. Ветка «412 на продолжении» на Яндексе недостижима; её логика переносится на результат предварительного чтения.
- **Р11 и удаление вообще.** Яндекс не соблюдает `If-Match` на `DELETE` (Ж15). Каждое удаление объекта предваряется чтением и сравнением ETag с ожидаемым; при несовпадении — отказ «событие изменили», удаление не выполняется. То же предварительное чтение нужно `writes.ts` для любого DELETE.
- **Р8 (неизвестный исход).** ETag меняется при любой записи (Ж12), текст правила и VTIMEZONE сервер переписывает (Ж5, Ж10). Дайджест для сверки считать по смыслу: раскрытые слоты, основные поля, переопределения по моменту `RECURRENCE-ID` — не по тексту и не по ETag.
- **Р4 и схемы (З14).** Правила с `BYSETPOS` и `WKST` отклонять при записи (Ж6). После каждой записи правила — сверка раскрытых слотов с ожидаемыми; расхождение — ошибка с объяснением, что Яндекс исказил правило.
- **О10 (письма, SEQUENCE).** `ORGANIZER`, равный логину, — собственный (Ж9). `SEQUENCE` увеличивает клиент (Ж11).
- **Свойства вне модели.** `X-…` и `CATEGORIES` Яндекс не хранит (Ж7, Ж8): требования сохранять их при правке остаются для чужих объектов из других клиентов, но тесты на живом Яндексе их не проверяют.

## Поправка: без ремонта следов прежнего кода (19.09.2026)

Роли переопределений `stale-shift` и `echo` и ремонт `legacy-override` (Р5 в части следов старого кода, Р12) исключены. Они распознавали объекты, испорченные прежним кодом этого сервера, но прежний код ни разу не писал в календарь пользователя: сервер не был подключён, а живые записи шли во временный календарь, удалённый после проверки. При этом эвристика уже дважды принимала законную перенесённую встречу за след и прятала её.

Роли переопределений — ровно три, по порядку:
1. `slot` — RECURRENCE-ID совпадает со слотом серии;
2. `hidden` — RECURRENCE-ID под EXDATE или вне протяжённости серии;
3. `detached` — остальные: показываются как отдельная встреча с `instanceStart` = RID и адресуются по нему.

Аномалии объектов от других клиентов (`multiple-masters`, `mixed-uids`, `range-override`, `unparsable`) остаются в силе вместе с их ограничениями. Цепочки тестов, ожидающие ремонта следов прежнего кода, удаляются.

## Поправка: испорченные объекты других клиентов (20.09.2026)

О14 переписан. Аномалии `duplicate-override` (дубль RECURRENCE-ID) и `multiple-rrules` (несколько RRULE у основного компонента) блокируют правку любого scope и удаление со scope `this` и `this_and_following`. Причина: объект испорчен не нами, и любая запись в него — угадывание, какая копия настоящая; прежнее узкое правило «кроме delete this по дублирующему слоту» отменено.

Исключение: удаление, план которого — удаление объекта целиком и никакой записи не делает (одиночное событие при любом scope; `this_and_following` по первой видимой встрече), не блокируется. Обоснование блокировки к нему не относится: записи нет, угадывания нет.

Текст отказа не обещает поведения веб-интерфейса, которое не проверено живой сверкой: он называет аномалию, советует исправить событие в веб-интерфейсе Яндекса и напоминает, что удалить событие целиком можно через `delete_event` со `scope: "all_series"`.
