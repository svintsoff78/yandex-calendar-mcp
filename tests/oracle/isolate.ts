// Сторожевое время и память обхода: каждый случай выполняется в отдельном
// потоке (worker.mjs) под пределом времени и пределом кучи.
//
// Зачем. Планировщик и предохранитель работают синхронно, и ни таймер, ни
// Promise.race их не прервут: зацикленный разворот правила или разогнанная
// куча роняли бы весь прогон — не нарушением, а падением процесса без
// findings.json. В чужом потоке и то и другое ловится: зависший поток
// обрывается terminate(), а поток, упёршийся в resourceLimits, падает сам и
// отдаёт родителю ERR_WORKER_OUT_OF_MEMORY. Случай становится нарушением
// вида "timeout", а обход идёт дальше.
//
// Что это стоит. Старт потока с загрузкой модулей — около 80 мс, обмен
// сообщением — доли миллисекунды. Поток живёт, пока случаи укладываются в
// предел, и заводится заново после каждого обрыва.
import { Worker } from "node:worker_threads";
import { labelOf, repro, runCase, type CaseOutcome, type CaseSpec, type Finding } from "./case.js";

/**
 * Предел времени на один случай.
 *
 * Выбран по замеру, а не на глаз: самый долгий случай прежнего корпуса —
 * 154 мс (бесконечная серия, this_and_following), а случаи, ради которых
 * предел и заведён (правило с INTERVAL=1000000), не укладываются и в
 * секунды: один только planUpdate у них занимает 2,5 с, а verifyPlan — 25 с.
 * Между этими двумя кучками — порядок величины, и предел стоит посередине:
 * так исход не зависит от того, насколько занята машина, и повтор обхода
 * даёт тот же findings.json.
 */
export const CASE_LIMIT_MS = 1500;

/**
 * Предел старшего поколения кучи потока. Обычному случаю хватает единиц
 * мегабайт; предел нужен, чтобы случай, разгоняющий память, упёрся в него и
 * уронил только свой поток. Без предела поток делит кучу с процессом, и
 * «heap out of memory» уносит весь прогон.
 */
const HEAP_LIMIT_MB = 512;

/** Сколько ждать загрузки модулей в новом потоке. */
const START_LIMIT_MS = 30_000;

export interface CaseRunner {
  run(spec: CaseSpec): Promise<CaseOutcome>;
  close(): Promise<void>;
}

/** Нарушение «случай не уложился в предел»: с готовым воспроизведением. */
function timeoutFinding(spec: CaseSpec, detail: string): Finding {
  return {
    ...labelOf(spec),
    kind: "timeout",
    detail,
    minimalRepro: repro(spec, `здесь ${detail}`),
  };
}

function timeoutOutcome(spec: CaseSpec, detail: string): CaseOutcome {
  return { findings: [timeoutFinding(spec, detail)], refused: false, needsConfirm: false, noop: false };
}

/** Выполнение случаев в том же потоке: без сторожевого времени, для отладки. */
export function directRunner(): CaseRunner {
  return { run: runCase, close: async () => {} };
}

class IsolatedRunner implements CaseRunner {
  private worker?: Worker;
  private starting?: Promise<Worker>;
  private nextId = 1;
  private closed = false;

  constructor(private readonly limitMs: number) {}

  /** Живой поток: уже загруженный или только что заведённый. */
  private async ensure(): Promise<Worker> {
    if (this.worker) return this.worker;
    if (!this.starting) {
      this.starting = new Promise<Worker>((resolve, reject) => {
        const worker = new Worker(new URL("./worker.mjs", import.meta.url), {
          resourceLimits: { maxOldGenerationSizeMb: HEAP_LIMIT_MB },
        });
        // Поток без слушателя "error" роняет процесс необработанным событием:
        // слушатель висит всё время жизни потока, отдельно от слушателей случая.
        worker.on("error", () => {});
        const timer = setTimeout(() => {
          void worker.terminate();
          reject(new Error(`рабочий поток обхода не загрузился за ${START_LIMIT_MS} мс`));
        }, START_LIMIT_MS);
        timer.unref?.();
        const onReady = (message: { ready?: boolean }) => {
          if (!message?.ready) return;
          clearTimeout(timer);
          worker.off("message", onReady);
          resolve(worker);
        };
        worker.on("message", onReady);
        worker.once("error", (error) => {
          clearTimeout(timer);
          reject(
            new Error(
              `рабочий поток обхода не завёлся (${(error as Error).message}). ` +
                `Обход зовёт планировщик под сторожевым временем: для этого нужны worker_threads и tsx.`,
            ),
          );
        });
      }).finally(() => {
        this.starting = undefined;
      });
    }
    const worker = await this.starting;
    this.worker = worker;
    return worker;
  }

  /** Обрывает поток: следующий случай пойдёт в новом. */
  private drop(): void {
    const worker = this.worker;
    this.worker = undefined;
    if (worker) void worker.terminate();
  }

  async run(spec: CaseSpec): Promise<CaseOutcome> {
    if (this.closed) throw new Error("обход уже закрыт");
    const worker = await this.ensure();
    const id = this.nextId;
    this.nextId += 1;
    return await new Promise<CaseOutcome>((resolve) => {
      let done = false;
      const finish = (outcome: CaseOutcome) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        worker.off("message", onMessage);
        worker.off("error", onError);
        worker.off("exit", onExit);
        resolve(outcome);
      };
      const onMessage = (message: { id?: number; outcome?: CaseOutcome; failure?: string }) => {
        if (message?.id !== id) return;
        if (message.outcome) finish(message.outcome);
        else finish(timeoutOutcome(spec, `случай оборвался в рабочем потоке: ${message.failure ?? "без объяснения"}`));
      };
      const onError = (error: Error) => {
        this.drop();
        const code = (error as { code?: string }).code;
        finish(
          timeoutOutcome(
            spec,
            code === "ERR_WORKER_OUT_OF_MEMORY"
              ? `случай исчерпал кучу: рабочему потоку не хватило ${HEAP_LIMIT_MB} МиБ (${error.message})`
              : `рабочий поток упал: ${error.name}: ${error.message}`,
          ),
        );
      };
      const onExit = (code: number) => {
        this.drop();
        finish(timeoutOutcome(spec, `рабочий поток вышел с кодом ${code}, не ответив`));
      };
      const timer = setTimeout(() => {
        this.drop();
        finish(timeoutOutcome(spec, `случай не уложился в предел ${this.limitMs} мс: планировщик или предохранитель не вернул управление`));
      }, this.limitMs);
      worker.on("message", onMessage);
      worker.on("error", onError);
      worker.on("exit", onExit);
      worker.postMessage({ id, spec });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const worker = this.worker;
    this.worker = undefined;
    if (worker) await worker.terminate();
  }
}

/** Выполнение случаев в отдельном потоке под пределом времени и памяти. */
export function isolatedRunner(limitMs: number = CASE_LIMIT_MS): CaseRunner {
  return new IsolatedRunner(limitMs);
}
