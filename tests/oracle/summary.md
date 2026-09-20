# Оракул правки: итог обхода

Полный обход операций правки: каждое сочетание (затравка × патч × адрес × scope), отдельно для
update и delete. Файл создаёт сам прогон (`npm run test:oracle`), править руками его не нужно.

## Что проверяется

1. **Согласие пары.** Законных исходов ровно два: планировщик отказал типизированным `EditRefusal`
   (или `AddressError` по адресу) — либо план построен и `verifyPlan` его принял. Исход «план построен,
   предохранитель отверг» — дефект без разбирательства: двое несогласны между собой. `verifyPlan`
   зовётся так, как обязана звать оркестрация: с патчем в `GuardOptions.patch` у каждого update.
   Отдельно от разногласия считается `bare-guard` — предохранитель бросил не `GuardError`, а голую
   ошибку библиотеки: это нарушение договора одного участника, наружу ушло бы не «правка отклонена»,
   а внутренний сбой, и чинится оно не там, где законный отказ предохранителя.
2. **Семантика scope.** План пишется на подставной сервер (`tests/support/fakeCaldav.ts`, поведение по
   умолчанию — яндексовское, Ж13–Ж16), результат разворачивается чтением и сверяется с ожиданием,
   посчитанным из смысла scope независимо от планировщика (`semantics.ts`). Строгий режим сервера
   отклоняет запись, которая добавляет нарушение инвариантов сверх прежней версии объекта, — в том
   числе значение времени не по грамматике RFC 5545 §3.3.4–3.3.5 (`bad-time-value`): такую строку
   ical.js разбирает молча, а сервер и следующее чтение — нет.
3. **Инварианты, не зависящие от scope.** После любой правки: у каждой встречи, кроме названной при
   `scope: this`, конец строго позже начала, а длительность — либо прежняя, либо ровно та, которую назвал
   патч; перенесённая встреча (своё `DTSTART` мимо слота) под патчем времени серии остаётся на своём
   времени, если план не назвал её в потерях или пояснениях; напоминание письмом не остаётся без адресата.
4. **Запреты отказа.** Отказ — законный исход, и строгость его обход не обсуждает: он смотрит только
   туда, где корпус назвал код и объяснил, почему правка обязана была пройти (`bannedRefusals` затравки
   или патча). Такой отказ — нарушение вида `over-strict`, и чинится оно там, где стоит предел, а не там,
   где ломается запись. Запреты всегда именные — по коду отказа: законный отказ по другому поводу они не
   задевают, а снимаются сами, когда предел научится смотреть на существо дела.
5. **Сторожевое время и память.** Каждый случай выполняется в отдельном потоке (`isolate.ts`) под
   пределом 1500 мс и пределом кучи: планировщик и предохранитель работают синхронно, и без
   потока зацикленный разворот правила или разогнанная куча роняли бы весь прогон — не нарушением, а
   падением процесса без отчёта. Теперь это нарушение вида `timeout`, и обход идёт дальше.

## Цифры прогона

- зерно генератора случайных чисел: **20260920** (выбор адресов сверх предела; повтор обхода даёт тот же список);
- затравок: 35, патчей: 28, областей правки: 3;
- случаев: 13369 (update 12908, delete 461);
- из них: планов построено 4677, пустых планов 621, отказов 8071;
- горизонт разворота: 2026-01-01 … 2029-01-01, упор 400 встреч, проба «за концом» — 2028-06-01;
- у объекта, который весь стоит за этим окном (затравка у края года — 9999-й), окно своё: его собственный
  год целиком. Выбирается оно по началу СЕРИИ, чтобы не меняться между «до» и «после», когда правка уводит
  переопределение в другой год.

## Нарушения по видам

