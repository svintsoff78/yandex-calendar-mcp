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
- из них: планов построено 3443, пустых планов 513, отказов 4998;
- горизонт разворота: 2026-01-01 … 2029-01-01, упор 400 встреч, проба «за концом» — 2028-06-01.

## Нарушения по видам

| вид | сколько | что значит |
| --- | ---: | --- |
| disagreement | 25 | планировщик построил план, предохранитель его отверг |
| semantics | 428 | записанный результат разошёлся со смыслом scope или сервер не принял запись |
| bare-error | 0 | планировщик бросил голую ошибку вместо типизированного отказа |
| **всего** | **453** | |

## Первопричины

Различных первопричин: 6 (предел задания — 12).

### П3. Напоминание письмом создаётся без адресата — 226 нарушений

Патч reminders приводит список напоминаний к названному: совпавшие по способу и сдвигу VALARM остаются дословно, лишние снимаются, недостающие создаются заново. У создаваемого напоминания письмом (ACTION:EMAIL) есть только ACTION, TRIGGER и DESCRIPTION — ни одного ATTENDEE. RFC 5545 §3.6.6 требует у такого VALARM хотя бы одного адресата: письму нужен получатель. Так правка сдвига письма (30 минут → 20) снимает прежнее напоминание вместе с его ATTENDEE, ATTACH, SUMMARY и X-свойствами и ставит вместо него письмо в никуда — это видно на затравке email-alarm-moscow, а само напоминание без адресата появляется на любой затравке.

- затравки: single-moscow, single-berlin, weekly-count-moscow, weekly-newyork, until-berlin, infinite-weekly-moscow, infinite-daily-berlin, rdate-only-moscow, rdate-period-moscow, slot-override-moscow, moved-override-berlin, moved-before-start-moscow, hidden-under-exdate-moscow, hidden-past-end-moscow, detached-on-slot-date, detached-at-moved-start, all-day-weekly, exdate-middle-berlin, rich-moscow, wkst-berlin, bysetpos-moscow, floating-daily, duration-master, dtend-with-duration-moscow, zero-length-moscow, end-before-start-moscow, date-start-time-end-moscow, exdate-off-slot-moscow, email-alarm-moscow;
- патчи: reminders, reminders +confirm;
- области: this, this_and_following, all_series;
- где чинить: src/ical/patch.ts, newAlarm и syncAlarms: у ACTION:EMAIL обязан быть ATTENDEE (взять адресата у прежнего напоминания письмом, у ORGANIZER или у владельца календаря) — либо патч reminders с методом email должен отказывать внятно, пока адресата назвать неоткуда.

### П4. Правка тиражирует испорченное время объекта, и сервер её не принимает — 134 нарушений

У объектов, записанных чужими клиентами, время основного компонента бывает испорчено: DTEND вместе с DURATION, DTEND равен DTSTART или раньше него, DTSTART в форме DATE при DTEND со временем. Правка такой объект не разбирает: она копирует испорченное время в новое переопределение (scope this) или в продолжение разреза, и порчи в объекте становится больше, чем было. Строгий режим подставного сервера отвечает на такую запись 400 (О12а: новых нарушений сверх прежних быть не должно), и правка обрывается без объяснения — пользователь видит ошибку сервера вместо внятного отказа.

- затравки: dtend-with-duration-moscow, zero-length-moscow, end-before-start-moscow, date-start-time-end-moscow;
- патчи: start, summary+start, summary, description, location, participants, reminders, timeZone, recurrence:frequency, recurrence:until, recurrence:count=null, recurrence:replace +confirm, recurrence:count, allDay:true, allDay:true+start+end;
- области: this_and_following, all_series, this;
- где чинить: src/ical/edit.ts и src/ical/patch.ts: перед правкой проверять время того компонента, с которого снимается копия. Либо отказывать типизированным invalid-time с указанием, что объект испорчен другим клиентом, либо писать исправленное время — но не размножать порчу молча.

### П5. Правка множит встречи нулевой и отрицательной длительности — 39 нарушений

