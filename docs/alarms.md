# Operational alarms

Six CloudWatch alarms — four of them new — plus one SNS topic and one CodeDeploy
event rule. This is
P-031 slice 1: the subset of the alarm catalog whose metrics already exist in
the account, so nothing in `server/`, `math/` or `delphi/` had to change and no
new metric publisher was added.

Everything here is **off by default**. It exists in the template only when the
stack is synthesized with the flag on:

```bash
cd cdk
npx cdk synth -c enableAlarms=true -c alarmEmail=ops@example.org
npx cdk deploy -c enableAlarms=true -c alarmEmail=ops@example.org
```

Synthesis **fails** if `enableAlarms=true` is passed without `alarmEmail`. An
alarm with no subscriber looks like coverage and is not.

Pin the flag and the address in whatever invokes `cdk deploy` for production. If
a later deploy forgets them, the alarms are removed silently — the template is
byte-identical to the pre-P-031 one with the flag off, which is exactly what
makes the removal invisible.

## What the alarms are

| Alarm | Metric | Statistic / period | Fires when | Missing data |
|---|---|---|---|---|
| `Polis-Math-WorkerMetricMissing` (A17) | `AWS/EC2 CPUUtilization`, math ASG | Minimum / 300 s | 2 of 3 periods below 0 % — i.e. never on a value, only on absence | **breaching** |
| `Polis-Web-NoHealthyHosts` (A13) | `AWS/ApplicationELB HealthyHostCount`, web TG + ALB | Minimum / 60 s | 2 of 3 periods below 1 healthy target | **breaching** |
| `Polis-DB-LowCPUCreditBalance` (A04) | `AWS/RDS CPUCreditBalance` | Minimum / 300 s | 3 of 3 periods below 60 credits | **breaching** |
| `Polis-DB-HighCPUUtilization` (A06) | `AWS/RDS CPUUtilization` | Average / 300 s | 2 of 2 periods above 80 % | notBreaching |
| `Polis-DB-LowFreeStorageSpace` (A07) | `AWS/RDS FreeStorageSpace` | Average / 300 s | 1 period below 4 GiB | ignore |
| `Polis-Alerts-NotificationDeliveryFailed` (A18) | `AWS/SNS NumberOfNotificationsFailed`, shared topic | Sum / 300 s | any failed delivery in a 5-minute window | notBreaching |
| `Polis-CodeDeploy-DeploymentFailure` (A16) | EventBridge rule, not an alarm | — | a deployment enters `FAILURE` or `STOP` | — |

A06 and A07 already existed and are unchanged apart from gaining the shared
topic as a second notification target. Every alarm sends on **both** ALARM and
OK, so a cleared incident closes itself in the inbox.

Email is not a paging system. SNS notifies on state *transition* only: a
persisting ALARM does not re-send. Anything left in ALARM has to be inspected
deliberately.

## First response

### Polis-Math-WorkerMetricMissing

**Meaning:** the math worker ASG has stopped publishing CPU metrics entirely.
Not "the worker is idle" — the threshold is `< 0 %`, which no real CPU reading
can satisfy. The only way this fires is the absence of data, which means no
instance is running and reporting under that ASG.

This is the alarm that would have caught the 2026-09-08 outage. That incident
produced a 75-minute hole in this exact metric and **zero** sub-1 % buckets: an
instance was terminated, its replacement never reached `InService`, and every
other alarm in the catalog stayed silent throughout.

**First response**

1. `aws autoscaling describe-auto-scaling-groups` — is there an instance, and is
   its lifecycle state `InService`?
2. If an instance exists but is unhealthy, read its console output and the boot
   logs. The known failure mode is the container runtime failing to start on the
   ARM host, which leaves the instance up but the JVM absent.
3. If no instance exists, check ASG activity history for repeated
   launch-and-terminate cycles (a failing health check will loop).
4. Votes continue to be collected while math is down; what stops is the
   clustering update. Do not treat this as data loss.

**Do not** take an automatic action here. There is no auto-restart wired to this
alarm, deliberately: a boot-failure loop is made worse by more launches.

Caveat: `2 of 3` does not guarantee a transition after exactly two missing
periods. CloudWatch pulls an extended evaluation range and may use older real
datapoints, so the practical detection time is somewhere between 10 and 20
minutes. Validate against a drill, not arithmetic.

### Polis-Web-NoHealthyHosts

**Meaning:** the ALB has no healthy target in the web target group. Users are
getting errors right now, or would be if they arrived.

**First response**

1. `aws elbv2 describe-target-health --target-group-arn ...` — how many targets,
   and what reason does each unhealthy one give?
2. `Target.FailedHealthChecks` on all targets usually means the app is failing
   `/api/v3/testConnection`, not that the instances are gone.
3. Check whether a CodeDeploy deployment is in flight; a bad revision rolling
   across the group produces exactly this.