| вид | сколько | что значит |
| --- | ---: | --- |
| disagreement | 0 | планировщик построил план, предохранитель его отверг |
| semantics | 0 | записанный результат разошёлся со смыслом scope или сервер не принял запись |
| bare-error | 0 | планировщик бросил голую ошибку вместо типизированного отказа |
| bare-guard | 0 | предохранитель бросил голую ошибку библиотеки вместо GuardError |
| over-strict | 0 | отказ с кодом, который корпус объявил здесь незаконным: правка обязана была пройти |
| timeout | 0 | случай не уложился в сторожевое время или исчерпал кучу |
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
| delete | this | 167 | 64 | 64 | 0% | 0 | — |
| delete | this_and_following | 167 | 74 | 64 | 10% | 2 | invalid-field: 4, unsupported-rule: 4, confirm-required: 2 |
| delete | all_series | 99 | 10 | 10 | 0% | 0 | — |
| summary | this | 167 | 80 | 68 | 12% | 0 | invalid-time: 12 |
| summary | this_and_following | 167 | 86 | 68 | 18% | 5 | invalid-time: 8, confirm-required: 5, unsupported-rule: 4, invalid-field: 1 |
| summary | all_series | 99 | 12 | 12 | 0% | 0 | — |
| description | this | 167 | 80 | 68 | 12% | 0 | invalid-time: 12 |
| description | this_and_following | 167 | 86 | 68 | 18% | 5 | invalid-time: 8, confirm-required: 5, unsupported-rule: 4, invalid-field: 1 |
| description | all_series | 99 | 12 | 12 | 0% | 0 | — |
| location | this | 167 | 80 | 68 | 12% | 0 | invalid-time: 12 |
| location | this_and_following | 167 | 86 | 68 | 18% | 5 | invalid-time: 8, confirm-required: 5, unsupported-rule: 4, invalid-field: 1 |
| location | all_series | 99 | 12 | 12 | 0% | 0 | — |
| status | this | 167 | 80 | 68 | 12% | 0 | invalid-time: 12 |
| status | this_and_following | 167 | 86 | 68 | 18% | 5 | invalid-time: 8, confirm-required: 5, unsupported-rule: 4, invalid-field: 1 |
| status | all_series | 99 | 12 | 12 | 0% | 0 | — |
| participants | this | 167 | 80 | 68 | 12% | 0 | invalid-time: 12 |
| participants | this_and_following | 167 | 86 | 68 | 18% | 5 | invalid-time: 8, confirm-required: 5, unsupported-rule: 4, invalid-field: 1 |
| participants | all_series | 99 | 12 | 12 | 0% | 0 | — |
| reminders | this | 167 | 80 | 68 | 12% | 0 | invalid-time: 12 |
| reminders | this_and_following | 167 | 86 | 68 | 18% | 5 | invalid-time: 8, confirm-required: 5, unsupported-rule: 4, invalid-field: 1 |
| reminders | all_series | 99 | 12 | 12 | 0% | 0 | — |
| start | this | 167 | 83 | 68 | 15% | 0 | invalid-time: 15 |
| start | this_and_following | 167 | 94 | 68 | 26% | 5 | invalid-time: 15, confirm-required: 5, unsupported-rule: 4, invalid-field: 1, unsynced-rule: 1 |
| start | all_series | 99 | 28 | 12 | 18% | 0 | invalid-time: 14, unsynced-rule: 2 |
| end | this | 167 | 99 | 68 | 31% | 0 | invalid-time: 31 |
| end | this_and_following | 167 | 84 | 68 | 16% | 5 | invalid-time: 6, confirm-required: 5, unsupported-rule: 4, invalid-field: 1 |
| end | all_series | 99 | 17 | 12 | 6% | 0 | invalid-time: 5 |
| start+end | this | 167 | 83 | 68 | 15% | 0 | invalid-time: 15 |
| start+end | this_and_following | 167 | 85 | 68 | 17% | 5 | invalid-time: 6, confirm-required: 5, unsupported-rule: 4, invalid-field: 1, unsynced-rule: 1 |
| start+end | all_series | 99 | 19 | 12 | 8% | 0 | invalid-time: 5, unsynced-rule: 2 |
| timeZone | this | 167 | 80 | 68 | 12% | 0 | invalid-time: 12 |
| timeZone | this_and_following | 167 | 86 | 68 | 18% | 5 | invalid-time: 10, confirm-required: 5, unsupported-rule: 2, invalid-field: 1 |
| timeZone | all_series | 99 | 23 | 12 | 13% | 0 | invalid-time: 11 |
| allDay:true | this | 167 | 160 | 68 | 93% ⚠ | 0 | invalid-time: 92 |
| allDay:true | this_and_following | 167 | 93 | 68 | 25% | 4 | invalid-time: 16, confirm-required: 4, unsupported-rule: 4, invalid-field: 1 |
| allDay:true | all_series | 99 | 41 | 12 | 33% | 0 | invalid-time: 29 |
| allDay:false | this | 167 | 74 | 68 | 6% | 0 | invalid-time: 6 |
| allDay:false | this_and_following | 167 | 75 | 68 | 7% | 0 | invalid-time: 6, invalid-field: 1 |
| allDay:false | all_series | 99 | 17 | 12 | 6% | 0 | invalid-time: 5 |
| allDay:true+start+end | this | 167 | 160 | 68 | 93% ⚠ | 0 | invalid-time: 92 |
| allDay:true+start+end | this_and_following | 167 | 92 | 68 | 24% | 4 | invalid-time: 15, confirm-required: 4, unsupported-rule: 4, invalid-field: 1 |
| allDay:true+start+end | all_series | 99 | 39 | 12 | 31% | 0 | invalid-time: 27 |
| allDay:false+start+end | this | 167 | 83 | 68 | 15% | 0 | invalid-time: 15 |
| allDay:false+start+end | this_and_following | 167 | 78 | 68 | 10% | 4 | confirm-required: 4, unsupported-rule: 4, invalid-field: 1, unsynced-rule: 1 |
| allDay:false+start+end | all_series | 99 | 14 | 12 | 2% | 0 | unsynced-rule: 2 |
| recurrence:frequency | this | 167 | 163 | 68 | 96% ⚠ | 0 | invalid-scope: 95 |
| recurrence:frequency | this_and_following | 167 | 92 | 68 | 24% | 5 | invalid-time: 12, unsupported-rule: 6, confirm-required: 5, invalid-field: 1 |
| recurrence:frequency | all_series | 99 | 28 | 12 | 18% | 0 | invalid-time: 11, unsupported-rule: 5 |
| recurrence:count | this | 167 | 167 | 68 | 100% ⚠ | 0 | invalid-scope: 95, invalid-rule: 4 |
| recurrence:count | this_and_following | 167 | 96 | 68 | 28% | 7 | invalid-time: 8, invalid-rule: 7, confirm-required: 7, unsupported-rule: 5, invalid-field: 1 |
| recurrence:count | all_series | 99 | 41 | 12 | 33% | 6 | invalid-time: 11, invalid-rule: 7, confirm-required: 6, unsupported-rule: 5 |
| recurrence:until | this | 167 | 167 | 68 | 100% ⚠ | 0 | invalid-scope: 95, invalid-rule: 4 |
| recurrence:until | this_and_following | 167 | 109 | 68 | 41% | 8 | invalid-rule: 17, invalid-time: 12, confirm-required: 8, unsupported-rule: 3, invalid-field: 1 |
| recurrence:until | all_series | 99 | 39 | 12 | 31% | 2 | invalid-time: 11, invalid-rule: 9, unsupported-rule: 5, confirm-required: 2 |
| recurrence:count=null | this | 167 | 167 | 68 | 100% ⚠ | 0 | invalid-scope: 95, invalid-rule: 4 |
| recurrence:count=null | this_and_following | 167 | 102 | 68 | 34% | 8 | invalid-time: 12, confirm-required: 8, invalid-rule: 7, unsupported-rule: 6, invalid-field: 1 |
| recurrence:count=null | all_series | 99 | 37 | 12 | 29% | 2 | invalid-time: 11, invalid-rule: 7, unsupported-rule: 5, confirm-required: 2 |
| recurrence:until=null | this | 167 | 167 | 68 | 100% ⚠ | 0 | invalid-scope: 95, invalid-rule: 4 |
| recurrence:until=null | this_and_following | 167 | 76 | 68 | 8% | 0 | invalid-rule: 7, invalid-field: 1 |
| recurrence:until=null | all_series | 99 | 19 | 12 | 8% | 0 | invalid-rule: 7 |
| recurrence:replace | this | 167 | 163 | 68 | 96% ⚠ | 0 | invalid-scope: 95 |
| recurrence:replace | this_and_following | 167 | 158 | 68 | 91% ⚠ | 73 | confirm-required: 73, invalid-time: 12, unsupported-rule: 4, invalid-field: 1 |
| recurrence:replace | all_series | 99 | 89 | 12 | 89% ⚠ | 66 | confirm-required: 66, invalid-time: 11 |
| summary+start | this | 167 | 83 | 68 | 15% | 0 | invalid-time: 15 |
| summary+start | this_and_following | 167 | 94 | 68 | 26% | 5 | invalid-time: 15, confirm-required: 5, unsupported-rule: 4, invalid-field: 1, unsynced-rule: 1 |
| summary+start | all_series | 99 | 28 | 12 | 18% | 0 | invalid-time: 14, unsynced-rule: 2 |
| start:0001-01-01 | this | 167 | 167 | 68 | 100% ⚠ | 0 | invalid-time: 99 |
| start:0001-01-01 | this_and_following | 167 | 167 | 68 | 100% ⚠ | 0 | invalid-time: 98, invalid-field: 1 |
| start:0001-01-01 | all_series | 99 | 99 | 12 | 100% ⚠ | 0 | invalid-time: 87 |
| start:9999-12-31 | this | 167 | 156 | 68 | 89% ⚠ | 0 | invalid-time: 88 |
| start:9999-12-31 | this_and_following | 167 | 99 | 68 | 31% | 5 | invalid-time: 19, confirm-required: 5, unsupported-rule: 4, unsynced-rule: 2, invalid-field: 1 |
| start:9999-12-31 | all_series | 99 | 35 | 12 | 26% | 0 | invalid-time: 18, unsynced-rule: 5 |
| recurrence:interval=1000000 | this | 167 | 167 | 68 | 100% ⚠ | 0 | invalid-scope: 95, invalid-rule: 4 |
| recurrence:interval=1000000 | this_and_following | 167 | 167 | 68 | 100% ⚠ | 0 | invalid-rule: 92, unsupported-rule: 6, invalid-field: 1 |
| recurrence:interval=1000000 | all_series | 99 | 99 | 12 | 100% ⚠ | 0 | invalid-rule: 82, unsupported-rule: 5 |
| recurrence:interval=1001 | this | 167 | 167 | 68 | 100% ⚠ | 0 | invalid-scope: 95, invalid-rule: 4 |
| recurrence:interval=1001 | this_and_following | 167 | 106 | 68 | 38% | 9 | invalid-time: 12, invalid-rule: 10, confirm-required: 9, unsupported-rule: 6, invalid-field: 1 |
| recurrence:interval=1001 | all_series | 99 | 50 | 12 | 44% | 13 | confirm-required: 13, invalid-time: 11, invalid-rule: 9, unsupported-rule: 5 |
| recurrence:frequency+start+end | this | 167 | 163 | 68 | 96% ⚠ | 0 | invalid-scope: 95 |
| recurrence:frequency+start+end | this_and_following | 167 | 107 | 68 | 39% | 13 | invalid-time: 18, confirm-required: 13, unsupported-rule: 6, invalid-field: 1, unsynced-rule: 1 |
| recurrence:frequency+start+end | all_series | 99 | 43 | 12 | 36% | 19 | confirm-required: 19, invalid-time: 5, unsupported-rule: 5, unsynced-rule: 2 |
| recurrence:frequency+timeZone | this | 167 | 163 | 68 | 96% ⚠ | 0 | invalid-scope: 95 |
| recurrence:frequency+timeZone | this_and_following | 167 | 87 | 68 | 19% | 5 | invalid-time: 10, confirm-required: 5, unsupported-rule: 3, invalid-field: 1 |
| recurrence:frequency+timeZone | all_series | 99 | 26 | 12 | 16% | 0 | invalid-time: 11, unsupported-rule: 3 |
| start+end:через полночь | this | 167 | 83 | 68 | 15% | 0 | invalid-time: 15 |
| start+end:через полночь | this_and_following | 167 | 86 | 68 | 18% | 5 | invalid-time: 6, confirm-required: 5, unsupported-rule: 4, unsynced-rule: 2, invalid-field: 1 |
| start+end:через полночь | all_series | 99 | 22 | 12 | 11% | 0 | unsynced-rule: 5, invalid-time: 5 |

