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
3. **Инварианты, не зависящие от scope.** После любой правки: у каждой встречи, кроме названной при
   `scope: this`, конец строго позже начала, а длительность — либо прежняя, либо ровно та, которую назвал
   патч; перенесённая встреча (своё `DTSTART` мимо слота) под патчем времени серии остаётся на своём
   времени, если план не назвал её в потерях или пояснениях; напоминание письмом не остаётся без адресата.

## Цифры прогона

- зерно генератора случайных чисел: **20260920** (выбор адресов сверх предела; повтор обхода даёт тот же список);
- затравок: 31, патчей: 21, областей правки: 3;
- случаев: 8954 (update 8547, delete 407);
- из них: планов построено 3132, пустых планов 455, отказов 5367;
- горизонт разворота: 2026-01-01 … 2029-01-01, упор 400 встреч, проба «за концом» — 2028-06-01.

## Нарушения по видам

| вид | сколько | что значит |
| --- | ---: | --- |
| disagreement | 0 | планировщик построил план, предохранитель его отверг |
| semantics | 0 | записанный результат разошёлся со смыслом scope или сервер не принял запись |
| bare-error | 0 | планировщик бросил голую ошибку вместо типизированного отказа |
| **всего** | **0** | |

## Первопричины

Различных первопричин: 0 (предел задания — 12).

## Учёт отказов (пункт 5)

Доля отказов по каждой паре (патч, scope) на **чистых** затравках — испорченные чужими клиентами
(`two-rrules-moscow`, `duplicate-override-moscow`) в счёт не идут: у них любой отказ законен.

В корпусе адресов нарочно есть те, которых у затравки нет (адрес за концом серии, слот под EXDATE,
скрытое переопределение): отказы по адресу (`AddressError`) — это про адрес, а не про строгость патча,
поэтому они вынесены в свой столбец, а доля считается без них. Подозрительным помечено (⚠) всё, что
отказывает больше чем на половине чистых затравок.

