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
   посчитанным из смысла scope независимо от планировщика (`semantics.ts`).
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
- из них: планов построено 4285, пустых планов 536, отказов 7303;
- горизонт разворота: 2026-01-01 … 2029-01-01, упор 400 встреч, проба «за концом» — 2028-06-01.

## Нарушения по видам

| вид | сколько | что значит |
| --- | ---: | --- |
| disagreement | 86 | планировщик построил план, предохранитель его отверг |
| semantics | 37 | записанный результат разошёлся со смыслом scope или сервер не принял запись |
| bare-error | 0 | планировщик бросил голую ошибку вместо типизированного отказа |
| bare-guard | 3 | предохранитель бросил голую ошибку библиотеки вместо GuardError |
| timeout | 109 | случай не уложился в сторожевое время или исчерпал кучу |
| **всего** | **235** | |

## Первопричины

Различных первопричин: 4 (предел задания — 12).

### П9. Время у края года записывается строкой не по грамматике RFC 5545 — 95 нарушений

Патчи start:0001-01-01 и start:9999-12-31 называют время у края календаря. Правка его не проверяет и записывает как придётся:
- нижний край: `DTSTART:1-01-01T00:00:00` — год одной цифрой, разделители из ISO. RFC 5545 §3.3.5 требует `00010101T000000`, и обратно такое значение не читается: ical.js падает на нём уже при чтении свойства («Could not extract integer from ":0"»). Конец при этом сохраняет длительность не от того начала: `DTEND:19010101T003000` — 1901 год вместо первого;
- верхний край: 23:00 31.12.9999 плюс час длительности — это 10000 год, и он пишется как `DTEND;TZID=Europe/Moscow:1000-0-01T0:0:0`: год обрезан, месяц ноль, разряды не заполнены.
Дальше расходятся все трое. Предохранитель на части случаев бросает голую ошибку библиотеки (`bare-guard`), на части отвечает `series-too-long` «встречи не развернуть» или `meeting-lost` (`disagreement`); там, где запись проходит, встреча просто пропадает из выдачи. Пользователю в любом случае приходит не «так нельзя», а внутренний сбой.

- затравки: single-moscow, single-berlin, weekly-count-moscow, weekly-newyork, until-berlin, infinite-weekly-moscow, infinite-daily-berlin, rdate-only-moscow, rdate-period-moscow, slot-override-moscow, moved-override-berlin, moved-before-start-moscow, hidden-under-exdate-moscow, hidden-past-end-moscow, detached-on-slot-date, detached-at-moved-start, all-day-weekly, exdate-middle-berlin, rich-moscow, wkst-berlin, bysetpos-moscow, floating-daily, duration-master, exdate-off-slot-moscow, email-alarm-moscow, until-date-form-moscow, until-floating-berlin;
- патчи: start:9999-12-31, start:0001-01-01;
- области: this, this_and_following, all_series;
- где чинить: src/ical/values.ts и src/ical/patch.ts: год у записываемого значения обязан быть из четырёх цифр и лежать в 0001–9999 — значение за этими краями (в том числе полученное сложением длительности) не записывается, а даёт типизированный отказ invalid-time. Проверять надо и то, что пришло в патче, и то, что получилось после арифметики: конец 1901 года взялся именно из неё.

### П10. Огромный INTERVAL не возвращает управление: обход упирается в сторожевое время — 109 нарушений

Патч recurrence:{interval: 1000000} задаёт правило, которое разворачивается за пределы календаря. Ни планировщик, ни предохранитель предела на разворот не ставят: planUpdate на бесконечной серии занимает секунды, verifyPlan — десятки секунд, а на части затравок разворот съедает всю кучу и роняет процесс («JavaScript heap out of memory»). До сторожевого времени (isolate.ts) это было не нарушением, а падением прогона: оракул молчал, потому что до отчёта дело не доходило. В обиходе то же самое — не отказ, а зависший запрос и память сервера.

- затравки: weekly-count-moscow, weekly-newyork, until-berlin, infinite-weekly-moscow, infinite-daily-berlin, rdate-period-moscow, slot-override-moscow, moved-override-berlin, moved-before-start-moscow, hidden-under-exdate-moscow, hidden-past-end-moscow, detached-on-slot-date, detached-at-moved-start, all-day-weekly, exdate-middle-berlin, rich-moscow, floating-daily, duration-master, exdate-off-slot-moscow, email-alarm-moscow, until-date-form-moscow, until-floating-berlin;
- патчи: recurrence:interval=1000000, recurrence:interval=1000000 +confirm;
- области: this_and_following, all_series;
- где чинить: src/ical/edit.ts и src/ical/guard.ts: у разворота правила обязан быть предел (он уже есть у `lastSlotUpTo` — 200 000 шагов; у остальных проходов его нет), а правило, которое за него уходит, — давать отказ invalid-rule или until-too-far. Заодно стоит проверять сам INTERVAL: RFC 5545 §3.3.10 больших значений не запрещает, но у серии, первая встреча которой за пределом календаря, годных позиций всё равно нет.

