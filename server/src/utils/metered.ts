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
  let index = METRICS_IN_RAM[metricName].index;
  METRICS_IN_RAM[metricName].values[index] = val;
  METRICS_IN_RAM[metricName].index = (index + 1) % 1000;
}

// metered promise
export function MPromise(
  name: string,
  f: (resolve: (value: unknown) => void, reject: (reason?: any) => void) => void
) {
  let p = new Promise(f);
  let start = Date.now();
  setTimeout(function () {
    // TODO either add this arg to the function definition
    // TODO or remove this arg from the function call
    //     TS2554: Expected 2 arguments, but got 3.
    // 35     addInRamMetric(name + ".go", 1, start);
    // @ts-ignore                        ~~~~~
    addInRamMetric(name + ".go", 1, start);
  }, 100);
  p.then(
    function () {
      let end = Date.now();
      let duration = end - start;
      setTimeout(function () {
        // TODO either add this arg to the function definition
        // TODO or remove this arg from the function call
        //  TS2554: Expected 2 arguments, but got 3.
        // 45         addInRamMetric(name + ".ok", duration, end);
        // @ts-ignore
        addInRamMetric(name + ".ok", duration, end);
      }, 100);
    },
    function () {
      let end = Date.now();
      let duration = end - start;
      setTimeout(function () {
        // TODO either add this arg to the function definition
        // TODO or remove this arg from the function call
        // TS2554: Expected 2 arguments, but got 3.
        // 59         addInRamMetric(name + ".fail", duration, end);
        // @ts-ignore
        addInRamMetric(name + ".fail", duration, end);
      }, 100);
    }
  ).catch(function (err) {
    logger.error("MPromise internal error", err);
    let end = Date.now();
    let duration = end - start;
    setTimeout(function () {
      // TODO either add this arg to the function definition
      // TODO or remove this arg from the function call
      //       TS2554: Expected 2 arguments, but got 3.
      // 73       addInRamMetric(name + ".fail", duration, end);
      // @ts-ignore
      addInRamMetric(name + ".fail", duration, end);
      console.log("MPromise internal error");
    }, 100);
  });
  return p;
}

export default { addInRamMetric, MPromise };
