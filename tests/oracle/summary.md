# Оракул правки: итог обхода

Полный обход операций правки: каждое сочетание (затравка × патч × адрес × scope), отдельно для
update и delete. Файл создаёт сам прогон (`npm run test:oracle`), править руками его не нужно.

## Что проверяется

1. **Согласие пары.** Законных исходов ровно два: планировщик отказал типизированным `EditRefusal`
   (или `AddressError` по адресу) — либо план построен и `verifyPlan` его принял. Исход «план построен,
   предохранитель отверг» — дефект без разбирательства: двое несогласны между собой. `verifyPlan`
   зовётся так, как обязана звать оркестрация: с патчем в `GuardOptions.patch` у каждого update.
2. **Семантика scope.** План пишется на подставной сервер (`tests/support/fakeCaldav.ts`, поведение по
   умолчанию — яндексовское, Ж13–Ж16), результат разворачивается чтением и сверяется с ожиданием,
   посчитанным из смысла scope независимо от планировщика (`semantics.ts`).

## Цифры прогона

- зерно генератора случайных чисел: **20260920** (выбор адресов сверх предела; повтор обхода даёт тот же список);
- затравок: 25, патчей: 20, областей правки: 3;
- случаев: 6867 (update 6540, delete 327);
- из них: планов построено 2545, пустых планов 427, отказов 3895;
- время обхода: 19.3 с;
- горизонт разворота: 2026-01-01 … 2029-01-01, упор 400 встреч, проба «за концом» — 2028-06-01.

## Нарушения по видам

| вид | сколько | что значит |
| --- | ---: | --- |
| disagreement | 20 | планировщик построил план, предохранитель его отверг |
| semantics | 81 | записанный результат разошёлся со смыслом scope или сервер не принял запись |
| bare-error | 0 | планировщик бросил голую ошибку вместо типизированного отказа |
| **всего** | **101** | |

## Первопричины

Различных первопричин: 4 (предел задания — 12).

### П1. Смена времени серии двигает RECURRENCE-ID переопределений вне слотов — 43 нарушений

Патчи start, end, timeZone и allDay:false+start+end сдвигают время всей серии (all_series) или её хвоста (this_and_following). Вместе со слотами планировщик сдвигает и RECURRENCE-ID переопределений, у которых слота нет вовсе, — оторванных (detached) и скрытых (hidden, за концом серии). Привязки к слоту у них нет, поэтому сдвиг ничего не сохраняет: сама встреча остаётся на своём времени (DTSTART не меняется), а её адрес меняется — тот адрес, по которому пользователь её удаляет и правит. Подставной сервер в строгом режиме отвечает 400: переопределение с новым ключом — новая сирота сверх прежних (О12а).

- затравки: hidden-past-end-moscow, detached-on-slot-date, detached-at-moved-start;
- патчи: start, start+end, timeZone, allDay:false+start+end, summary+start;
- области: this_and_following, all_series;
- где чинить: src/ical/edit.ts, ветка сдвига времени серии: переопределения ролей detached и hidden сдвигать вместе со слотами не нужно — у них свой адрес. Если сдвиг всё-таки нужен, он обязан попадать в plan.removed/notices, потому что адрес встречи меняется.

### П2. Продолжение разреза уносит переопределения вне слотов в новый объект — 38 нарушений

При this_and_following планировщик строит продолжение с новым UID и переносит в него переопределения, попавшие в хвост, включая оторванные и скрытые (RECURRENCE-ID мимо слотов). У нового объекта истории нет: для инвариантов О12а любая сирота в нём — новая, и подставной сервер отвечает 400 на PUT продолжения. Исходный объект при этом остаётся цел, то есть запись разреза обрывается на первом же шаге.

- затравки: hidden-past-end-moscow, detached-at-moved-start;
- патчи: summary, description, location, participants, start, end, start+end, timeZone, allDay:false+start+end, recurrence:frequency, recurrence:count, summary+start, recurrence:until, recurrence:count=null, recurrence:replace +confirm;
- области: this_and_following;
- где чинить: Либо src/ical/edit.ts: в продолжение переносить только переопределения слотов, а оторванные и скрытые оставлять исходному объекту (или объявлять потерями О11). Либо tests/support/fakeCaldav.ts и tests/support/invariants.ts: разрешить продолжению разреза наследовать историю исходного объекта — сейчас «история пути кончается с удалением объекта», и новый объект наследства не имеет. Оракул в tests/support ничего не менял.