Подозрительные пары:

- allDay:true × this — 93%
- allDay:true+start+end × this — 93%
- recurrence:count × this — 100%
- recurrence:count=null × this — 100%
- recurrence:frequency × this — 96%
- recurrence:frequency+start+end × this — 96%
- recurrence:frequency+timeZone × this — 96%
- recurrence:interval=1000000 × all_series — 100%
- recurrence:interval=1000000 × this — 100%
- recurrence:interval=1000000 × this_and_following — 100%
- recurrence:interval=1001 × this — 100%
- recurrence:replace × all_series — 89%
- recurrence:replace × this — 96%
- recurrence:replace × this_and_following — 91%
- recurrence:until × this — 100%
- recurrence:until=null × this — 100%
- start:0001-01-01 × all_series — 100%
- start:0001-01-01 × this — 100%
- start:0001-01-01 × this_and_following — 100%
- start:9999-12-31 × this — 89%

Разбор подозрительных пар (отказы разобраны поимённо; ложная строгость среди них одна — предел шага
повтора, П12, и она названа нарушениями `over-strict`):

- `status × *` — в языке правки (`FieldPatch`, src/ical/plan.ts) поля `status` нет вовсе. Патч оставлен в
  корпусе нарочно: он показывает, что на неизвестное поле приходит типизированный `invalid-field`, а не
  голая ошибка. Это расхождение корпуса задания с языком правки, а не дефект.
