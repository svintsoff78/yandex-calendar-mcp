import { describe, expect, it } from "vitest";
import { byWeekdaySchema, minutesBeforeSchema } from "../../src/mcp/tools/createEvents.js";

// Правка по ревью задачи 12 (Important, находка 1): обе схемы — это два
// отдельных требования контроллера (порядковый префикс в byWeekday,
// отрицательные значения в minutesBefore), ранее проверенные только ручным
// прогоном `node -e`, который не переживает рефакторинг образца. Здесь они
// проверяются напрямую через safeParse на реальных экспортах инструмента.
describe("byWeekdaySchema", () => {
  it.each(["MO", "2MO", "-1FR", "53SA"])("принимает %s", (value) => {
    expect(byWeekdaySchema.safeParse(value).success).toBe(true);
  });

  it.each(["XX", "2", "MOMO", "MO2", "-MO", ""])("отвергает %s", (value) => {
    expect(byWeekdaySchema.safeParse(value).success).toBe(false);
  });

  // Правка по ревью задачи 12 (Important, находка 2): порядковый номер
  // недели в BYDAY по RFC 5545 §3.3.10 — целое от 1 до 53, ноль и числа
  // больше 53 в грамматику не входят. Прежняя схема (`-?\d+`, без верхней и
  // нижней границы) принимала "0MO" и "54MO" — до этой правки тест ниже
  // красный именно на них (см. отчёт задачи 12, раздел «Правка по находкам
  // ревью»), а не на всём диапазоне.
  describe("границы порядкового номера (1..53)", () => {
    it.each(["1MO", "53MO"])("принимает граничное значение %s", (value) => {
      expect(byWeekdaySchema.safeParse(value).success).toBe(true);
    });

    it.each(["0MO", "54MO"])("отвергает значение вне диапазона %s", (value) => {
      expect(byWeekdaySchema.safeParse(value).success).toBe(false);
    });
  });
});

describe("minutesBeforeSchema", () => {
  it.each([15, 0, -10])("принимает %s", (value) => {
    expect(minutesBeforeSchema.safeParse(value).success).toBe(true);
  });

  it("отвергает дробное число", () => {
    expect(minutesBeforeSchema.safeParse(1.5).success).toBe(false);
  });

  it("отвергает строку", () => {
    expect(minutesBeforeSchema.safeParse("15").success).toBe(false);
  });
});
