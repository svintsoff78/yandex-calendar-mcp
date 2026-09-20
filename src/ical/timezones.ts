import ICAL from "ical.js";
import tzdb from "@touch4it/ical-timezones";

/**
 * Регистрирует часовой пояс в ICAL.TimezoneService и возвращает его.
 *
 * Яндекс не отдаёт VTIMEZONE через свойство `calendar-timezone` (404 на всех
 * коллекциях, см. docs/yandex-caldav-capabilities.md), поэтому без базы IANA
 * `ical.js` не знает смещение произвольного TZID и молча считает его нулевым.
 * Здесь используется база `@touch4it/ical-timezones`. Второй параметр
 * (`vtimezoneIcs`) нужен для случая, когда описание пояса уже пришло вложенным
 * в `calendar-data` самого события — тогда обращение к базе не требуется.
 *
 * `tzid` зоны — запрошенное имя, а не TZID из описания. База отдаёт для
 * синонимов каноническое описание (US/Eastern → TZID:America/New_York,
 * UTC → Etc/UTC). Если взять tzid из описания, значения, записанные по
 * `zone.tzid` (RECURRENCE-ID, EXDATE, RDATE), получат другой TZID, чем
 * DTSTART, на который ссылается событие (О4 плана переделки).
 * Сверено: node_modules/ical.js/lib/ical/timezone.js, fromData — поле tzid из
 * переданных данных имеет приоритет, из компонента берётся, только если пусто.
 */
export function registerTimeZone(tzid: string, vtimezoneIcs?: string): ICAL.Timezone {
  const existing = ICAL.TimezoneService.get(tzid);
  if (existing) return existing;

  const ics = vtimezoneIcs ?? vtimezoneIcsFor(tzid);
  if (!ics) throw new Error(`Неизвестный часовой пояс: ${tzid}`);

  const component = parseVtimezone(ics, tzid);
  const zone = new ICAL.Timezone({ component, tzid });
  // Аргументы register() исторически расположены как (timezone, name?) —
  // именно так объявлен тип в текущей .d.ts поставке ical.js. Порядок
  // (tzid, zone) из более старых примеров тоже поддерживается рантаймом
  // (там есть код, меняющий их местами), но не проходит проверку типов.
  ICAL.TimezoneService.register(zone, tzid);
  return zone;
}

/**
 * Отдаёт новую, ни к чему не прицепленную копию VTIMEZONE для `tzid` —
 * для вставки в календарный объект (ensureTimezones только добавляет пояса).
 *
 * Источник — база IANA, а не ICAL.TimezoneService: в сервис могли попасть
 * описания из чужих объектов (expand.ts регистрирует вложенные VTIMEZONE), и
 * от порядка чтения объектов записываемый текст зависеть не должен. Только
 * если в базе такого имени нет, берётся уже зарегистрированное описание
 * (пояс вне IANA, пришедший вложенным в объект). TZID в копии — запрошенное
 * имя (для синонимов база отдаёт каноническое).
 *
 * Копия нужна потому, что `Component.addSubcomponent` отцепляет компонент от
 * прежнего родителя (node_modules/ical.js/lib/ical/component.js,
 * addSubcomponent), а общий объект из сервиса мог бы уехать из одного
 * календаря в другой. Глубокая копия jCal — `ICAL.helpers.clone(jCal, true)`
 * (node_modules/ical.js/lib/ical/helpers.js, clone).
 */
export function vtimezoneFor(tzid: string): ICAL.Component {
  const ics = vtimezoneIcsFor(tzid);
  if (ics) return parseVtimezone(ics, tzid);

  const registered = ICAL.TimezoneService.get(tzid)?.component;
  if (registered) {
    const copy = new ICAL.Component(ICAL.helpers.clone(registered.jCal, true));
    copy.updatePropertyWithValue("tzid", tzid);
    return copy;
  }
  throw new Error(`Неизвестный часовой пояс: ${tzid}`);
}

/**
 * Описание пояса из базы IANA по имени, с учётом того, что имена поясов
 * регистронезависимы: «europe/berlin» называет тот же пояс, что
 * «Europe/Berlin», и `Intl.DateTimeFormat` принимает оба написания.
 * `@touch4it/ical-timezones` ищет по точному имени и на неканоническом
 * написании отдаёт пустоту — поэтому имя, которого в базе нет как есть,
 * приводится к каноническому виду средствами ICU и ищется ещё раз. Так
 * законное имя пояса перестаёт быть отказом unknown-timezone.
 *
 * Найденное описание получает ЗАПРОШЕННОЕ имя (`parseVtimezone` ставит его в
 * TZID): значения объекта ссылаются на пояс тем именем, которое в них
 * записано, и подменять его каноническим нельзя — DTSTART и RECURRENCE-ID
 * разъехались бы по разным TZID (О4).
 */
function vtimezoneIcsFor(tzid: string): string | undefined {
  const direct = tzdb.getVtimezoneComponent(tzid);
  if (direct) return direct;
  const canonical = canonicalTzid(tzid);
  if (canonical === undefined || canonical === tzid) return undefined;
  return tzdb.getVtimezoneComponent(canonical) || undefined;
}

/**
 * Каноническое написание имени пояса по базе ICU; имя не из IANA (и вообще
 * любое, которого ICU не знает) — undefined. `Intl.DateTimeFormat` на
 * неизвестном поясе бросает RangeError.
 */
function canonicalTzid(tzid: string): string | undefined {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tzid }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

// Разбирает описание пояса (с обёрткой VCALENDAR или без) в отдельный
// компонент VTIMEZONE без родителя и ставит в его TZID запрошенное имя.
function parseVtimezone(ics: string, tzid: string): ICAL.Component {
  const wrapped = ics.includes("BEGIN:VCALENDAR")
    ? ics
    : `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${ics}\r\nEND:VCALENDAR`;
  const vtimezone = new ICAL.Component(ICAL.parse(wrapped)).getFirstSubcomponent("vtimezone");
  if (!vtimezone) throw new Error(`В описании пояса ${tzid} нет блока VTIMEZONE.`);

  // Новый компонент на том же jCal, но без родителя: отцеплять от временного
  // VCALENDAR незачем, он больше нигде не используется.
  const component = new ICAL.Component(vtimezone.jCal);
  component.updatePropertyWithValue("tzid", tzid);
  return component;
}
