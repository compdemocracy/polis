// metric name => {
//    values: [circular buffers of values (holds 1000 items)]
//    index: index in circular buffer
//}
const METRICS_IN_RAM = {};
const SHOULD_ADD_METRICS_IN_RAM = false;

function addInRamMetric(metricName, val) {
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
function MPromise(name, f) {
  let p = new Promise(f);
  let start = Date.now();
  setTimeout(function() {
    addInRamMetric(name + ".go", 1, start);
  }, 100);
  p.then(function() {
    let end = Date.now();
    let duration = end - start;
    setTimeout(function() {
      addInRamMetric(name + ".ok", duration, end);
    }, 100);
  }, function() {
    let end = Date.now();
    let duration = end - start;
    setTimeout(function() {
      addInRamMetric(name + ".fail", duration, end);
    }, 100);
  }).catch(function(err) {
    let end = Date.now();
    let duration = end - start;
    setTimeout(function() {
      addInRamMetric(name + ".fail", duration, end);
      console.log("MPromise internal error");
    }, 100);
  });
  return p;
}

module.exports = {
  addInRamMetric,
  MPromise
};
