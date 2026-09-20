import { describe, expect, it } from "vitest";
import { attendeeSchema, patchSchema, recurrenceSchema } from "../../src/mcp/tools/updateEvent.js";

// Схема средства — это то, что видит языковая модель, и она же решает, дойдёт
// ли до движка то, что просил пользователь. Движок умеет частичную правку
// повтора, снятие статуса и подтверждение потерь давно; проверяется здесь
// ровно одно: схема этого не отрезает и ничего не подставляет от себя.
//
// Умолчание в схеме опаснее пропуска: подставленное значение неотличимо от
// переданного, и «не трогать» превращается в «записать это».

describe("patchSchema: умолчаний нет", () => {
  it("пустой патч разбирается и остаётся пустым", () => {
    const parsed = patchSchema.parse({});
    expect(parsed).toEqual({});
  });

  it("не переданный статус не появляется сам", () => {
    expect("status" in patchSchema.parse({ summary: "Планёрка" })).toBe(false);
  });
});

describe("статус встречи", () => {
  it.each(["confirmed", "tentative", "cancelled"] as const)("принимает %s", (status) => {
    expect(patchSchema.safeParse({ status }).success).toBe(true);
  });

  it("null принимается — им статус снимают", () => {
    expect(patchSchema.parse({ status: null })).toEqual({ status: null });
  });

  it.each(["postponed", "CONFIRMED", ""])("отвергает %s", (status) => {
    expect(patchSchema.safeParse({ status }).success).toBe(false);
  });
});

describe("правка повтора по частям", () => {
  it("каждая часть передаётся в одиночку, частота не обязательна", () => {
    for (const part of [{ interval: 2 }, { count: 5 }, { until: "2026-12-31" }, { byWeekday: ["MO"] }]) {
      expect(recurrenceSchema.safeParse(part).success, JSON.stringify(part)).toBe(true);
    }
  });

  it("null снимает часть правила", () => {
    expect(recurrenceSchema.parse({ count: null })).toEqual({ count: null });
    expect(recurrenceSchema.parse({ until: null })).toEqual({ until: null });
    expect(recurrenceSchema.parse({ interval: null })).toEqual({ interval: null });
    expect(recurrenceSchema.parse({ byWeekday: null })).toEqual({ byWeekday: null });
  });

  it("шаг повтора не подставляется сам: без него в разобранном патче его нет", () => {
    expect("interval" in recurrenceSchema.parse({ frequency: "weekly" })).toBe(false);
  });

  it("сборка правила заново передаётся признаком replace", () => {
    expect(recurrenceSchema.parse({ frequency: "daily", replace: true })).toEqual({
      frequency: "daily",
      replace: true,
    });
  });
});

describe("участники", () => {
  it("без ответа участника PARTSTAT не трогается: схема ничего не подставляет", () => {
    const parsed = attendeeSchema.parse({ email: "petrov@example.com" });
    expect(parsed).toEqual({ email: "petrov@example.com" });
    expect("status" in parsed).toBe(false);
  });

  it("ответ участника передаётся, когда он назван", () => {
    expect(attendeeSchema.parse({ email: "petrov@example.com", status: "accepted" }).status).toBe("accepted");
  });
});