| патч | scope | вызовов | отказов | из них по адресу | доля отказов без адресных | из них снимается confirm | коды |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| delete | this | 146 | 56 | 56 | 0% | 0 | — |
| delete | this_and_following | 146 | 65 | 56 | 10% | 2 | unsupported-rule: 4, invalid-field: 3, confirm-required: 2 |
| delete | all_series | 87 | 8 | 8 | 0% | 0 | — |
| summary | this | 146 | 71 | 59 | 14% | 0 | invalid-time: 12 |
| summary | this_and_following | 146 | 77 | 59 | 21% | 5 | invalid-time: 8, confirm-required: 5, unsupported-rule: 4, invalid-field: 1 |
| summary | all_series | 87 | 10 | 10 | 0% | 0 | — |
| description | this | 146 | 71 | 59 | 14% | 0 | invalid-time: 12 |
| description | this_and_following | 146 | 77 | 59 | 21% | 5 | invalid-time: 8, confirm-required: 5, unsupported-rule: 4, invalid-field: 1 |
| description | all_series | 87 | 10 | 10 | 0% | 0 | — |
| location | this | 146 | 71 | 59 | 14% | 0 | invalid-time: 12 |
| location | this_and_following | 146 | 77 | 59 | 21% | 5 | invalid-time: 8, confirm-required: 5, unsupported-rule: 4, invalid-field: 1 |
| location | all_series | 87 | 10 | 10 | 0% | 0 | — |
| status | this | 146 | 146 | 59 | 100% ⚠ | 0 | invalid-field: 75, invalid-time: 12 |
| status | this_and_following | 146 | 146 | 59 | 100% ⚠ | 0 | invalid-field: 79, invalid-time: 8 |
| status | all_series | 87 | 87 | 10 | 100% ⚠ | 0 | invalid-field: 77 |
| participants | this | 146 | 71 | 59 | 14% | 0 | invalid-time: 12 |
| participants | this_and_following | 146 | 77 | 59 | 21% | 5 | invalid-time: 8, confirm-required: 5, unsupported-rule: 4, invalid-field: 1 |
| participants | all_series | 87 | 10 | 10 | 0% | 0 | — |
| reminders | this | 146 | 71 | 59 | 14% | 0 | invalid-time: 12 |
| reminders | this_and_following | 146 | 77 | 59 | 21% | 5 | invalid-time: 8, confirm-required: 5, unsupported-rule: 4, invalid-field: 1 |
| reminders | all_series | 87 | 10 | 10 | 0% | 0 | — |
| start | this | 146 | 74 | 59 | 17% | 0 | invalid-time: 15 |
| start | this_and_following | 146 | 85 | 59 | 30% | 5 | invalid-time: 15, confirm-required: 5, unsupported-rule: 4, invalid-field: 1, unsynced-rule: 1 |
| start | all_series | 87 | 26 | 10 | 21% | 0 | invalid-time: 14, unsynced-rule: 2 |
| end | this | 146 | 84 | 59 | 29% | 0 | invalid-time: 25 |
| end | this_and_following | 146 | 84 | 59 | 29% | 5 | invalid-time: 15, confirm-required: 5, unsupported-rule: 4, invalid-field: 1 |
| end | all_series | 87 | 24 | 10 | 18% | 0 | invalid-time: 14 |
| start+end | this | 146 | 74 | 59 | 17% | 0 | invalid-time: 15 |
| start+end | this_and_following | 146 | 79 | 59 | 23% | 5 | invalid-time: 9, confirm-required: 5, unsupported-rule: 4, invalid-field: 1, unsynced-rule: 1 |
| start+end | all_series | 87 | 20 | 10 | 13% | 0 | invalid-time: 8, unsynced-rule: 2 |
| timeZone | this | 146 | 71 | 59 | 14% | 0 | invalid-time: 12 |
| timeZone | this_and_following | 146 | 79 | 59 | 23% | 5 | invalid-time: 12, confirm-required: 5, unsupported-rule: 2, invalid-field: 1 |
| timeZone | all_series | 87 | 21 | 10 | 14% | 0 | invalid-time: 11 |
| allDay:true | this | 146 | 139 | 59 | 92% ⚠ | 0 | invalid-time: 80 |
| allDay:true | this_and_following | 146 | 94 | 59 | 40% | 4 | invalid-time: 26, confirm-required: 4, unsupported-rule: 4, invalid-field: 1 |
| allDay:true | all_series | 87 | 45 | 10 | 45% | 0 | invalid-time: 35 |
| allDay:false | this | 146 | 74 | 59 | 17% | 0 | invalid-time: 15 |
| allDay:false | this_and_following | 146 | 75 | 59 | 18% | 0 | invalid-time: 15, invalid-field: 1 |
| allDay:false | all_series | 87 | 24 | 10 | 18% | 0 | invalid-time: 14 |
| allDay:true+start+end | this | 146 | 139 | 59 | 92% ⚠ | 0 | invalid-time: 80 |
| allDay:true+start+end | this_and_following | 146 | 85 | 59 | 30% | 4 | invalid-time: 17, confirm-required: 4, unsupported-rule: 4, invalid-field: 1 |
| allDay:true+start+end | all_series | 87 | 37 | 10 | 35% | 0 | invalid-time: 27 |
| allDay:false+start+end | this | 146 | 74 | 59 | 17% | 0 | invalid-time: 15 |
| allDay:false+start+end | this_and_following | 146 | 72 | 59 | 15% | 4 | confirm-required: 4, unsupported-rule: 4, invalid-time: 3, invalid-field: 1, unsynced-rule: 1 |
| allDay:false+start+end | all_series | 87 | 15 | 10 | 6% | 0 | invalid-time: 3, unsynced-rule: 2 |
| recurrence:frequency | this | 146 | 142 | 59 | 95% ⚠ | 0 | invalid-scope: 83 |
| recurrence:frequency | this_and_following | 146 | 83 | 59 | 28% | 5 | invalid-time: 12, unsupported-rule: 6, confirm-required: 5, invalid-field: 1 |
| recurrence:frequency | all_series | 87 | 26 | 10 | 21% | 0 | invalid-time: 11, unsupported-rule: 5 |
| recurrence:count | this | 146 | 146 | 59 | 100% ⚠ | 0 | invalid-scope: 83, invalid-rule: 4 |
| recurrence:count | this_and_following | 146 | 90 | 59 | 36% | 6 | invalid-time: 12, invalid-rule: 7, confirm-required: 6, unsupported-rule: 5, invalid-field: 1 |
| recurrence:count | all_series | 87 | 36 | 10 | 34% | 3 | invalid-time: 11, invalid-rule: 7, unsupported-rule: 5, confirm-required: 3 |
| recurrence:until | this | 146 | 146 | 59 | 100% ⚠ | 0 | invalid-scope: 83, invalid-rule: 4 |
| recurrence:until | this_and_following | 146 | 95 | 59 | 41% | 8 | invalid-rule: 12, invalid-time: 12, confirm-required: 8, unsupported-rule: 3, invalid-field: 1 |
| recurrence:until | all_series | 87 | 35 | 10 | 32% | 2 | invalid-time: 11, invalid-rule: 7, unsupported-rule: 5, confirm-required: 2 |
| recurrence:count=null | this | 146 | 146 | 59 | 100% ⚠ | 0 | invalid-scope: 83, invalid-rule: 4 |
| recurrence:count=null | this_and_following | 146 | 93 | 59 | 39% | 8 | invalid-time: 12, confirm-required: 8, invalid-rule: 7, unsupported-rule: 6, invalid-field: 1 |
| recurrence:count=null | all_series | 87 | 35 | 10 | 32% | 2 | invalid-time: 11, invalid-rule: 7, unsupported-rule: 5, confirm-required: 2 |
| recurrence:until=null | this | 146 | 146 | 59 | 100% ⚠ | 0 | invalid-scope: 83, invalid-rule: 4 |
| recurrence:until=null | this_and_following | 146 | 79 | 59 | 23% | 0 | invalid-time: 12, invalid-rule: 7, invalid-field: 1 |
| recurrence:until=null | all_series | 87 | 28 | 10 | 23% | 0 | invalid-time: 11, invalid-rule: 7 |
| recurrence:replace | this | 146 | 142 | 59 | 95% ⚠ | 0 | invalid-scope: 83 |
| recurrence:replace | this_and_following | 146 | 137 | 59 | 90% ⚠ | 61 | confirm-required: 61, invalid-time: 12, unsupported-rule: 4, invalid-field: 1 |
| recurrence:replace | all_series | 87 | 77 | 10 | 87% ⚠ | 56 | confirm-required: 56, invalid-time: 11 |
| summary+start | this | 146 | 74 | 59 | 17% | 0 | invalid-time: 15 |
| summary+start | this_and_following | 146 | 85 | 59 | 30% | 5 | invalid-time: 15, confirm-required: 5, unsupported-rule: 4, invalid-field: 1, unsynced-rule: 1 |
| summary+start | all_series | 87 | 26 | 10 | 21% | 0 | invalid-time: 14, unsynced-rule: 2 |

