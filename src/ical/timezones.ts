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
 */
export function registerTimeZone(tzid: string, vtimezoneIcs?: string): ICAL.Timezone {
  const existing = ICAL.TimezoneService.get(tzid);
  if (existing) return existing;

  const ics = vtimezoneIcs ?? tzdb.getVtimezoneComponent(tzid);
  if (!ics) throw new Error(`Неизвестный часовой пояс: ${tzid}`);

  const wrapped = ics.includes("BEGIN:VCALENDAR")
    ? ics
    : `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${ics}\r\nEND:VCALENDAR`;
  const component = new ICAL.Component(ICAL.parse(wrapped)).getFirstSubcomponent("vtimezone");
  if (!component) throw new Error(`В описании пояса ${tzid} нет блока VTIMEZONE.`);

  const zone = new ICAL.Timezone(component);
  // Аргументы register() исторически расположены как (timezone, name?) —
  // именно так объявлен тип в текущей .d.ts поставке ical.js. Порядок
  // (tzid, zone) из более старых примеров тоже поддерживается рантаймом
  // (там есть код, меняющий их местами), но не проходит проверку типов.
  ICAL.TimezoneService.register(zone, tzid);
  return zone;
}