- `allDay:true × this` и `allDay:true+start+end × this` — «весь день» у одной встречи серии запрещён
  формой времени (RFC 5545 §3.8.4.4): у переопределения форма обязана совпадать с серией. Отказ
  `invalid-time` с внятным hint «передайте scope: all_series».
- `recurrence:* × this` (в том числе патчи, называющие повтор вместе со временем и поясом, и патч с
  `interval: 1000000`) — повтор у одной встречи не меняется по смыслу операции; отказ приходит с кодом
  `invalid-scope` и подсказкой про all_series и this_and_following. Код говорит ровно то, что есть: поле
  известное, а в названной области не меняется.
- `start:0001-01-01 × *` — отказывает весь столбец, и отказывает по самому патчу: RFC 5545 §3.3.4 пишет
  год ровно четырьмя цифрами, а ical.js дополнять его не умеет — год 1 вышел бы строкой `1-01-01`,
  которой не прочтёт ни сервер, ни следующее чтение объекта. Отказ `invalid-time`: «год 1 вне 1000–9999»
  с подсказкой, какие годы записываются. Это край значения, взятый корпусом нарочно, а не строгость к
  обычной правке: единственное, что теряется, — годы с 1-го по 999-й, которых в календаре не бывает.
- `start:9999-12-31 × this` — отказ приходит не на начало, а на КОНЕЦ: 23:00 31 декабря 9999 года плюс
  прежняя длительность — это уже 10000-й год, и записать его нечем. Там, где длительность в сутки
  укладывается (получасовые затравки), правка проходит, и встреча действительно встаёт у края календаря:
  обход её видит и сверяет (`World.beyond`), пропавшей не считает.
