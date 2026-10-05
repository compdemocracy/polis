// Prints how far Postgres's clock is from this process's clock, in ms.
// Some server tests compare row timestamps written by Postgres (now()) with
// Date.now() in the test process, so they assume one clock. Hosted runners
// share one kernel with Docker; a Mac runs Docker in a VM with its own clock.
//   node ci/local/clock-skew.cjs <postgres url>    (run from server/, for `pg`)
const { Client } = require(require.resolve("pg", { paths: [process.cwd()] }));
(async () => {
  const client = new Client({ connectionString: process.argv[2] });
  await client.connect();
  let best = null;
  for (let i = 0; i < 20; i++) {
    const t0 = Date.now();
    const r = await client.query("select (extract(epoch from clock_timestamp()) * 1000)::float8 as ms");
    const t1 = Date.now();
    const rtt = t1 - t0;
    const skew = r.rows[0].ms - (t0 + t1) / 2;
    if (!best || rtt < best.rtt) best = { rtt, skew };
  }
  await client.end();
  console.log(`clock skew (postgres minus test process): ${best.skew.toFixed(1)} ms (round trip ${best.rtt} ms)`);
})().catch((e) => { console.log(`clock skew: not measured (${e.message})`); });
