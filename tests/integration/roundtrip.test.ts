import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createContext } from "../../src/mcp/context.js";
import { createEvent, deleteEvent, readEvents, updateEvent } from "../../src/domain/events.js";
import type { CalendarEvent, Context } from "../../src/types.js";

// Полный цикл на живом аккаунте: создать → прочитать → перенести → удалить.
// Меняет настоящий календарь, поэтому помечен describe.skip и в общий прогон
// `npx vitest run` не входит.
//
// Как запустить вручную:
//   1. Временно заменить ниже `describe.skip(` на `describe(`.
//   2. В корне проекта выполнить:
//        YANDEX_LOGIN=name@yandex.ru YANDEX_APP_PASSWORD=... \
//        YANDEX_DEFAULT_TZ=Europe/Moscow \
//        npx vitest run tests/integration --testTimeout=30000 --hookTimeout=30000
//   3. Вернуть `describe.skip(` на место.
//
// Ожидается: четыре теста проходят; в первом календаре аккаунта (первом в
// выдаче list_calendars) на 15 января 2030 года ненадолго появляется событие
// «проверка mcp <число>», переезжает с 10:00 на 12:00 и исчезает. Если прогон
// упал на середине и уборка тоже не удалась, найдите это событие в
// веб-интерфейсе по метке и удалите вручную.
//
// Почему контекст и метка создаются в beforeAll, а не прямо в теле describe,
// как в брифе: vitest ВЫПОЛНЯЕТ тело describe.skip при сборе тестов —
// пропускаются только it и хуки. createContext бросает исключение, если
// переменных YANDEX_* нет, и вызов в теле describe уронил бы обычный прогон
// ещё до пропуска. Хуки пропущенного блока не выполняются вовсе.

const WINDOW = { from: "2030-01-01T00:00:00+03:00", to: "2030-02-01T00:00:00+03:00" };
const START = "2030-01-15T10:00:00+03:00";
const END = "2030-01-15T11:00:00+03:00";
const MOVED_START = "2030-01-15T12:00:00+03:00";
const MOVED_END = "2030-01-15T13:00:00+03:00";
const NOT_CREATED = "событие не создано предыдущим тестом";

describe.skip("полный цикл на живом аккаунте", () => {
  let context: Context;
  let marker: string;
  // UID созданного события, пока оно, насколько известно, лежит в календаре.
  // Обнуляется только после подтверждённого удаления — до этого afterAll
  // убирает событие за любым упавшим тестом.
  let createdId = "";

  // Каждая проверка идёт настоящим чтением с сервера, а не по значению,
  // которое вернула предыдущая операция: так видно и дубликаты, и событие,
  // которое операция «удалила» или «перенесла» только на словах.
  function readMarked(): Promise<CalendarEvent[]> {
    return readEvents(context, { ...WINDOW, query: marker });
  }

  beforeAll(() => {
    context = createContext(process.env);
    marker = `проверка mcp ${Date.now()}`;
  });

  it("создаёт событие", async () => {
    const event = await createEvent(context, { summary: marker, start: START, end: END });

    expect(event.id).toBeTruthy();
    createdId = event.id;
  });

  it("находит созданное событие чтением под тем же UID и в то же время", async () => {
    expect(createdId, NOT_CREATED).toBeTruthy();

    const found = await readMarked();

    expect(found).toHaveLength(1);
    expect(found[0].id).toBe(createdId);
    expect(found[0].summary).toBe(marker);
    expect(Date.parse(found[0].start)).toBe(Date.parse(START));
    expect(Date.parse(found[0].end)).toBe(Date.parse(END));
  });

  it("переносит событие правкой, и чтение видит новое время", async () => {
    expect(createdId, NOT_CREATED).toBeTruthy();

    await updateEvent(context, { id: createdId, patch: { start: MOVED_START, end: MOVED_END } });
    const found = await readMarked();

    expect(found).toHaveLength(1);
    expect(found[0].id).toBe(createdId);
    expect(found[0].summary).toBe(marker);
    expect(Date.parse(found[0].start)).toBe(Date.parse(MOVED_START));
    expect(Date.parse(found[0].end)).toBe(Date.parse(MOVED_END));
  });

  it("удаляет событие, и чтение его больше не находит", async () => {
    expect(createdId, NOT_CREATED).toBeTruthy();

    await deleteEvent(context, { id: createdId, scope: "all_series" });

    expect(await readMarked()).toEqual([]);
    createdId = "";
  });

  afterAll(async () => {
    if (!createdId) return;
    try {
      await deleteEvent(context, { id: createdId, scope: "all_series" });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Не удалось убрать тестовое событие «${marker}» (UID ${createdId}) — удалите его вручную: ${reason}`,
        { cause: error },
      );
    }
  });
});