- `recurrence:interval=1001 × this_and_following` и `× all_series` — тот же отказ `invalid-rule` по пределу
  шага, но здесь он законен не везде: у бесконечной серии шаг решает, куда уйдёт вторая встреча, а у
  конечной число встреч от шага не зависит вовсе. Отказы на конечных сериях обход называет нарушениями
  (`over-strict`, причина П12), и в долю этой пары они входят наравне с законными.
- `recurrence:interval=1000000 × this_and_following` и `× all_series` — отказ `invalid-rule`: шаг повтора
  больше 1000. Разворот такого правила уходит за пределы календаря — ни расписания, ни конца серии не
  проверить, а прежде он и не возвращал управления вовсе (нарушения вида `timeout` прошлого круга).
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
- Встречу, которую патч уводит за горизонт разворота (край года — 9999), обход берёт отдельно от окна:
  у неё свой компонент, и она попадает в `World.beyond` по перечню переопределений объекта, а не
  разворотом правила (развернуть бесконечное правило до 9999 года — сотни тысяч шагов, и случай не
  уложился бы в сторожевое время). Смысл области правки её касается наравне с прочими, а признаки
  горизонта («серия кончилась», «упор сработал») — нет: к окну она отношения не имеет. Слот, уведённый
  за горизонт САМИМ ПРАВИЛОМ, по-прежнему невидим — но таких патчей в корпусе нет.
- Скрытый след, которого разрез лишает прячущего его EXDATE (затравка `hidden-exdate-tail-moscow`):
  усечение снимает EXDATE вместе с хвостом правила, и RECURRENCE-ID следа оказывается мимо всех слотов
  усечённой серии. Нарушением это не считается — встречи по его адресу как не было, так и нет, сам след
  остаётся в объекте и по-прежнему адресуется, а предохранитель такой исход называет прямо («усечение серии
  прячет переопределение за её конец»). Обход сверяет здесь другое: что след не стал встречей и не пропал
  молча.
- Случай, оборванный по сторожевому времени (1500 мс), дальше не проверяется вовсе: что бы
  планировщик ни построил, до предохранителя и записи дело не дошло. Нарушение вида `timeout` говорит
  только одно — управление не вернулось.

## Как перезапустить

```sh
npm run test:oracle
```

Обход детерминирован: тот же список нарушений при повторе. Коды отказов и их смысл — в
[refusals.md](./refusals.md), сами нарушения с готовым воспроизведением — в
[findings.json](./findings.json).