Там, где запись всё-таки проходит (патч повтора, смена пояса, «весь день»), встреч с концом не позже начала после правки становится больше, чем было в затравке: правило растягивается или пересобирается, и каждая новая позиция наследует испорченную длительность основного компонента. Отказа нет, предупреждения нет — вырожденные встречи просто размножаются.

- затравки: zero-length-moscow, end-before-start-moscow, date-start-time-end-moscow;
- патчи: recurrence:until, recurrence:count=null, recurrence:replace +confirm, timeZone, allDay:true;
- области: this_and_following, all_series;
- где чинить: src/ical/edit.ts: правка повтора у объекта с испорченным временем обязана либо отказать, либо привести конец к годному значению. Сейчас проверка «конец позже начала» делается только для времени из патча (patch.ts, TimePlan), а прежнее время объекта не проверяется вовсе.

### П6. Конец встречи читается из DTEND, а копируется из DURATION — 25 нарушений

Когда у компонента разом DTEND и DURATION, выдача берёт конец из DTEND (встреча 10:00–11:00), а правка, снимая копию под переопределение, переносит только DURATION (PT30M). Встреча молча укорачивается вдвое, хотя патч времени не называл. Предохранитель это ловит (time-changed) и план отвергает — то есть планировщик и предохранитель расходятся между собой, и правка падает внутренней ошибкой. То же на объекте с DTSTART в форме DATE и DTEND со временем: копия сохраняет обе строки, и конец встречи меняется с полуночи на 11:00.

- затравки: dtend-with-duration-moscow, date-start-time-end-moscow;
- патчи: summary, description, location, participants, reminders;
- области: this;
- где чинить: src/ical/patch.ts, снятие копии компонента под переопределение: копировать надо тот конец, который показан в выдаче (instances.ts), а не обе записи разом. Либо отказывать на объекте, где конец задан дважды.

### П7. На границе this_and_following перенесённая встреча теряет своё время — 17 нарушений

Когда границей области названа перенесённая встреча (своё DTSTART мимо слота), патч времени серии применяется и к ней: start двигает её на время суток из патча, end переписывает ей конец — 75-минутная встреча становится 105-минутной, а перенос на 15:00 съезжает на 14:30. У встречи со своим компонентом время своё (О7): сдвигаются слоты, а не переносы. Ни в removed, ни в пояснениях плана эта встреча не названа — пользователю про сдвиг не сказано. При all_series тот же патч перенесённые встречи не трогает, то есть дело именно в обработке границы.

- затравки: moved-override-berlin, moved-before-start-moscow, detached-at-moved-start;
- патчи: start, end, start+end, allDay:false+start+end, summary+start, start +confirm, end +confirm, start+end +confirm, allDay:false+start+end +confirm, summary+start +confirm;
- области: this_and_following;
- где чинить: src/ical/edit.ts, ветка this_and_following: встреча на самой границе обрабатывается как слот, даже когда у неё свой компонент с собственным DTSTART. Либо оставлять ей своё время (как это делает all_series), либо называть её в notices.

### П8. На объекте с испорченным временем слоты встают не туда, куда назвал патч — 12 нарушений

Патч start и смена пояса на объекте с двумя концами (DTEND и DURATION) или со смешанными формами дают слоты, которых оракул не ждёт: момент начала области после смены пояса не сохраняется, а названное патчем время слота в выдаче не находится. Причина та же, что у П6: выдача и правка берут конец встречи из разных свойств, и после записи длительность и момент расходятся с посчитанным ожиданием.