Подозрительные пары:

- allDay:true × this — 92%
- allDay:true+start+end × this — 92%
- recurrence:count × this — 100%
- recurrence:count=null × this — 100%
- recurrence:frequency × this — 95%
- recurrence:replace × all_series — 87%
- recurrence:replace × this — 95%
- recurrence:replace × this_and_following — 90%
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
- `recurrence:* × this` — повтор у одной встречи не меняется по смыслу операции; отказ приходит с кодом
  `invalid-scope` и подсказкой про all_series и this_and_following. Код говорит ровно то, что есть: поле
  известное, а в названной области не меняется.
- `recurrence:replace × this_and_following` и `× all_series` — почти всё это `confirm-required`:
  `replace` собирает правило только из патча, и потерянные части (BYDAY, COUNT, INTERVAL) обязаны быть
  подтверждены (О11). Отказ снимается повтором с confirm — оракул такой повтор делает и нарушений в нём
  не нашёл.

## Чего оракул не проверяет

- У встреч со своим компонентом (переопределения, оторванные, перенесённые) точное ожидание полей и
  времени не считается: у них свои значения (О7). От них требуется не пропасть, не размножиться, не
  поменять время под патчем поля, удержать годную длительность и — у перенесённых — остаться на своём
  времени под патчем времени серии.
- Напоминания в выдачу встречи не попадают, поэтому патч `reminders` сверяется не поимённо: проверяются
  инварианты области и то, что напоминание письмом не осталось без адресата (RFC 5545 §3.6.6).
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
