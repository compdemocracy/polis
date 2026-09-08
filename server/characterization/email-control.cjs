'use strict';
// This process deliberately enables the REAL notification loop using generated rows.
// It runs in the sealed network even if SES endpoint configuration points to AWS.
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
async function main() {
  await pool.query(
    'UPDATE participants SET subscribed=1,last_notified=0,last_interaction=0 WHERE uid=3 AND zid=1'
  );
  await pool.query(
    'INSERT INTO notification_tasks(zid,modified) VALUES(1,1700000000000) ON CONFLICT(zid) DO UPDATE SET modified=EXCLUDED.modified'
  );
  await pool.end();
  process.env.DEV_MODE = 'false';
  require('./entry.cjs');
  const notify = require('../src/routes/notify.ts');
  if (notify.isNotificationLoopStarted()) throw Error('notification loop started on import');
  notify.startNotificationLoop();
  const deadline = Date.now() + 20000;
  const timer = setInterval(() => {
    const s = global.__p027;
    const command = s.outbound.find(
      (x) => x.service === 'SESv2' && x.command === 'SendEmailCommand'
    );
    const blocked = s.outbound.find((x) => x.blocked && x.host === 'email.us-east-1.amazonaws.com');
    if (command && blocked) {
      clearInterval(timer);
      require('node:fs').writeFileSync(
        '/artifacts/email-control.json',
        JSON.stringify(
          { loopStarted: notify.isNotificationLoopStarted(), command, blocked },
          null,
          2
        )
      );
      console.log(
        'PASS: real notification loop attempted SES v2 SendEmail; blocked before transport'
      );
      process.exit(0);
    }
    if (Date.now() > deadline) {
      console.error('FAIL: real notification loop did not produce a blocked SES attempt');
      process.exit(1);
    }
  }, 100);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