4. If the ASG has fewer instances than its minimum, look at launch failures
   first — the ALB is reporting a symptom, not the cause.

The alarm uses the target group and load balancer dimensions only. Per-AZ series
exist for this metric and each goes to zero during ordinary AZ rebalancing;
including `AvailabilityZone` would make this alarm noisy and useless.

### Polis-DB-LowCPUCreditBalance

**Meaning:** the `db.t3.large` has burned nearly all its CPU credits. The
instance runs in **unlimited** mode, so this is cost exposure and lost headroom
— it is *not* proof of throttling, and the database is not "down".

Threshold basis: two vCPUs × (100 % − 30 % baseline) = 1.4 net credits/minute
under sustained full load, so 60 credits is roughly 43 minutes of margin.

**First response**

1. Look at `CPUUtilization` alongside it. Sustained high CPU with a falling
   balance is real load; a falling balance with moderate CPU is a slow leak.
2. Check `CPUSurplusCreditsCharged` — once the balance hits zero, surplus
   credits accrue and are billed.
3. Look for a new query pattern, a missing index, or a batch job. The instance
   spent roughly eight continuous days credit-exhausted ending 2026-09-02 and
   then fully recovered; the cause of the recovery is not established, so a
   regression is plausible and worth diagnosing rather than absorbing.

This alarm also does double duty: it is the **health pair** for
`Polis-DB-LowFreeStorageSpace`. See "Health pairing" below.

### Existing database alarms

`Polis-DB-HighCPUUtilization` (A06) and `Polis-DB-LowFreeStorageSpace` (A07)
predate P-031 and keep their logical IDs, metrics, thresholds and missing-data
settings exactly as deployed — moving them under a new construct path would
replace the alarms and discard their history.

What changed: the shared operations topic was **added** to their actions. The
original `DatabaseAlarmsTopic` action stays in place, so the migration cannot
open a coverage gap and delivery does not split. Once the shared topic has been
observed working end to end, the old action can be removed deliberately.

- **A06 first response:** identify the query load. At 80 % average over 10
  minutes on two vCPUs the instance is saturated, and the credit balance is
  falling with it.
- **A07 first response:** free storage below 4 GiB. Storage auto-scales to
  100 GiB, so this usually means growth outpaced the scaling event or the
  ceiling was reached. Check table and WAL growth before raising the ceiling.

`Polis-DB-HighDatabaseConnections` is deliberately untouched by this slice. Its
`>= 500` threshold against a measured ~9.5 average connections means it will
never fire; it needs a deliberate decision between re-thresholding and retiring,
not a quiet migration.

### Polis-CodeDeploy-DeploymentFailure

**Meaning:** a CodeDeploy deployment entered `FAILURE` or `STOP`. `STOP` is
included because an intentional cancellation is still context an operator needs
mid-incident. `START` and `SUCCESS` are not sent — this is a failure signal, not
a deployment audit.

The email carries the application, deployment group, deployment id, timestamp
and a console link.

**First response:** open the deployment in the console, read the failed
lifecycle event, and check whether instances were left in a partially deployed
state. EventBridge delivery is best effort; the deploying workflow's own status
remains the authoritative record.

**Authorization.** The rule publishes through its own execution role rather than
through an `events.amazonaws.com` principal on the topic policy, so the topic
policy names no EventBridge principal at all. The alternative — a service
principal fenced by an `aws:SourceArn` condition — depends on EventBridge
supplying that condition key when it publishes to SNS, which is not something
the synthesized template can demonstrate. If it did not, every deployment
failure notification would be denied silently. The role has exactly one
permission: `sns:Publish` on this topic.

Both forms still need the same drill before A16 can be called working: a real
matching deployment event reaches the inbox, a non-matching state does not, and
CloudWatch alarm delivery is unaffected.

### Polis-Alerts-NotificationDeliveryFailed

**Meaning:** SNS reported a failed delivery of an operational alert. **The alert
path itself is degraded.** Assume any alarm raised in the same window was not
seen by anyone.

**First response**

1. `aws sns list-subscriptions-by-topic` — is the subscription still
   `Confirmed`, or has it reverted to `PendingConfirmation`?
2. Repeated bounces (a full mailbox, a rejecting server) will disable an
   endpoint. Check with the recipient directly.
3. Re-run the delivery drill below once the endpoint is fixed.

Two limitations, stated plainly:

- A **deleted** subscription produces no failed delivery attempt at all, so this
  alarm does not see it. Periodic subscription checks stay necessary.
- Its own notification goes through the same topic it is reporting on. A total
  failure of the only email path also prevents this alarm's own email. That case
  is visible only in the CloudWatch console — which is why alarm *state*, not
  just the inbox, is what gets reviewed.

Subscribing at least two confirmed recipients reduces single-mailbox loss within
this one-topic design.

## Confirming the email subscription