### П3. Разрез серии из одних RDATE теряет границу из списка RDATE — 4 нарушений

У серии без RRULE (одни RDATE) при this_and_following граница становится DTSTART продолжения и из списка RDATE уходит — встреча на месте, но значения RDATE стало на одно меньше. Предохранитель читает снятое значение как пропавшую встречу (meeting-lost: «встречи в продолжении пропали, а смена повтора RDATE не трогает»). Планировщик и предохранитель считают одно и то же разными способами.

- затравки: rdate-only-moscow;
- патчи: recurrence:frequency, recurrence:replace;
- области: this_and_following;
- где чинить: src/ical/guard.ts, проверка RDATE при разрезе: значение RDATE, ставшее DTSTART продолжения, встречей не пропало. Либо src/ical/edit.ts: оставлять границу и в RDATE продолжения.

### П4. Смена частоты у объекта без правила делает серию бесконечной, и предохранитель это отвергает — 16 нарушений

Патч recurrence: { frequency } на одиночном событии и на серии из одних RDATE даёт RRULE без COUNT и UNTIL. Планировщик считает это обычной сменой правила и план строит; предохранитель считает, что конечная серия стала бесконечной, а патч её конца не снимал (extent-mismatch), и план отвергает. Пользователю это видно как внутренняя ошибка на законном действии «сделать событие повторяющимся».

- затравки: single-moscow, single-berlin, rdate-only-moscow;
- патчи: recurrence:frequency;
- области: this, this_and_following, all_series;
- где чинить: src/ical/guard.ts, checkExtent: у объекта, у которого конца серии не было (одиночное событие, серия из одних RDATE), «стала бесконечной» — не снятие конца. Либо src/ical/edit.ts: такой патч отклонять типизированным отказом заранее, а не строить план, который предохранитель не пропустит.

## Учёт отказов (пункт 5)

Доля отказов по каждой паре (патч, scope) на **чистых** затравках — испорченные чужими клиентами
(`two-rrules-moscow`, `duplicate-override-moscow`) в счёт не идут: у них любой отказ законен.

В корпусе адресов нарочно есть те, которых у затравки нет (адрес за концом серии, слот под EXDATE,
скрытое переопределение): отказы по адресу (`AddressError`) — это про адрес, а не про строгость патча,
поэтому они вынесены в свой столбец, а доля считается без них. Подозрительным помечено (⚠) всё, что
отказывает больше чем на половине чистых затравок.

