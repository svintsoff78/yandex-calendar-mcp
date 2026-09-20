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
4. **Сторожевое время и память.** Каждый случай выполняется в отдельном потоке (`isolate.ts`) под
   пределом 1500 мс и пределом кучи: планировщик и предохранитель работают синхронно, и без
   потока зацикленный разворот правила или разогнанная куча роняли бы весь прогон — не нарушением, а
   падением процесса без отчёта. Теперь это нарушение вида `timeout`, и обход идёт дальше.

## Цифры прогона

- зерно генератора случайных чисел: **20260920** (выбор адресов сверх предела; повтор обхода даёт тот же список);
- затравок: 33, патчей: 27, областей правки: 3;
- случаев: 12124 (update 11691, delete 433);
- из них: планов построено 4019, пустых планов 590, отказов 7515;
- горизонт разворота: 2026-01-01 … 2029-01-01, упор 400 встреч, проба «за концом» — 2028-06-01.

## Нарушения по видам

| вид | сколько | что значит |
| --- | ---: | --- |
| disagreement | 0 | планировщик построил план, предохранитель его отверг |
| semantics | 0 | записанный результат разошёлся со смыслом scope или сервер не принял запись |
| bare-error | 0 | планировщик бросил голую ошибку вместо типизированного отказа |
| bare-guard | 0 | предохранитель бросил голую ошибку библиотеки вместо GuardError |
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
| delete | this | 156 | 60 | 60 | 0% | 0 | — |
| delete | this_and_following | 156 | 69 | 60 | 9% | 2 | unsupported-rule: 4, invalid-field: 3, confirm-required: 2 |
| delete | all_series | 93 | 9 | 9 | 0% | 0 | — |
| summary | this | 156 | 75 | 63 | 13% | 0 | invalid-time: 12 |
| summary | this_and_following | 156 | 81 | 63 | 19% | 5 | invalid-time: 8, confirm-required: 5, unsupported-rule: 4, invalid-field: 1 |
| summary | all_series | 93 | 11 | 11 | 0% | 0 | — |
| description | this | 156 | 75 | 63 | 13% | 0 | invalid-time: 12 |
| description | this_and_following | 156 | 81 | 63 | 19% | 5 | invalid-time: 8, confirm-required: 5, unsupported-rule: 4, invalid-field: 1 |
| description | all_series | 93 | 11 | 11 | 0% | 0 | — |
| location | this | 156 | 75 | 63 | 13% | 0 | invalid-time: 12 |
| location | this_and_following | 156 | 81 | 63 | 19% | 5 | invalid-time: 8, confirm-required: 5, unsupported-rule: 4, invalid-field: 1 |
| location | all_series | 93 | 11 | 11 | 0% | 0 | — |
| status | this | 156 | 156 | 63 | 100% ⚠ | 0 | invalid-field: 93 |
| status | this_and_following | 156 | 156 | 63 | 100% ⚠ | 0 | invalid-field: 93 |
| status | all_series | 93 | 93 | 11 | 100% ⚠ | 0 | invalid-field: 82 |
| participants | this | 156 | 75 | 63 | 13% | 0 | invalid-time: 12 |
| participants | this_and_following | 156 | 81 | 63 | 19% | 5 | invalid-time: 8, confirm-required: 5, unsupported-rule: 4, invalid-field: 1 |
| participants | all_series | 93 | 11 | 11 | 0% | 0 | — |
| reminders | this | 156 | 75 | 63 | 13% | 0 | invalid-time: 12 |
| reminders | this_and_following | 156 | 81 | 63 | 19% | 5 | invalid-time: 8, confirm-required: 5, unsupported-rule: 4, invalid-field: 1 |
| reminders | all_series | 93 | 11 | 11 | 0% | 0 | — |
| start | this | 156 | 78 | 63 | 16% | 0 | invalid-time: 15 |
| start | this_and_following | 156 | 89 | 63 | 28% | 5 | invalid-time: 15, confirm-required: 5, unsupported-rule: 4, invalid-field: 1, unsynced-rule: 1 |
| start | all_series | 93 | 27 | 11 | 20% | 0 | invalid-time: 14, unsynced-rule: 2 |
| end | this | 156 | 90 | 63 | 29% | 0 | invalid-time: 27 |
| end | this_and_following | 156 | 79 | 63 | 17% | 5 | invalid-time: 6, confirm-required: 5, unsupported-rule: 4, invalid-field: 1 |
| end | all_series | 93 | 16 | 11 | 6% | 0 | invalid-time: 5 |
| start+end | this | 156 | 78 | 63 | 16% | 0 | invalid-time: 15 |
| start+end | this_and_following | 156 | 80 | 63 | 18% | 5 | invalid-time: 6, confirm-required: 5, unsupported-rule: 4, invalid-field: 1, unsynced-rule: 1 |
| start+end | all_series | 93 | 18 | 11 | 9% | 0 | invalid-time: 5, unsynced-rule: 2 |
| timeZone | this | 156 | 75 | 63 | 13% | 0 | invalid-time: 12 |
| timeZone | this_and_following | 156 | 81 | 63 | 19% | 5 | invalid-time: 10, confirm-required: 5, unsupported-rule: 2, invalid-field: 1 |
| timeZone | all_series | 93 | 22 | 11 | 13% | 0 | invalid-time: 11 |
| allDay:true | this | 156 | 149 | 63 | 92% ⚠ | 0 | invalid-time: 86 |
| allDay:true | this_and_following | 156 | 87 | 63 | 26% | 4 | invalid-time: 15, confirm-required: 4, unsupported-rule: 4, invalid-field: 1 |
| allDay:true | all_series | 93 | 37 | 11 | 32% | 0 | invalid-time: 26 |
| allDay:false | this | 156 | 69 | 63 | 6% | 0 | invalid-time: 6 |
| allDay:false | this_and_following | 156 | 70 | 63 | 8% | 0 | invalid-time: 6, invalid-field: 1 |
| allDay:false | all_series | 93 | 16 | 11 | 6% | 0 | invalid-time: 5 |
| allDay:true+start+end | this | 156 | 149 | 63 | 92% ⚠ | 0 | invalid-time: 86 |
| allDay:true+start+end | this_and_following | 156 | 86 | 63 | 25% | 4 | invalid-time: 14, confirm-required: 4, unsupported-rule: 4, invalid-field: 1 |
| allDay:true+start+end | all_series | 93 | 35 | 11 | 29% | 0 | invalid-time: 24 |
| allDay:false+start+end | this | 156 | 78 | 63 | 16% | 0 | invalid-time: 15 |
| allDay:false+start+end | this_and_following | 156 | 73 | 63 | 11% | 4 | confirm-required: 4, unsupported-rule: 4, invalid-field: 1, unsynced-rule: 1 |
| allDay:false+start+end | all_series | 93 | 13 | 11 | 2% | 0 | unsynced-rule: 2 |
| recurrence:frequency | this | 156 | 152 | 63 | 96% ⚠ | 0 | invalid-scope: 89 |
| recurrence:frequency | this_and_following | 156 | 87 | 63 | 26% | 5 | invalid-time: 12, unsupported-rule: 6, confirm-required: 5, invalid-field: 1 |
| recurrence:frequency | all_series | 93 | 27 | 11 | 20% | 0 | invalid-time: 11, unsupported-rule: 5 |
| recurrence:count | this | 156 | 156 | 63 | 100% ⚠ | 0 | invalid-scope: 89, invalid-rule: 4 |
| recurrence:count | this_and_following | 156 | 90 | 63 | 29% | 6 | invalid-time: 8, invalid-rule: 7, confirm-required: 6, unsupported-rule: 5, invalid-field: 1 |
| recurrence:count | all_series | 93 | 37 | 11 | 32% | 3 | invalid-time: 11, invalid-rule: 7, unsupported-rule: 5, confirm-required: 3 |
| recurrence:until | this | 156 | 156 | 63 | 100% ⚠ | 0 | invalid-scope: 89, invalid-rule: 4 |
| recurrence:until | this_and_following | 156 | 100 | 63 | 40% | 8 | invalid-rule: 13, invalid-time: 12, confirm-required: 8, unsupported-rule: 3, invalid-field: 1 |
| recurrence:until | all_series | 93 | 36 | 11 | 30% | 2 | invalid-time: 11, invalid-rule: 7, unsupported-rule: 5, confirm-required: 2 |
| recurrence:count=null | this | 156 | 156 | 63 | 100% ⚠ | 0 | invalid-scope: 89, invalid-rule: 4 |
| recurrence:count=null | this_and_following | 156 | 97 | 63 | 37% | 8 | invalid-time: 12, confirm-required: 8, invalid-rule: 7, unsupported-rule: 6, invalid-field: 1 |
| recurrence:count=null | all_series | 93 | 36 | 11 | 30% | 2 | invalid-time: 11, invalid-rule: 7, unsupported-rule: 5, confirm-required: 2 |
| recurrence:until=null | this | 156 | 156 | 63 | 100% ⚠ | 0 | invalid-scope: 89, invalid-rule: 4 |
| recurrence:until=null | this_and_following | 156 | 71 | 63 | 9% | 0 | invalid-rule: 7, invalid-field: 1 |
| recurrence:until=null | all_series | 93 | 18 | 11 | 9% | 0 | invalid-rule: 7 |
| recurrence:replace | this | 156 | 152 | 63 | 96% ⚠ | 0 | invalid-scope: 89 |
| recurrence:replace | this_and_following | 156 | 147 | 63 | 90% ⚠ | 67 | confirm-required: 67, invalid-time: 12, unsupported-rule: 4, invalid-field: 1 |
| recurrence:replace | all_series | 93 | 83 | 11 | 88% ⚠ | 61 | confirm-required: 61, invalid-time: 11 |
| summary+start | this | 156 | 78 | 63 | 16% | 0 | invalid-time: 15 |
| summary+start | this_and_following | 156 | 89 | 63 | 28% | 5 | invalid-time: 15, confirm-required: 5, unsupported-rule: 4, invalid-field: 1, unsynced-rule: 1 |
| summary+start | all_series | 93 | 27 | 11 | 20% | 0 | invalid-time: 14, unsynced-rule: 2 |
| start:0001-01-01 | this | 156 | 156 | 63 | 100% ⚠ | 0 | invalid-time: 93 |
| start:0001-01-01 | this_and_following | 156 | 156 | 63 | 100% ⚠ | 0 | invalid-time: 92, invalid-field: 1 |
| start:0001-01-01 | all_series | 93 | 93 | 11 | 100% ⚠ | 0 | invalid-time: 82 |
| start:9999-12-31 | this | 156 | 145 | 63 | 88% ⚠ | 0 | invalid-time: 82 |
| start:9999-12-31 | this_and_following | 156 | 94 | 63 | 33% | 5 | invalid-time: 19, confirm-required: 5, unsupported-rule: 4, unsynced-rule: 2, invalid-field: 1 |
| start:9999-12-31 | all_series | 93 | 34 | 11 | 28% | 0 | invalid-time: 18, unsynced-rule: 5 |
| recurrence:interval=1000000 | this | 156 | 156 | 63 | 100% ⚠ | 0 | invalid-scope: 89, invalid-rule: 4 |
| recurrence:interval=1000000 | this_and_following | 156 | 156 | 63 | 100% ⚠ | 0 | invalid-rule: 92, invalid-field: 1 |
| recurrence:interval=1000000 | all_series | 93 | 93 | 11 | 100% ⚠ | 0 | invalid-rule: 82 |
| recurrence:frequency+start+end | this | 156 | 152 | 63 | 96% ⚠ | 0 | invalid-scope: 89 |
| recurrence:frequency+start+end | this_and_following | 156 | 99 | 63 | 39% | 13 | invalid-time: 15, confirm-required: 13, unsupported-rule: 6, invalid-field: 1, unsynced-rule: 1 |
| recurrence:frequency+start+end | all_series | 93 | 42 | 11 | 38% | 19 | confirm-required: 19, invalid-time: 5, unsupported-rule: 5, unsynced-rule: 2 |
| recurrence:frequency+timeZone | this | 156 | 152 | 63 | 96% ⚠ | 0 | invalid-scope: 89 |
| recurrence:frequency+timeZone | this_and_following | 156 | 82 | 63 | 20% | 5 | invalid-time: 10, confirm-required: 5, unsupported-rule: 3, invalid-field: 1 |
| recurrence:frequency+timeZone | all_series | 93 | 25 | 11 | 17% | 0 | invalid-time: 11, unsupported-rule: 3 |
| start+end:через полночь | this | 156 | 78 | 63 | 16% | 0 | invalid-time: 15 |
| start+end:через полночь | this_and_following | 156 | 81 | 63 | 19% | 5 | invalid-time: 6, confirm-required: 5, unsupported-rule: 4, unsynced-rule: 2, invalid-field: 1 |
| start+end:через полночь | all_series | 93 | 21 | 11 | 12% | 0 | unsynced-rule: 5, invalid-time: 5 |

Подозрительные пары:

- allDay:true × this — 92%
- allDay:true+start+end × this — 92%
- recurrence:count × this — 100%
- recurrence:count=null × this — 100%
- recurrence:frequency × this — 96%
- recurrence:frequency+start+end × this — 96%
- recurrence:frequency+timeZone × this — 96%
- recurrence:interval=1000000 × all_series — 100%
- recurrence:interval=1000000 × this — 100%
- recurrence:interval=1000000 × this_and_following — 100%
- recurrence:replace × all_series — 88%
- recurrence:replace × this — 96%
- recurrence:replace × this_and_following — 90%
- recurrence:until × this — 100%
- recurrence:until=null × this — 100%
- start:0001-01-01 × all_series — 100%
- start:0001-01-01 × this — 100%
- start:0001-01-01 × this_and_following — 100%
- start:9999-12-31 × this — 88%
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