### П1. Смена времени серии двигает RECURRENCE-ID переопределений вне слотов — 3 нарушения

Патчи start, end, timeZone и allDay:false+start+end сдвигают время всей серии (all_series) или её хвоста (this_and_following). Вместе со слотами планировщик сдвигает и RECURRENCE-ID переопределений, у которых слота нет вовсе, — оторванных (detached) и скрытых (hidden, за концом серии). Привязки к слоту у них нет, поэтому сдвиг ничего не сохраняет: сама встреча остаётся на своём времени (DTSTART не меняется), а её адрес меняется — тот адрес, по которому пользователь её удаляет и правит. Подставной сервер в строгом режиме отвечает 400: переопределение с новым ключом — новая сирота сверх прежних (О12а). Часть этих случаев видна только на патче, который называет повтор и время РАЗОМ (recurrence:frequency+start+end): поодиночке ни смена правила, ни смена времени на той же затравке сироты не создают — правило переносит ключи по-своему, время по-своему, и расходятся они только вместе.

- затравки: hidden-under-exdate-moscow;
- патчи: recurrence:frequency+start+end;
- области: this_and_following, all_series;
- где чинить: src/ical/edit.ts, ветка сдвига времени серии: переопределения ролей detached и hidden сдвигать вместе со слотами не нужно — у них свой адрес. Если сдвиг всё-таки нужен, он обязан попадать в plan.removed/notices, потому что адрес встречи меняется.

### П4. Правка тиражирует испорченное время объекта, и сервер её не принимает — 28 нарушений

У объектов, записанных чужими клиентами, время основного компонента бывает испорчено: DTEND вместе с DURATION, DTEND равен DTSTART или раньше него, DTSTART в форме DATE при DTEND со временем. Правка такой объект не разбирает: она копирует испорченное время в новое переопределение (scope this) или в продолжение разреза, и порчи в объекте становится больше, чем было. Строгий режим подставного сервера отвечает на такую запись 400 (О12а: новых нарушений сверх прежних быть не должно), и правка обрывается без объяснения — пользователь видит ошибку сервера вместо внятного отказа.
То же и с испорченной формой UNTIL (RFC 5545 §3.3.10: форма UNTIL обязана совпадать с формой DTSTART). У затравок until-date-form-moscow (UNTIL в форме DATE) и until-floating-berlin (UNTIL без Z при DTSTART с TZID) разрез уносит правило дословно в ПРОДОЛЖЕНИЕ — объект с новым UID, у которого прежних версий нет, и негодная форма в нём новая, а не унаследованная. Срывается любая правка хвоста, даже та, что времени не касается: summary, description, location, участники, напоминания.

