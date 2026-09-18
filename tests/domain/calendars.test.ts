import { describe, expect, it, vi } from "vitest";
import { listCalendars, resolveCalendarIn } from "../../src/domain/calendars.js";
import type { Calendar } from "../../src/types.js";

const calendars: Calendar[] = [
  { id: "work", href: "/c/work/", displayName: "Работа", readOnly: false },
  { id: "home", href: "/c/home/", displayName: "Дом", readOnly: false },
];

describe("listCalendars", () => {
  it("спрашивает сервер один раз и дальше отдаёт из кеша", async () => {
    const discover = vi.fn().mockResolvedValue(calendars);
    const context = { client: {} as never, config: {} as never, discover };

    await listCalendars(context as never);
    await listCalendars(context as never);

    expect(discover).toHaveBeenCalledTimes(1);
  });
});

describe("resolveCalendarIn", () => {
  it("находит календарь по идентификатору", () => {
    expect(resolveCalendarIn(calendars, "home").displayName).toBe("Дом");
  });

  it("находит календарь по названию, если идентификатор не подошёл", () => {
    expect(resolveCalendarIn(calendars, "Работа").id).toBe("work");
  });

  it("берёт первый, когда ничего не передали", () => {
    expect(resolveCalendarIn(calendars, undefined).id).toBe("work");
  });

  it("перечисляет доступные варианты, когда календарь не найден", () => {
    expect(() => resolveCalendarIn(calendars, "отпуск")).toThrow(/Работа.*Дом|work.*home/s);
  });
});