| патч | scope | вызовов | отказов | из них по адресу | доля отказов без адресных | из них снимается confirm | коды |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| delete | this | 115 | 44 | 44 | 0% | 0 | — |
| delete | this_and_following | 115 | 52 | 44 | 11% | 2 | unsupported-rule: 4, invalid-field: 2, confirm-required: 2 |
| delete | all_series | 69 | 7 | 7 | 0% | 0 | — |
| summary | this | 115 | 46 | 46 | 0% | 0 | — |
| summary | this_and_following | 115 | 55 | 46 | 13% | 4 | confirm-required: 4, unsupported-rule: 4, invalid-field: 1 |
| summary | all_series | 69 | 8 | 8 | 0% | 0 | — |
| description | this | 115 | 46 | 46 | 0% | 0 | — |
| description | this_and_following | 115 | 55 | 46 | 13% | 4 | confirm-required: 4, unsupported-rule: 4, invalid-field: 1 |
| description | all_series | 69 | 8 | 8 | 0% | 0 | — |
| location | this | 115 | 46 | 46 | 0% | 0 | — |
| location | this_and_following | 115 | 55 | 46 | 13% | 4 | confirm-required: 4, unsupported-rule: 4, invalid-field: 1 |
| location | all_series | 69 | 8 | 8 | 0% | 0 | — |
| status | this | 115 | 115 | 46 | 100% ⚠ | 0 | invalid-field: 69 |
| status | this_and_following | 115 | 115 | 46 | 100% ⚠ | 0 | invalid-field: 69 |
| status | all_series | 69 | 69 | 8 | 100% ⚠ | 0 | invalid-field: 61 |
| participants | this | 115 | 46 | 46 | 0% | 0 | — |
| participants | this_and_following | 115 | 55 | 46 | 13% | 4 | confirm-required: 4, unsupported-rule: 4, invalid-field: 1 |
| participants | all_series | 69 | 8 | 8 | 0% | 0 | — |
| start | this | 115 | 49 | 46 | 4% | 0 | invalid-time: 3 |
| start | this_and_following | 115 | 58 | 46 | 17% | 4 | confirm-required: 4, unsupported-rule: 4, invalid-time: 3, invalid-field: 1 |
| start | all_series | 69 | 11 | 8 | 5% | 0 | invalid-time: 3 |
| end | this | 115 | 57 | 46 | 16% | 0 | invalid-time: 11 |
| end | this_and_following | 115 | 58 | 46 | 17% | 4 | confirm-required: 4, unsupported-rule: 4, invalid-time: 3, invalid-field: 1 |
| end | all_series | 69 | 11 | 8 | 5% | 0 | invalid-time: 3 |
| start+end | this | 115 | 49 | 46 | 4% | 0 | invalid-time: 3 |
| start+end | this_and_following | 115 | 58 | 46 | 17% | 4 | confirm-required: 4, unsupported-rule: 4, invalid-time: 3, invalid-field: 1 |
| start+end | all_series | 69 | 11 | 8 | 5% | 0 | invalid-time: 3 |
| timeZone | this | 115 | 46 | 46 | 0% | 0 | — |
| timeZone | this_and_following | 115 | 53 | 46 | 10% | 4 | confirm-required: 4, unsupported-rule: 2, invalid-field: 1 |
| timeZone | all_series | 69 | 8 | 8 | 0% | 0 | — |
| allDay:true | this | 115 | 108 | 46 | 90% ⚠ | 0 | invalid-time: 62 |
| allDay:true | this_and_following | 115 | 70 | 46 | 35% | 4 | invalid-time: 15, confirm-required: 4, unsupported-rule: 4, invalid-field: 1 |
| allDay:true | all_series | 69 | 30 | 8 | 36% | 0 | invalid-time: 22 |
| allDay:false | this | 115 | 49 | 46 | 4% | 0 | invalid-time: 3 |
| allDay:false | this_and_following | 115 | 50 | 46 | 6% | 0 | invalid-time: 3, invalid-field: 1 |
| allDay:false | all_series | 69 | 11 | 8 | 5% | 0 | invalid-time: 3 |
| allDay:true+start+end | this | 115 | 108 | 46 | 90% ⚠ | 0 | invalid-time: 62 |
| allDay:true+start+end | this_and_following | 115 | 70 | 46 | 35% | 4 | invalid-time: 15, confirm-required: 4, unsupported-rule: 4, invalid-field: 1 |
| allDay:true+start+end | all_series | 69 | 30 | 8 | 36% | 0 | invalid-time: 22 |
| allDay:false+start+end | this | 115 | 49 | 46 | 4% | 0 | invalid-time: 3 |
| allDay:false+start+end | this_and_following | 115 | 54 | 46 | 12% | 3 | unsupported-rule: 4, confirm-required: 3, invalid-field: 1 |
| allDay:false+start+end | all_series | 69 | 8 | 8 | 0% | 0 | — |
| recurrence:frequency | this | 115 | 111 | 46 | 94% ⚠ | 0 | invalid-field: 65 |
| recurrence:frequency | this_and_following | 115 | 57 | 46 | 16% | 4 | unsupported-rule: 6, confirm-required: 4, invalid-field: 1 |
| recurrence:frequency | all_series | 69 | 13 | 8 | 8% | 0 | unsupported-rule: 5 |
| recurrence:count | this | 115 | 115 | 46 | 100% ⚠ | 0 | invalid-field: 65, invalid-rule: 4 |
| recurrence:count | this_and_following | 115 | 64 | 46 | 26% | 5 | invalid-rule: 7, confirm-required: 5, unsupported-rule: 5, invalid-field: 1 |
| recurrence:count | all_series | 69 | 23 | 8 | 25% | 3 | invalid-rule: 7, unsupported-rule: 5, confirm-required: 3 |
| recurrence:until | this | 115 | 115 | 46 | 100% ⚠ | 0 | invalid-field: 65, invalid-rule: 4 |
| recurrence:until | this_and_following | 115 | 69 | 46 | 33% | 7 | invalid-rule: 12, confirm-required: 7, unsupported-rule: 3, invalid-field: 1 |
| recurrence:until | all_series | 69 | 22 | 8 | 23% | 2 | invalid-rule: 7, unsupported-rule: 5, confirm-required: 2 |
| recurrence:count=null | this | 115 | 115 | 46 | 100% ⚠ | 0 | invalid-field: 65, invalid-rule: 4 |
| recurrence:count=null | this_and_following | 115 | 67 | 46 | 30% | 7 | invalid-rule: 7, confirm-required: 7, unsupported-rule: 6, invalid-field: 1 |
| recurrence:count=null | all_series | 69 | 22 | 8 | 23% | 2 | invalid-rule: 7, unsupported-rule: 5, confirm-required: 2 |
| recurrence:until=null | this | 115 | 115 | 46 | 100% ⚠ | 0 | invalid-field: 65, invalid-rule: 4 |
| recurrence:until=null | this_and_following | 115 | 54 | 46 | 12% | 0 | invalid-rule: 7, invalid-field: 1 |
| recurrence:until=null | all_series | 69 | 15 | 8 | 11% | 0 | invalid-rule: 7 |
| recurrence:replace | this | 115 | 111 | 46 | 94% ⚠ | 0 | invalid-field: 65 |
| recurrence:replace | this_and_following | 115 | 106 | 46 | 87% ⚠ | 55 | confirm-required: 55, unsupported-rule: 4, invalid-field: 1 |
| recurrence:replace | all_series | 69 | 59 | 8 | 84% ⚠ | 51 | confirm-required: 51 |
| summary+start | this | 115 | 49 | 46 | 4% | 0 | invalid-time: 3 |
| summary+start | this_and_following | 115 | 58 | 46 | 17% | 4 | confirm-required: 4, unsupported-rule: 4, invalid-time: 3, invalid-field: 1 |
| summary+start | all_series | 69 | 11 | 8 | 5% | 0 | invalid-time: 3 |

