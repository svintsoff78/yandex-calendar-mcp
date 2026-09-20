// Применение плана к подставному серверу (tests/support/fakeCaldav.ts,
// поведение по умолчанию — яндексовское, Ж13–Ж16). Сеть настоящая по всему
// пути: createClient → src/caldav/request.ts → src/caldav/objects.ts, как в
// оркестрации; подменён только fetch.
//
// Оракул ничего в tests/support не меняет: затравка кладётся plant(),
// записи уходят putObject/deleteObject, состояние читается fake.objects.
import { deleteObject, putObject } from "../../src/caldav/objects.js";
import { hrefFor } from "../../src/domain/events.js";
import type { WritePlan } from "../../src/ical/plan.js";
import type { Context } from "../../src/types.js";
import { calendarA, makeStand, plant } from "../support/context.js";
import type { FakeCaldav } from "../support/fakeCaldav.js";
import type { Seed } from "../support/seeds.js";

export interface Stand {
  fake: FakeCaldav;
  ctx: Context;
  /** Путь затравки, как его кладёт Яндекс. */
  path: string;
  etag: string;
}

/** Свежий стенд с одной затравкой. */
export function standWith(seed: Seed): Stand {
  const { fake, ctx } = makeStand();
  const path = plant(fake, seed);
  return { fake, ctx, path, etag: fake.etag(path) };
}

export type ApplyResult =
  | { ok: true; wrote: number }
  | { ok: false; error: Error; rejections: string[]; wrote: number };

/**
 * Пишет план на сервер так, как это делает доставка (src/domain/writes.ts,
 * Р9): у разреза сперва продолжение с новым UID, затем усечённый исходный
 * объект.
 */
export async function applyPlan(stand: Stand, plan: WritePlan): Promise<ApplyResult> {
  const mark = stand.fake.mark();
  const wrote = () => stand.fake.writesSince(mark).filter((entry) => entry.applied).length;
  try {
    if (plan.kind === "put") {
      await putObject(stand.ctx.client, stand.path, plan.ics, { ifMatch: stand.etag });
    } else if (plan.kind === "delete-object") {
      await deleteObject(stand.ctx.client, stand.path, stand.etag);
    } else if (plan.kind === "split") {
      const href = hrefFor(calendarA, plan.continuation.uid);
      await putObject(stand.ctx.client, href, plan.continuation.ics, { ifNoneMatch: true });
      await putObject(stand.ctx.client, stand.path, plan.truncated.ics, { ifMatch: stand.etag });
    }
    return { ok: true, wrote: wrote() };
  } catch (error) {
    return {
      ok: false,
      error: error as Error,
      rejections: stand.fake.rejections.flatMap((r) => r.reasons),
      wrote: wrote(),
    };
  }
}

/** Тексты всех объектов сервера в устойчивом порядке (после разреза их два). */
export function storedIcs(stand: Stand): string[] {
  return [...stand.fake.objects.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, object]) => object.ics);
}
