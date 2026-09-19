import { configDefaults, defineConfig } from "vitest/config";

// Два проекта (§6 и §7 плана переделки,
// docs/superpowers/plans/2026-09-19-recurring-events-rework.md):
// - unit — всё, кроме цепочек; его запускает `npm test`;
// - chains — цепочки tests/chains/*: `npm run test:chains`. В `npm test` их
//   включит задача З13, когда цепочки станут зелёными.
// `npx vitest run` без --project и `npm run test:tz` гоняют оба проекта.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/**/*.test.ts"],
          exclude: [...configDefaults.exclude, "tests/chains/**"],
        },
      },
      {
        test: {
          name: "chains",
          include: ["tests/chains/**/*.test.ts"],
        },
      },
    ],
  },
});