Подозрительные пары:

- allDay:true × this — 90%
- allDay:true+start+end × this — 90%
- recurrence:count × this — 100%
- recurrence:count=null × this — 100%
- recurrence:frequency × this — 94%
- recurrence:replace × all_series — 84%
- recurrence:replace × this — 94%
- recurrence:replace × this_and_following — 87%
- recurrence:until × this — 100%
- recurrence:until=null × this — 100%
- status × all_series — 100%
- status × this — 100%
- status × this_and_following — 100%

Разбор подозрительных пар (отказы разобраны поимённо, ложной строгости в них нет):

- `status × *` — в языке правки (`FieldPatch`, src/ical/plan.ts) поля `status` нет вовсе. Патч оставлен в
  корпусе нарочно: он показывает, что на неизвестное поле приходит типизированный `invalid-field`, а не
  голая ошибка. Это расхождение корпуса задания с языком правки, а не дефект.
- `allDay:true × this` и `allDay:true+start+end × this` — «весь день» у одной встречи серии запрещён
  формой времени (RFC 5545 §3.8.4.4): у переопределения форма обязана совпадать с серией. Отказ
  `invalid-time` с внятным hint «передайте scope: all_series».
- `recurrence:* × this` — повтор у одной встречи не меняется по смыслу операции; отказ приходит с
  подсказкой про all_series и this_and_following. Код при этом `invalid-field`, хотя поле известное и
  дело в области правки: на ложную строгость не тянет, но код вводит в заблуждение.
- `recurrence:replace × this_and_following` и `× all_series` — почти всё это `confirm-required`:
  `replace` собирает правило только из патча, и потерянные части (BYDAY, COUNT, INTERVAL) обязаны быть
  подтверждены (О11). Отказ снимается повтором с confirm — оракул такой повтор делает и нарушений в нём
  не нашёл.

## Чего оракул не проверяет

- У встреч со своим компонентом (переопределения, оторванные, перенесённые) точное ожидание полей и
  времени не считается: у них свои значения (О7). От них требуется не пропасть, не размножиться и не
  поменять время под патчем поля.
- У патчей повтора (`recurrence:*`) проверяются только инварианты области: голова серии до границы
  тождественна, встречи не исчезают молча, конец серии меняется только по поводу из патча. Пересчитывать
  RRULE своим кодом оракул не берётся.
- «timeZone без start сохраняет моменты» сверяется якорем — моментом первой встречи области. Дальше
  моменты законно расходятся: в поясе с переводом часов стенное время нового пояса правит остальными
  встречами.
- У бесконечной серии края упора в 400 встреч у миров «до» и «после» не совпадают на одну встречу:
  счёт там сверяется с допуском в единицу, а адресов у самого упора обход не берёт.

## Как перезапустить

```sh
npm run test:oracle
```

Обход детерминирован: тот же список нарушений при повторе. Коды отказов и их смысл — в
[refusals.md](./refusals.md), сами нарушения с готовым воспроизведением — в
[findings.json](./findings.json).