**CloudFormation reporting `CREATE_COMPLETE` is not evidence that anything can
be delivered.** An SNS email subscription is created in `PendingConfirmation`
and stays there until a human clicks the link.

1. Deploy with `-c enableAlarms=true -c alarmEmail=<address>`.
2. AWS sends "AWS Notification - Subscription Confirmation" to that address,
   usually within a minute. Check spam.
3. Click **Confirm subscription**.
4. Verify:

   ```bash
   aws sns list-subscriptions-by-topic \
     --topic-arn arn:aws:sns:<region>:<account>:PolisOperationsAlerts \
     --query 'Subscriptions[].[Endpoint,SubscriptionArn]' --output table
   ```

   A confirmed subscription has a real ARN. An unconfirmed one literally reads
   `PendingConfirmation`.
5. Do an end-to-end drill before retiring any existing alert path: set an alarm
   to ALARM by hand (`aws cloudwatch set-alarm-state --alarm-name ... --state-value ALARM
   --state-reason "P-031 delivery drill"`), confirm the email arrives, then set
   it back to `OK` and confirm the recovery email arrives too. Never do this by
   injecting false production metric values.

To add a second recipient, subscribe them to the topic directly — that does not
require a code change, and each new address needs its own confirmation.

## Health pairing, enforced at synth

Some alarms are silent when their publisher dies. `notBreaching` and `ignore`
both hold OK forever if a metric simply stops arriving. Such an alarm is safe
only while a paired **health** alarm — one with `treatMissingData: breaching` —
is enabled to catch the absence.

`cdk/alarms.ts` encodes this as a table and enforces it during synthesis. It
checks more than presence: the health alarm must both treat missing data as
breaching *and* actually notify someone, so a health alarm with its action
removed does not satisfy the pair.

| Silent alarm | Requires one of |
|---|---|
| A02 math publish lag | A03 |
| **A07 free storage** | **A04** or A03 |
| A12 ALB error ratio | A13 |
| A14 overdue CI instances | A15 |

This is why A04 is in slice 1 even though the credit balance has been quiet:
A07's `ignore` is only safe with it. Enabling A07's retarget without A04 fails
`cdk synth` with a message naming both.

## Cost

Roughly **$0.40/month** incremental.

- The selected set is **six metric alarms** — A17, A13, A04, A06, A07, A18 —
  at $0.10 each, so **$0.60** gross. A16 is an EventBridge rule, not a metric
  alarm, and carries no alarm charge; an earlier count wrongly included it.
- A06 and A07 already existed, so only **four are new**: **$0.40 incremental**.
- No new custom metric series, no metric filters, no Lambda, no dashboards, and
  no `GetMetricData` polling.
- SNS email is free under 1,000 notifications/month. EventBridge rules matching
  AWS service events are free, as is the IAM role the rule uses to publish.
- The ten-alarm free tier is already consumed by the account's existing 16
  alarms, so none of the above is discounted.

## Adding the remaining catalog alarms

The full catalog is `cost-reduction/04-plans/P-031-cloudwatch-alarms.md`. Ten
signals are not here, for three distinct reasons — none of them "we ran out of
time".

**Blocked on a publisher that does not exist.** `Polis/Math` and
`Polis/Certification` both returned **zero** metrics from `list-metrics` at the
time of writing. A01–A03 need the math poll-health log event and the publication
sampler; A14–A15 need the CI expiry sweeper to publish. Add the publisher first,
watch the series for a week, then add the alarm.

**Dropped, not deferred.** The Delphi queue-demand alarms (A08–A11, namespace
`Polis/DelphiQueue`) are removed from this catalog. They depended on the P-003 S1
demand-observer Lambda, which will not be built (Colin's 2026-09-08 ruling: no
Lambda in the platform). The queue-demand signal is to come from the Postgres
queue substrate (P-024) and the coordinator's existing `Polis/Math` CloudWatch
metrics instead; the corresponding alarms wait on those metrics, not a Lambda,
and A11's anomaly-row triage moves with them.

**Blocked on validation.** A12 is a metric-math alarm over three sparse ALB
counters. Its expression needs checking against real sparse series, not
arithmetic unit tests, before it can be trusted at low traffic.

**Deliberately not an alarm.** A05 (`CPUSurplusCreditBalance > 0`) fires on
essentially the same event as A04 and announces money already spent, with no
minute-scale action available. It belongs in a periodic cost review.

To add one: extend `cdk/alarms.ts`, give it an explicit `treatMissingData`,
evaluation periods and an `alarmDescription` naming its section in this file,
register it in the `enabled` list so the pair check sees it, and add tests
asserting its metric, dimensions, threshold and missing-data setting. Then add
its first-response section here. An alarm without a first response is a
notification, not monitoring.

## Muting

During authorized maintenance, mute the specific alarm **actions** and record
the restoration step. Never widen a threshold to make an alarm green: the next
person to read it will believe the number.
