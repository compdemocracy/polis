import logger from "./logger";

type MetricsInRam = {
  [key: string]: any;
};

// metric name => {
//    values: [circular buffers of values (holds 1000 items)]
//    index: index in circular buffer
//}
export const METRICS_IN_RAM: MetricsInRam = {};
const SHOULD_ADD_METRICS_IN_RAM = false;

export function addInRamMetric(metricName: string, val: number) {
  if (!SHOULD_ADD_METRICS_IN_RAM) {
    return;
  }
  if (!METRICS_IN_RAM[metricName]) {
    METRICS_IN_RAM[metricName] = {
      values: new Array(1000),
      index: 0,
    };
  }
  const index = METRICS_IN_RAM[metricName].index;
  METRICS_IN_RAM[metricName].values[index] = val;
  METRICS_IN_RAM[metricName].index = (index + 1) % 1000;
}

// metered promise
export function MPromise(
  name: string,
  f: (resolve: (value: unknown) => void, reject: (reason?: any) => void) => void
) {
  const p = new Promise(f);
  const start = Date.now();
  setTimeout(function () {
    addInRamMetric(name + ".go", 1);
  }, 100);
  p.then(
    function () {
      const end = Date.now();
      const duration = end - start;
      setTimeout(function () {
        addInRamMetric(name + ".ok", duration);
      }, 100);
    },
    function () {
      const end = Date.now();
      const duration = end - start;
      setTimeout(function () {
        addInRamMetric(name + ".fail", duration);
      }, 100);
    }
  ).catch(function (err) {
    logger.error("MPromise internal error", err);
    const end = Date.now();
    const duration = end - start;
    setTimeout(function () {
      addInRamMetric(name + ".fail", duration);
      logger.error("MPromise internal error", err);
    }, 100);
  });
  return p;
}

export default { addInRamMetric, MPromise };
