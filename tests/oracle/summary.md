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
- из них: планов построено 2535, пустых планов 427, отказов 3905;
- время обхода: 32.8 с;
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
| delete | this | 115 | 44 | 44 | 0% | 0 | — |
| delete | this_and_following | 115 | 52 | 44 | 11% | 2 | unsupported-rule: 4, invalid-field: 2, confirm-required: 2 |
| delete | all_series | 69 | 7 | 7 | 0% | 0 | — |
| summary | this | 115 | 46 | 46 | 0% | 0 | — |
| summary | this_and_following | 115 | 56 | 46 | 14% | 5 | confirm-required: 5, unsupported-rule: 4, invalid-field: 1 |
| summary | all_series | 69 | 8 | 8 | 0% | 0 | — |
| description | this | 115 | 46 | 46 | 0% | 0 | — |
| description | this_and_following | 115 | 56 | 46 | 14% | 5 | confirm-required: 5, unsupported-rule: 4, invalid-field: 1 |
| description | all_series | 69 | 8 | 8 | 0% | 0 | — |
| location | this | 115 | 46 | 46 | 0% | 0 | — |
| location | this_and_following | 115 | 56 | 46 | 14% | 5 | confirm-required: 5, unsupported-rule: 4, invalid-field: 1 |
| location | all_series | 69 | 8 | 8 | 0% | 0 | — |
| status | this | 115 | 115 | 46 | 100% ⚠ | 0 | invalid-field: 69 |
| status | this_and_following | 115 | 115 | 46 | 100% ⚠ | 0 | invalid-field: 69 |
| status | all_series | 69 | 69 | 8 | 100% ⚠ | 0 | invalid-field: 61 |
| participants | this | 115 | 46 | 46 | 0% | 0 | — |
| participants | this_and_following | 115 | 56 | 46 | 14% | 5 | confirm-required: 5, unsupported-rule: 4, invalid-field: 1 |
| participants | all_series | 69 | 8 | 8 | 0% | 0 | — |
| start | this | 115 | 49 | 46 | 4% | 0 | invalid-time: 3 |
| start | this_and_following | 115 | 59 | 46 | 19% | 5 | confirm-required: 5, unsupported-rule: 4, invalid-time: 3, invalid-field: 1 |
| start | all_series | 69 | 11 | 8 | 5% | 0 | invalid-time: 3 |
| end | this | 115 | 57 | 46 | 16% | 0 | invalid-time: 11 |
| end | this_and_following | 115 | 59 | 46 | 19% | 5 | confirm-required: 5, unsupported-rule: 4, invalid-time: 3, invalid-field: 1 |
| end | all_series | 69 | 11 | 8 | 5% | 0 | invalid-time: 3 |
| start+end | this | 115 | 49 | 46 | 4% | 0 | invalid-time: 3 |
| start+end | this_and_following | 115 | 59 | 46 | 19% | 5 | confirm-required: 5, unsupported-rule: 4, invalid-time: 3, invalid-field: 1 |
| start+end | all_series | 69 | 11 | 8 | 5% | 0 | invalid-time: 3 |
| timeZone | this | 115 | 46 | 46 | 0% | 0 | — |
| timeZone | this_and_following | 115 | 54 | 46 | 12% | 5 | confirm-required: 5, unsupported-rule: 2, invalid-field: 1 |
| timeZone | all_series | 69 | 8 | 8 | 0% | 0 | — |
| allDay:true | this | 115 | 108 | 46 | 90% ⚠ | 0 | invalid-time: 62 |
| allDay:true | this_and_following | 115 | 68 | 46 | 32% | 4 | invalid-time: 13, confirm-required: 4, unsupported-rule: 4, invalid-field: 1 |
| allDay:true | all_series | 69 | 30 | 8 | 36% | 0 | invalid-time: 22 |
| allDay:false | this | 115 | 49 | 46 | 4% | 0 | invalid-time: 3 |
| allDay:false | this_and_following | 115 | 50 | 46 | 6% | 0 | invalid-time: 3, invalid-field: 1 |
| allDay:false | all_series | 69 | 11 | 8 | 5% | 0 | invalid-time: 3 |
| allDay:true+start+end | this | 115 | 108 | 46 | 90% ⚠ | 0 | invalid-time: 62 |
| allDay:true+start+end | this_and_following | 115 | 68 | 46 | 32% | 4 | invalid-time: 13, confirm-required: 4, unsupported-rule: 4, invalid-field: 1 |
| allDay:true+start+end | all_series | 69 | 30 | 8 | 36% | 0 | invalid-time: 22 |
| allDay:false+start+end | this | 115 | 49 | 46 | 4% | 0 | invalid-time: 3 |
| allDay:false+start+end | this_and_following | 115 | 55 | 46 | 13% | 4 | confirm-required: 4, unsupported-rule: 4, invalid-field: 1 |
| allDay:false+start+end | all_series | 69 | 8 | 8 | 0% | 0 | — |
| recurrence:frequency | this | 115 | 111 | 46 | 94% ⚠ | 0 | invalid-scope: 65 |
| recurrence:frequency | this_and_following | 115 | 58 | 46 | 17% | 5 | unsupported-rule: 6, confirm-required: 5, invalid-field: 1 |
| recurrence:frequency | all_series | 69 | 13 | 8 | 8% | 0 | unsupported-rule: 5 |
| recurrence:count | this | 115 | 115 | 46 | 100% ⚠ | 0 | invalid-scope: 65, invalid-rule: 4 |
| recurrence:count | this_and_following | 115 | 65 | 46 | 28% | 5 | invalid-rule: 7, confirm-required: 5, unsupported-rule: 5, split-mismatch: 1, invalid-field: 1 |
| recurrence:count | all_series | 69 | 23 | 8 | 25% | 3 | invalid-rule: 7, unsupported-rule: 5, confirm-required: 3 |
| recurrence:until | this | 115 | 115 | 46 | 100% ⚠ | 0 | invalid-scope: 65, invalid-rule: 4 |
| recurrence:until | this_and_following | 115 | 70 | 46 | 35% | 6 | invalid-rule: 12, confirm-required: 6, unsupported-rule: 3, split-mismatch: 2, invalid-field: 1 |
| recurrence:until | all_series | 69 | 22 | 8 | 23% | 2 | invalid-rule: 7, unsupported-rule: 5, confirm-required: 2 |
| recurrence:count=null | this | 115 | 115 | 46 | 100% ⚠ | 0 | invalid-scope: 65, invalid-rule: 4 |
| recurrence:count=null | this_and_following | 115 | 68 | 46 | 32% | 6 | invalid-rule: 7, confirm-required: 6, unsupported-rule: 6, split-mismatch: 2, invalid-field: 1 |
| recurrence:count=null | all_series | 69 | 22 | 8 | 23% | 2 | invalid-rule: 7, unsupported-rule: 5, confirm-required: 2 |
| recurrence:until=null | this | 115 | 115 | 46 | 100% ⚠ | 0 | invalid-scope: 65, invalid-rule: 4 |
| recurrence:until=null | this_and_following | 115 | 54 | 46 | 12% | 0 | invalid-rule: 7, invalid-field: 1 |
| recurrence:until=null | all_series | 69 | 15 | 8 | 11% | 0 | invalid-rule: 7 |
| recurrence:replace | this | 115 | 111 | 46 | 94% ⚠ | 0 | invalid-scope: 65 |
| recurrence:replace | this_and_following | 115 | 106 | 46 | 87% ⚠ | 54 | confirm-required: 54, unsupported-rule: 4, split-mismatch: 1, invalid-field: 1 |
| recurrence:replace | all_series | 69 | 59 | 8 | 84% ⚠ | 51 | confirm-required: 51 |
| summary+start | this | 115 | 49 | 46 | 4% | 0 | invalid-time: 3 |
| summary+start | this_and_following | 115 | 59 | 46 | 19% | 5 | confirm-required: 5, unsupported-rule: 4, invalid-time: 3, invalid-field: 1 |
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