- затравки: until-date-form-moscow, until-floating-berlin;
- патчи: summary, description, location, participants, reminders, end, recurrence:frequency;
- области: this_and_following;
- где чинить: src/ical/edit.ts и src/ical/patch.ts: перед правкой проверять время того компонента, с которого снимается копия, и правило, которое уходит в продолжение. Либо отказывать типизированным invalid-time (для правила — invalid-rule) с указанием, что объект испорчен другим клиентом, либо писать исправленное значение — UNTIL в форме по DTSTART считается из того же момента, — но не размножать порчу молча.

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
| status | this | 156 | 156 | 63 | 100% ⚠ | 0 | invalid-field: 81, invalid-time: 12 |
| status | this_and_following | 156 | 156 | 63 | 100% ⚠ | 0 | invalid-field: 85, invalid-time: 8 |
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
| end | this_and_following | 156 | 88 | 63 | 27% | 5 | invalid-time: 15, confirm-required: 5, unsupported-rule: 4, invalid-field: 1 |
| end | all_series | 93 | 25 | 11 | 17% | 0 | invalid-time: 14 |
| start+end | this | 156 | 78 | 63 | 16% | 0 | invalid-time: 15 |
| start+end | this_and_following | 156 | 83 | 63 | 22% | 5 | invalid-time: 9, confirm-required: 5, unsupported-rule: 4, invalid-field: 1, unsynced-rule: 1 |
| start+end | all_series | 93 | 21 | 11 | 12% | 0 | invalid-time: 8, unsynced-rule: 2 |
| timeZone | this | 156 | 75 | 63 | 13% | 0 | invalid-time: 12 |
| timeZone | this_and_following | 156 | 83 | 63 | 22% | 5 | invalid-time: 12, confirm-required: 5, unsupported-rule: 2, invalid-field: 1 |
| timeZone | all_series | 93 | 22 | 11 | 13% | 0 | invalid-time: 11 |
| allDay:true | this | 156 | 149 | 63 | 92% ⚠ | 0 | invalid-time: 86 |
| allDay:true | this_and_following | 156 | 98 | 63 | 38% | 4 | invalid-time: 26, confirm-required: 4, unsupported-rule: 4, invalid-field: 1 |
| allDay:true | all_series | 93 | 46 | 11 | 43% | 0 | invalid-time: 35 |
| allDay:false | this | 156 | 78 | 63 | 16% | 0 | invalid-time: 15 |
| allDay:false | this_and_following | 156 | 79 | 63 | 17% | 0 | invalid-time: 15, invalid-field: 1 |
| allDay:false | all_series | 93 | 25 | 11 | 17% | 0 | invalid-time: 14 |
| allDay:true+start+end | this | 156 | 149 | 63 | 92% ⚠ | 0 | invalid-time: 86 |
| allDay:true+start+end | this_and_following | 156 | 89 | 63 | 28% | 4 | invalid-time: 17, confirm-required: 4, unsupported-rule: 4, invalid-field: 1 |
| allDay:true+start+end | all_series | 93 | 38 | 11 | 33% | 0 | invalid-time: 27 |
| allDay:false+start+end | this | 156 | 78 | 63 | 16% | 0 | invalid-time: 15 |
| allDay:false+start+end | this_and_following | 156 | 76 | 63 | 14% | 4 | confirm-required: 4, unsupported-rule: 4, invalid-time: 3, invalid-field: 1, unsynced-rule: 1 |
| allDay:false+start+end | all_series | 93 | 16 | 11 | 6% | 0 | invalid-time: 3, unsynced-rule: 2 |
| recurrence:frequency | this | 156 | 152 | 63 | 96% ⚠ | 0 | invalid-scope: 89 |
| recurrence:frequency | this_and_following | 156 | 87 | 63 | 26% | 5 | invalid-time: 12, unsupported-rule: 6, confirm-required: 5, invalid-field: 1 |
| recurrence:frequency | all_series | 93 | 27 | 11 | 20% | 0 | invalid-time: 11, unsupported-rule: 5 |
| recurrence:count | this | 156 | 156 | 63 | 100% ⚠ | 0 | invalid-scope: 89, invalid-rule: 4 |
| recurrence:count | this_and_following | 156 | 94 | 63 | 33% | 6 | invalid-time: 12, invalid-rule: 7, confirm-required: 6, unsupported-rule: 5, invalid-field: 1 |
| recurrence:count | all_series | 93 | 37 | 11 | 32% | 3 | invalid-time: 11, invalid-rule: 7, unsupported-rule: 5, confirm-required: 3 |
| recurrence:until | this | 156 | 156 | 63 | 100% ⚠ | 0 | invalid-scope: 89, invalid-rule: 4 |
| recurrence:until | this_and_following | 156 | 100 | 63 | 40% | 8 | invalid-rule: 13, invalid-time: 12, confirm-required: 8, unsupported-rule: 3, invalid-field: 1 |
| recurrence:until | all_series | 93 | 36 | 11 | 30% | 2 | invalid-time: 11, invalid-rule: 7, unsupported-rule: 5, confirm-required: 2 |
| recurrence:count=null | this | 156 | 156 | 63 | 100% ⚠ | 0 | invalid-scope: 89, invalid-rule: 4 |
| recurrence:count=null | this_and_following | 156 | 97 | 63 | 37% | 8 | invalid-time: 12, confirm-required: 8, invalid-rule: 7, unsupported-rule: 6, invalid-field: 1 |
| recurrence:count=null | all_series | 93 | 36 | 11 | 30% | 2 | invalid-time: 11, invalid-rule: 7, unsupported-rule: 5, confirm-required: 2 |
| recurrence:until=null | this | 156 | 156 | 63 | 100% ⚠ | 0 | invalid-scope: 89, invalid-rule: 4 |
| recurrence:until=null | this_and_following | 156 | 83 | 63 | 22% | 0 | invalid-time: 12, invalid-rule: 7, invalid-field: 1 |
| recurrence:until=null | all_series | 93 | 29 | 11 | 22% | 0 | invalid-time: 11, invalid-rule: 7 |
| recurrence:replace | this | 156 | 152 | 63 | 96% ⚠ | 0 | invalid-scope: 89 |
| recurrence:replace | this_and_following | 156 | 147 | 63 | 90% ⚠ | 67 | confirm-required: 67, invalid-time: 12, unsupported-rule: 4, invalid-field: 1 |
| recurrence:replace | all_series | 93 | 83 | 11 | 88% ⚠ | 61 | confirm-required: 61, invalid-time: 11 |
| summary+start | this | 156 | 78 | 63 | 16% | 0 | invalid-time: 15 |
| summary+start | this_and_following | 156 | 89 | 63 | 28% | 5 | invalid-time: 15, confirm-required: 5, unsupported-rule: 4, invalid-field: 1, unsynced-rule: 1 |
| summary+start | all_series | 93 | 27 | 11 | 20% | 0 | invalid-time: 14, unsynced-rule: 2 |
| start:0001-01-01 | this | 156 | 150 | 63 | 94% ⚠ | 0 | invalid-time: 87 |
| start:0001-01-01 | this_and_following | 156 | 90 | 63 | 29% | 5 | invalid-time: 16, confirm-required: 5, unsupported-rule: 4, invalid-field: 1, unsynced-rule: 1 |
| start:0001-01-01 | all_series | 93 | 28 | 11 | 21% | 0 | invalid-time: 15, unsynced-rule: 2 |
| start:9999-12-31 | this | 156 | 78 | 63 | 16% | 0 | invalid-time: 15 |
| start:9999-12-31 | this_and_following | 156 | 90 | 63 | 29% | 5 | invalid-time: 15, confirm-required: 5, unsupported-rule: 4, unsynced-rule: 2, invalid-field: 1 |
| start:9999-12-31 | all_series | 93 | 30 | 11 | 23% | 0 | invalid-time: 14, unsynced-rule: 5 |
| recurrence:interval=1000000 | this | 156 | 156 | 63 | 100% ⚠ | 0 | invalid-scope: 89, invalid-rule: 4 |
| recurrence:interval=1000000 | this_and_following | 156 | 92 | 63 | 31% | 3 | invalid-time: 12, invalid-rule: 7, unsupported-rule: 6, confirm-required: 3, invalid-field: 1 |
| recurrence:interval=1000000 | all_series | 93 | 34 | 11 | 28% | 0 | invalid-time: 11, invalid-rule: 7, unsupported-rule: 5 |
| recurrence:frequency+start+end | this | 156 | 152 | 63 | 96% ⚠ | 0 | invalid-scope: 89 |
| recurrence:frequency+start+end | this_and_following | 156 | 101 | 63 | 41% | 12 | invalid-time: 18, confirm-required: 12, unsupported-rule: 6, invalid-field: 1, unsynced-rule: 1 |
| recurrence:frequency+start+end | all_series | 93 | 43 | 11 | 39% | 17 | confirm-required: 17, invalid-time: 8, unsupported-rule: 5, unsynced-rule: 2 |
| recurrence:frequency+timeZone | this | 156 | 152 | 63 | 96% ⚠ | 0 | invalid-scope: 89 |
| recurrence:frequency+timeZone | this_and_following | 156 | 84 | 63 | 23% | 5 | invalid-time: 12, confirm-required: 5, unsupported-rule: 3, invalid-field: 1 |
| recurrence:frequency+timeZone | all_series | 93 | 25 | 11 | 17% | 0 | invalid-time: 11, unsupported-rule: 3 |
| start+end:через полночь | this | 156 | 78 | 63 | 16% | 0 | invalid-time: 15 |
| start+end:через полночь | this_and_following | 156 | 84 | 63 | 23% | 5 | invalid-time: 9, confirm-required: 5, unsupported-rule: 4, unsynced-rule: 2, invalid-field: 1 |
| start+end:через полночь | all_series | 93 | 24 | 11 | 16% | 0 | invalid-time: 8, unsynced-rule: 5 |