- затравки: dtend-with-duration-moscow, date-start-time-end-moscow;
- патчи: start, timeZone, summary+start;
- области: this, this_and_following, all_series;
- где чинить: src/ical/patch.ts и src/ical/instances.ts: конец встречи должен читаться и писаться из одного и того же свойства.

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
| summary | this | 146 | 59 | 59 | 0% | 0 | — |
| summary | this_and_following | 146 | 69 | 59 | 11% | 5 | confirm-required: 5, unsupported-rule: 4, invalid-field: 1 |
| summary | all_series | 87 | 10 | 10 | 0% | 0 | — |
| description | this | 146 | 59 | 59 | 0% | 0 | — |
| description | this_and_following | 146 | 69 | 59 | 11% | 5 | confirm-required: 5, unsupported-rule: 4, invalid-field: 1 |
| description | all_series | 87 | 10 | 10 | 0% | 0 | — |
| location | this | 146 | 59 | 59 | 0% | 0 | — |
| location | this_and_following | 146 | 69 | 59 | 11% | 5 | confirm-required: 5, unsupported-rule: 4, invalid-field: 1 |
| location | all_series | 87 | 10 | 10 | 0% | 0 | — |
| status | this | 146 | 146 | 59 | 100% ⚠ | 0 | invalid-field: 87 |
| status | this_and_following | 146 | 146 | 59 | 100% ⚠ | 0 | invalid-field: 87 |
| status | all_series | 87 | 87 | 10 | 100% ⚠ | 0 | invalid-field: 77 |
| participants | this | 146 | 59 | 59 | 0% | 0 | — |
| participants | this_and_following | 146 | 69 | 59 | 11% | 5 | confirm-required: 5, unsupported-rule: 4, invalid-field: 1 |
| participants | all_series | 87 | 10 | 10 | 0% | 0 | — |
| reminders | this | 146 | 59 | 59 | 0% | 0 | — |
| reminders | this_and_following | 146 | 69 | 59 | 11% | 5 | confirm-required: 5, unsupported-rule: 4, invalid-field: 1 |
| reminders | all_series | 87 | 10 | 10 | 0% | 0 | — |
| start | this | 146 | 71 | 59 | 14% | 0 | invalid-time: 12 |
| start | this_and_following | 146 | 82 | 59 | 26% | 5 | invalid-time: 12, confirm-required: 5, unsupported-rule: 4, invalid-field: 1, unsynced-rule: 1 |
| start | all_series | 87 | 23 | 10 | 17% | 0 | invalid-time: 11, unsynced-rule: 2 |
| end | this | 146 | 75 | 59 | 18% | 0 | invalid-time: 16 |
| end | this_and_following | 146 | 75 | 59 | 18% | 5 | invalid-time: 6, confirm-required: 5, unsupported-rule: 4, invalid-field: 1 |
| end | all_series | 87 | 15 | 10 | 6% | 0 | invalid-time: 5 |
| start+end | this | 146 | 65 | 59 | 7% | 0 | invalid-time: 6 |
| start+end | this_and_following | 146 | 76 | 59 | 20% | 5 | invalid-time: 6, confirm-required: 5, unsupported-rule: 4, invalid-field: 1, unsynced-rule: 1 |
| start+end | all_series | 87 | 17 | 10 | 9% | 0 | invalid-time: 5, unsynced-rule: 2 |
| timeZone | this | 146 | 65 | 59 | 7% | 0 | invalid-time: 6 |
| timeZone | this_and_following | 146 | 73 | 59 | 16% | 5 | invalid-time: 6, confirm-required: 5, unsupported-rule: 2, invalid-field: 1 |
| timeZone | all_series | 87 | 16 | 10 | 8% | 0 | invalid-time: 6 |
| allDay:true | this | 146 | 136 | 59 | 89% ⚠ | 0 | invalid-time: 77 |
| allDay:true | this_and_following | 146 | 82 | 59 | 26% | 4 | invalid-time: 14, confirm-required: 4, unsupported-rule: 4, invalid-field: 1 |
| allDay:true | all_series | 87 | 34 | 10 | 31% | 0 | invalid-time: 24 |
| allDay:false | this | 146 | 65 | 59 | 7% | 0 | invalid-time: 6 |
| allDay:false | this_and_following | 146 | 66 | 59 | 8% | 0 | invalid-time: 6, invalid-field: 1 |
| allDay:false | all_series | 87 | 15 | 10 | 6% | 0 | invalid-time: 5 |
| allDay:true+start+end | this | 146 | 136 | 59 | 89% ⚠ | 0 | invalid-time: 77 |
| allDay:true+start+end | this_and_following | 146 | 82 | 59 | 26% | 4 | invalid-time: 14, confirm-required: 4, unsupported-rule: 4, invalid-field: 1 |
| allDay:true+start+end | all_series | 87 | 34 | 10 | 31% | 0 | invalid-time: 24 |
| allDay:false+start+end | this | 146 | 65 | 59 | 7% | 0 | invalid-time: 6 |
| allDay:false+start+end | this_and_following | 146 | 69 | 59 | 11% | 4 | confirm-required: 4, unsupported-rule: 4, invalid-field: 1, unsynced-rule: 1 |
| allDay:false+start+end | all_series | 87 | 12 | 10 | 3% | 0 | unsynced-rule: 2 |
| recurrence:frequency | this | 146 | 142 | 59 | 95% ⚠ | 0 | invalid-scope: 83 |
| recurrence:frequency | this_and_following | 146 | 71 | 59 | 14% | 5 | unsupported-rule: 6, confirm-required: 5, invalid-field: 1 |
| recurrence:frequency | all_series | 87 | 15 | 10 | 6% | 0 | unsupported-rule: 5 |
| recurrence:count | this | 146 | 146 | 59 | 100% ⚠ | 0 | invalid-scope: 83, invalid-rule: 4 |
| recurrence:count | this_and_following | 146 | 78 | 59 | 22% | 5 | invalid-rule: 7, confirm-required: 5, unsupported-rule: 5, split-mismatch: 1, invalid-field: 1 |
| recurrence:count | all_series | 87 | 25 | 10 | 19% | 3 | invalid-rule: 7, unsupported-rule: 5, confirm-required: 3 |
| recurrence:until | this | 146 | 146 | 59 | 100% ⚠ | 0 | invalid-scope: 83, invalid-rule: 4 |
| recurrence:until | this_and_following | 146 | 83 | 59 | 28% | 6 | invalid-rule: 12, confirm-required: 6, unsupported-rule: 3, split-mismatch: 2, invalid-field: 1 |
| recurrence:until | all_series | 87 | 24 | 10 | 18% | 2 | invalid-rule: 7, unsupported-rule: 5, confirm-required: 2 |
| recurrence:count=null | this | 146 | 146 | 59 | 100% ⚠ | 0 | invalid-scope: 83, invalid-rule: 4 |
| recurrence:count=null | this_and_following | 146 | 81 | 59 | 25% | 6 | invalid-rule: 7, confirm-required: 6, unsupported-rule: 6, split-mismatch: 2, invalid-field: 1 |
| recurrence:count=null | all_series | 87 | 24 | 10 | 18% | 2 | invalid-rule: 7, unsupported-rule: 5, confirm-required: 2 |
| recurrence:until=null | this | 146 | 146 | 59 | 100% ⚠ | 0 | invalid-scope: 83, invalid-rule: 4 |
| recurrence:until=null | this_and_following | 146 | 67 | 59 | 9% | 0 | invalid-rule: 7, invalid-field: 1 |
| recurrence:until=null | all_series | 87 | 17 | 10 | 9% | 0 | invalid-rule: 7 |
| recurrence:replace | this | 146 | 142 | 59 | 95% ⚠ | 0 | invalid-scope: 83 |
| recurrence:replace | this_and_following | 146 | 137 | 59 | 90% ⚠ | 72 | confirm-required: 72, unsupported-rule: 4, split-mismatch: 1, invalid-field: 1 |
| recurrence:replace | all_series | 87 | 77 | 10 | 87% ⚠ | 67 | confirm-required: 67 |
| summary+start | this | 146 | 71 | 59 | 14% | 0 | invalid-time: 12 |
| summary+start | this_and_following | 146 | 82 | 59 | 26% | 5 | invalid-time: 12, confirm-required: 5, unsupported-rule: 4, invalid-field: 1, unsynced-rule: 1 |
| summary+start | all_series | 87 | 23 | 10 | 17% | 0 | invalid-time: 11, unsynced-rule: 2 |

Подозрительные пары:

- allDay:true × this — 89%
- allDay:true+start+end × this — 89%
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
