export default function trySendingBackupEmailTest() {
  if (devMode) {
    return;
  }
  const d = new Date();
  if (d.getDay() === 1) {
    // send the monday backup email system test
    // If the sending fails, we should get an error ping.
    sendTextEmailWithBackupOnly(
      polisFromAddress,
      Config.adminEmailEmailTest,
      "monday backup email system test",
      "seems to be working"
    );
  }
}

// try every 23 hours (so it should only try roughly once a day)
setInterval(trySendingBackupEmailTest, 1000 * 60 * 60 * 23);
trySendingBackupEmailTest();
