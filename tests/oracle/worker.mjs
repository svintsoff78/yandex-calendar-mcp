// Рабочий поток обхода (isolate.ts): выполняет по одному случаю и отдаёт
// исход обратно. Смысл потока — предел: зацикленный планировщик обрывается
// terminate(), а разогнанная куча упирается в resourceLimits и роняет только
// этот поток, а не весь прогон.
//
// Файл нарочно на чистом JavaScript: поток загружает модули сам, без
// сборщика тестов, а типы с остальных файлов снимает tsx (он же превращает
// "./case.js" в "./case.ts", как это делает и сборщик).
import { parentPort } from "node:worker_threads";

if (!parentPort) throw new Error("tests/oracle/worker.mjs запускается только рабочим потоком");

const { register } = await import("tsx/esm/api");
register();
const { runCase } = await import("./case.js");

parentPort.on("message", async (message) => {
  const { id, spec } = message;
  try {
    parentPort.postMessage({ id, outcome: await runCase(spec) });
  } catch (error) {
    const name = error && error.name ? error.name : "Error";
    const text = error && error.message ? error.message : String(error);
    parentPort.postMessage({ id, failure: `${name}: ${text}` });
  }
});

parentPort.postMessage({ ready: true });
