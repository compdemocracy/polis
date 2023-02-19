type MetricsInRam = {
  [key: string]: { values: number[]; index: number };
};

// metric name => {
//    values: [circular buffers of values (holds 1000 items)]
//    index: index in circular buffer
//}
const METRICS_IN_RAM: MetricsInRam = {};
const SHOULD_ADD_METRICS_IN_RAM = false;

// TODO either add this arg to the function definition
// TODO or remove this arg from the function call
function addInRamMetric(metricName: string, val: number): void {
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

function MPromise(
  name: string,
  fn: (resolve: (value?: any) => void, reject: (value?: any) => void) => void
): Promise<unknown> {
  const prom = new Promise(fn);
  const start = Date.now();

  prom
    .then(
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
    )
    .catch(function (err) {
      const end = Date.now();
      const duration = end - start;
      setTimeout(function () {
        console.error("MPromise error: ", err, " for ", name);
        addInRamMetric(name + ".fail", duration);
      }, 100);
    });

  return prom;
}

export { addInRamMetric, MPromise, METRICS_IN_RAM };