Подозрительные пары:

- allDay:true × this — 92%
- allDay:true+start+end × this — 92%
- recurrence:count × this — 100%
- recurrence:count=null × this — 100%
- recurrence:frequency × this — 96%
- recurrence:frequency+start+end × this — 96%
- recurrence:frequency+timeZone × this — 96%
- recurrence:interval=1000000 × this — 100%
- recurrence:replace × all_series — 88%
- recurrence:replace × this — 96%
- recurrence:replace × this_and_following — 90%
- recurrence:until × this — 100%
- recurrence:until=null × this — 100%
- start:0001-01-01 × this — 94%
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
- `start:0001-01-01 × this` — 87 отказов `invalid-time` с одним и тем же поводом: «времени 0001-01-01T00:00
  в поясе Europe/Moscow нет — часы в этот день переводятся». Сам отказ законен (момент первого года в поясе
  с TZID не записать), а вот повод назван не тот: часы в этот день не переводятся, просто в первом году у
  пояса ещё среднее солнечное время (LMT), и ical.js читает его как разрыв перевода. Это не нарушение
  договора — правка отказала типизированно, — но пользователю объяснено неверно.
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
- Встреча, которую патч уводит за горизонт разворота (край года — 0001 или 9999), оракулу не видна, и он
  считает её пропавшей. Пока это не промах измерителя: у всех таких записей значение времени и так
  негодное (П9) — но если край года начнёт записываться по грамматике, горизонт придётся расширять или
  такие встречи считать отдельно.
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
