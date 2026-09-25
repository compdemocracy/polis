"""Serialized reusable probe lifecycle; no raw data, logging or launch retries."""
from __future__ import annotations
import datetime as dt
import hashlib
import json
import math
import re
import sys
import time
import uuid
from contracts import CAMPAIGN_CEILING_SECONDS, validate_job
from receipt import validate_receipt, decode_receipt, receipt_limit, validate_engine_timeout

LAUNCH_KEYS = ('TEMPLATE', 'TEMPLATE_VERSION', 'PROFILE', 'SUBNET', 'SECURITY_GROUP')
# A worker that ends without a receipt leaves this record in its heartbeat object (worker.py).
FAILURE_SCHEMA = 'polis-probe-failure/1'
BOOT_FAILURE_SCHEMA = 'polis-probe-boot-failure/1'
TOKEN = re.compile(r'[A-Za-z0-9_.-]{1,96}')
# Both launch templates carry exactly two EBS mappings: the root and one private disk.
# EBS attaches after RunInstances returns, so an observation with fewer disks is partial.
DISKS_PER_INSTANCE = 2
# Operator-side bounds, all derived from the one job ceiling in contracts.py so that
# raising the ceiling cannot leave a shorter bound behind to cut a legitimate run short.
# One hour above the longest admissible job: these are sanity bounds on the admission
# window, never the thing that ends a run. A run ends at its own recorded deadline.
BUDGET_MARGIN_SECONDS = 3600
BUDGET_CEILING_SECONDS = CAMPAIGN_CEILING_SECONDS + BUDGET_MARGIN_SECONDS
# The watch loop reconciles the lifecycle on every poll, exactly like status: it can
# publish control and boot records, manage alarms, terminate the owned instance and
# delete owned disks. It must outlast the box it is watching, including the boot
# grace already allowed before a missing heartbeat terminates one (heartbeat_missing).
WATCH_GRACE_SECONDS = 900
WATCH_CEILING_SECONDS = CAMPAIGN_CEILING_SECONDS + WATCH_GRACE_SECONDS
# Incomplete resource transitions are observed again at this cadence.
WATCH_POLL_SECONDS = 30
# Consecutive transient failures a watch absorbs in total (the first plus two
# further observations), whatever operation or category each one hits.
WATCH_TRANSIENT_ATTEMPTS = 3
VOLUME_ID = re.compile(r'vol-[0-9a-z]{1,32}')
INSTANCE_ID = re.compile(r'i-[0-9a-z]{1,32}')
INSTANCE_STATES = ('pending', 'running', 'stopping', 'stopped', 'shutting-down', 'terminated')

# Closed outcome metadata. Every lifecycle failure carries a reason, the operation
# that failed and a disposition set where the cause is known; anything without it
# is a refusal. Terminal diagnostics print only these closed values.
REFUSE, RETRY, PENDING = 'refuse', 'retry', 'pending'
OPERATIONS = frozenset({
    'CONFIG_LOAD', 'CLIENT_SETUP', 'ACTIVE_GET', 'CONTROL_GET', 'HEARTBEAT_HEAD',
    'RECEIPT_GET', 'INSTANCE_DESCRIBE', 'INSTANCE_DESCRIBE_BY_ID', 'VOLUME_DESCRIBE',
    'VOLUME_DESCRIBE_BY_ID', 'CPU_METRIC_READ', 'ALARM_PUT', 'ALARM_DELETE', 'RECORD_PUT',
    'TERMINAL_CAS', 'INSTANCE_TERMINATE', 'VOLUME_DELETE', 'UNKNOWN_OPERATION'})
# The reads a watch may repeat, the alarm calls, and the lifecycle writes whose
# retry is a fresh bound observation that re-derives authority before reissuing
# the same write (never a blind replay). Launch, image lookup, the launch CAS and
# release are absent: they never retry.
RETRYABLE_OPERATIONS = frozenset({
    'ACTIVE_GET', 'CONTROL_GET', 'HEARTBEAT_HEAD', 'RECEIPT_GET', 'INSTANCE_DESCRIBE',
    'INSTANCE_DESCRIBE_BY_ID', 'VOLUME_DESCRIBE', 'VOLUME_DESCRIBE_BY_ID', 'ALARM_PUT',
    'ALARM_DELETE', 'RECORD_PUT', 'TERMINAL_CAS', 'INSTANCE_TERMINATE', 'VOLUME_DELETE',
    'CPU_METRIC_READ'})
REASONS = frozenset({
    'ACTIVE_CHANGED', 'ACTIVE_CONFLICT', 'ADMISSION_EXPIRED', 'ADMISSION_EXPIRED_OR_OVER_BUDGET',
    'ADMISSION_INVALID', 'ALARM_UNKNOWN', 'AUTH_UNAVAILABLE', 'BINDING_CHANGED',
    'CLEAN_RECORD_INVALID', 'CLIENT_SETUP_UNKNOWN', 'CONFIG_UNKNOWN', 'CONFIGURATION_CHANGED',
    'CONTROL_OVERSIZE', 'CONTROL_READ_UNKNOWN', 'CONTROL_SCHEMA', 'DISK_ATTACHMENT_FOREIGN',
    'DISK_DELETE_UNKNOWN', 'DISK_DESCRIBE_EMPTY', 'DISK_DESCRIBE_UNKNOWN',
    'DISK_INVENTORY_UNKNOWN', 'DISK_NOT_DETACHED', 'DISK_REMAINS', 'HEARTBEAT_UNKNOWN',
    'IMAGE_NOT_ADMITTED', 'INSTANCE_CHANGED', 'INSTANCE_DESCRIBE_UNKNOWN',
    'INSTANCE_OWNERSHIP_UNKNOWN', 'INSTANCE_TERMINATE_UNKNOWN', 'LAUNCH_ACK_UNKNOWN',
    'LAUNCH_CONFIGURATION_CHANGED', 'LIVENESS_BINDING', 'LIVENESS_UNKNOWN', 'MODE_CONFLICT',
    'PREVIOUS_RUN_NOT_CLEAN', 'PROVISION_RECEIPT', 'PROVISION_REQUEST', 'RECEIPT_INVALID',
    'RECEIPT_LIMIT', 'RECEIPT_READ_UNKNOWN', 'RECORD_CONFLICT', 'RECORD_WRITE_UNKNOWN',
    'RELEASE_ATTESTATION', 'RELEASE_REFUSED_RUNNING', 'REQUEST_REFUSED', 'RETRY_EXHAUSTED',
    'RUN_CLOSED', 'RUN_CONFLICT', 'TERMINATION_PENDING', 'UNCLASSIFIED', 'UNKNOWN_DISK',
    'WATCH_CEILING'})

# Transient causes, recognised by structured SDK code or exact SDK exception type,
# never by message text. ExpiredToken retries through the SDK's own refreshable
# provider; nothing here constructs clients, logs in or reads credentials.
TRANSIENT_CODES = frozenset({
    'Throttling', 'ThrottlingException', 'ThrottledException', 'RequestLimitExceeded',
    'TooManyRequestsException', 'SlowDown', 'RequestTimeout', 'RequestTimeoutException',
    'InternalError', 'InternalFailure', 'ServiceUnavailable', 'ServiceUnavailableException',
    'ExpiredToken', 'ExpiredTokenException'})
AUTH_CODES = frozenset({
    'InvalidClientTokenId', 'InvalidAccessKeyId', 'SignatureDoesNotMatch', 'IncompleteSignature',
    'InvalidSignatureException', 'UnrecognizedClientException', 'InvalidToken', 'AuthFailure',
    'MissingAuthenticationToken'})
PERMANENT_CODES = frozenset({
    'AccessDenied', 'AccessDeniedException', 'UnauthorizedOperation', 'Forbidden',
    'AllAccessDisabled', 'KMS.AccessDeniedException', 'KMS.DisabledException',
    'KMS.NotFoundException', 'NoSuchBucket', 'InvalidParameterValue', 'ValidationError',
    'MissingParameter', 'InvalidRequest', 'MalformedXML'})
TRANSIENT_STATUS = frozenset({429, 500, 502, 503, 504})
SDK_MODULE = 'botocore.exceptions'
TRANSIENT_SDK_TYPES = frozenset({'ConnectTimeoutError', 'ReadTimeoutError',
                                 'EndpointConnectionError', 'ConnectionClosedError'})
AUTH_SDK_TYPES = frozenset({'UnauthorizedSSOTokenError', 'SSOTokenLoadError', 'NoCredentialsError',
                            'PartialCredentialsError', 'CredentialRetrievalError'})


class Unknown(RuntimeError):
    """A closed lifecycle outcome; str() is the reason code alone."""
    def __init__(self, reason, operation='UNKNOWN_OPERATION', disposition=REFUSE):
        super().__init__(reason)
        self.reason, self.operation, self.disposition = reason, operation, disposition


class InvalidReceipt(Unknown, ValueError):
    """A stored receipt that fails the closed decoder or its binding."""


def error_code(error):
    response = getattr(error, 'response', None)
    detail = response.get('Error') if isinstance(response, dict) else None
    code = detail.get('Code') if isinstance(detail, dict) else None
    return code if type(code) is str else None


def sdk_cause(error):
    """'transient', 'auth' or None (a refusal) from the exception type and the
    structured SDK code/status only. Subclasses of the transport types (SSL,
    proxy) are not transient; unrecognised codes refuse unless the HTTP status
    itself is a throttle/server error and no permanent code is present."""
    kind = type(error)
    if kind.__module__ == SDK_MODULE and kind.__name__ in TRANSIENT_SDK_TYPES:
        return 'transient'
    if any(k.__module__ == SDK_MODULE and k.__name__ in AUTH_SDK_TYPES for k in kind.__mro__):
        return 'auth'
    response = getattr(error, 'response', None)
    if not isinstance(response, dict):
        return None
    code = error_code(error)
    meta = response.get('ResponseMetadata')
    status = meta.get('HTTPStatusCode') if isinstance(meta, dict) else None
    if code in AUTH_CODES:
        return 'auth'
    if code in TRANSIENT_CODES:
        return 'transient'
    if code in PERMANENT_CODES:
        return None
    if type(status) is int and status in TRANSIENT_STATUS:
        return 'transient'
    return None


def sdk_error(reason, operation, error):
    """Classify at the failing call site, before any broad handler erases the cause."""
    kind = sdk_cause(error)
    if kind == 'auth':
        return Unknown('AUTH_UNAVAILABLE', operation)
    retry = kind == 'transient' and operation in RETRYABLE_OPERATIONS
    return Unknown(reason, operation, RETRY if retry else REFUSE)


def volume_id(value):
    return value if type(value) is str and VOLUME_ID.fullmatch(value) else None


def mapped_volumes(instance):
    """The distinct EBS volume IDs of one observation; malformed entries refuse."""
    mappings = instance.get('BlockDeviceMappings', [])
    if not isinstance(mappings, list):
        raise Unknown('DISK_INVENTORY_UNKNOWN', 'INSTANCE_DESCRIBE')
    found = []
    for mapping in mappings:
        if not isinstance(mapping, dict):
            raise Unknown('DISK_INVENTORY_UNKNOWN', 'INSTANCE_DESCRIBE')
        if 'Ebs' not in mapping:
            continue
        ebs = mapping['Ebs']
        vid = volume_id(ebs.get('VolumeId')) if isinstance(ebs, dict) else None
        if vid is None:
            raise Unknown('DISK_INVENTORY_UNKNOWN', 'INSTANCE_DESCRIBE')
        found.append(vid)
    if len(found) != len(set(found)) or len(found) > DISKS_PER_INSTANCE:
        raise Unknown('DISK_INVENTORY_UNKNOWN', 'INSTANCE_DESCRIBE')
    return sorted(found)


def encoded(value: object):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def sha(value: object):
    return hashlib.sha256(encoded(value)).hexdigest()


def known(value, vocabulary):
    return isinstance(value, str) and value in vocabulary


def clean_heartbeat(record):
    """Accept legacy pulses, closed supervisor progress, and failure diagnostics."""
    from vocabulary import STAGES, WORKER_PHASES, PULSE_ERRORS, EXPIRY_BUCKETS
    if not isinstance(record, dict):
        return None
    if ({'stage', 'pulse', 'phase'} <= set(record)
            and set(record) <= {'stage', 'pulse', 'phase', 'last_error', 'credential_expiry'}):
        if (known(record['stage'], STAGES) and known(record['phase'], WORKER_PHASES)
                and type(record['pulse']) is int and 0 < record['pulse'] <= 2**63-1
                and ('last_error' not in record or known(record['last_error'], PULSE_ERRORS))
                and ('credential_expiry' not in record or known(record['credential_expiry'], EXPIRY_BUCKETS))):
            return dict(record)
        return None
    if record.get('schema') != FAILURE_SCHEMA:
        return None
    # Closed vocabularies derived from the reviewed source tree (vocabulary.py):
    # identifier-shaped is not enough, a hostile container could spell into it.
    from vocabulary import Vocabulary, STAGES, LABELS, RELAY, REASON_CODES, FAILURE_TYPES, FAILURE_REASONS
    v = Vocabulary()
    clean = {}
    if known(record.get('stage'), STAGES): clean['stage'] = record['stage']
    if v.class_name(record.get('type')) or known(record.get('type'), FAILURE_TYPES): clean['type'] = record['type']
    if known(record.get('reason'), FAILURE_REASONS): clean['reason'] = record['reason']
    if v.code(record.get('code')): clean['code'] = record['code']
    if isinstance(record.get('aws'), str) and re.fullmatch(r'[A-Za-z0-9.]{1,64}', record['aws']): clean['aws'] = record['aws']
    container = record.get('container')
    if isinstance(container, dict):
        c = {}
        if known(container.get('label'), LABELS): c['label'] = container['label']
        if v.class_name(container.get('class')): c['class'] = container['class']
        if v.code(container.get('code')): c['code'] = container['code']
        if known(container.get('reason'), REASON_CODES): c['reason'] = container['reason']
        if v.slug(container.get('role')): c['role'] = container['role']
        for k, kind in (('exit', int), ('oom', bool), ('rank', int), ('candidates', int)):
            if type(container.get(k)) is kind:
                c[k] = container[k]
        if c.get('label') == 'producer' and c.get('code') == 'ENGINE_DEADLINE_EXCEEDED':
            try:
                context = validate_engine_timeout({k: container.get(k) for k in ('engine', 'recipe', 'elapsed_bucket')})
            except ValueError:
                pass
            else:
                c.update(context)
        clean['container'] = c
    relay = record.get('relay')
    if isinstance(relay, dict):
        clean['relay'] = {k: v_ for k, v_ in relay.items() if k in RELAY and type(v_) is int}
    return clean or None


def clean_pulse_tag(instance):
    from vocabulary import PULSE_TAG
    values = [t.get('Value') for t in instance.get('Tags', []) if t.get('Key') == PULSE_TAG]
    if len(values) != 1 or not isinstance(values[0], str) or len(values[0]) > 160:
        return None
    parts = values[0].split(':')
    if len(parts) not in (3, 4) or not re.fullmatch(r'[1-9][0-9]{0,18}', parts[0]):
        return None
    body = {'pulse': int(parts[0]), 'stage': parts[1], 'phase': parts[2]}
    if len(parts) == 4:
        body['last_error'] = parts[3]
    return clean_heartbeat(body)


def clean_boot_failure(record):
    from boot_report import PHASES, EXITS, SCHEMA
    if (type(record) is dict and set(record) == {'schema', 'phase', 'exit'}
            and record['schema'] == SCHEMA and known(record['phase'], PHASES)
            and known(record['exit'], EXITS)):
        return {'stage': 'boot', 'phase': record['phase'], 'exit': record['exit']}
    return None


def clean_boot_tag(instance):
    from boot_report import SCHEMA
    from vocabulary import PULSE_TAG
    values = [t.get('Value') for t in instance.get('Tags', []) if t.get('Key') == PULSE_TAG]
    if len(values) != 1 or type(values[0]) is not str or len(values[0]) > 96:
        return None
    parts = values[0].split(':')
    if len(parts) != 3 or parts[0] != 'boot-failure':
        return None
    return clean_boot_failure({'schema': SCHEMA, 'phase': parts[1], 'exit': parts[2]})


class Control:
    def __init__(self, ec2: object, s3: object, cfg: object, now: object = None, monitoring=None):
        self.ec2, self.s3, self.c = ec2, s3, cfg
        self.monitoring = monitoring
        self.a = json.loads(cfg["ADMISSION"])
        self.clock = time.time if now is None else (now if callable(now) else lambda: now)
        self.now = self.clock()
        if sha(self.a) != cfg["ADMISSION_SHA256"]:
            raise Unknown("ADMISSION_INVALID")
        if self.a.get('launch') != {key: cfg[key] for key in LAUNCH_KEYS}:
            raise Unknown('LAUNCH_CONFIGURATION_CHANGED')
        self.expiry = dt.datetime.fromisoformat(self.a["expiresAt"].replace("Z", "+00:00")).timestamp()
        self.token = self.c["ADMISSION_SHA256"]
        self.prefix = f'control/{self.a["id"]}/'

    def read(self, key: object):
        try:
            obj = self.s3.get_object(Bucket=self.c["CONTROL_BUCKET"], Key=key)
            # A body stream error belongs to the GetObject that opened it.
            raw = obj["Body"].read(65537)
        except Exception as e:
            if error_code(e) == "NoSuchKey":
                return None
            raise sdk_error("CONTROL_READ_UNKNOWN", "CONTROL_GET", e) from None
        if len(raw) > 65536:
            raise Unknown("CONTROL_OVERSIZE", "CONTROL_GET")
        return json.loads(raw)

    def record(self, key: object, value: object):
        """Create-only, including after lost acknowledgement. No hidden overwrite.

        Exact readback equality resolves a lost acknowledgement (or the same
        write by another authorized actor). A different stored value is a
        conflict. An absent value keeps the write's own cause: a transient
        one is retried by a fresh observation, a permanent one refuses."""
        try:
            self.s3.put_object(Bucket=self.c["CONTROL_BUCKET"], Key=key, Body=encoded(value),
                               IfNoneMatch="*", ServerSideEncryption="aws:kms", SSEKMSKeyId=self.c["CONTROL_KEY"])
        except Exception as e:
            failure = sdk_error("RECORD_WRITE_UNKNOWN", "RECORD_PUT", e)
            # Only a transient or conflict write may take a new observation from
            # a failed readback; a permanent or auth cause is kept unless exact
            # readback equality proves the write completed.
            admissible = failure.disposition == RETRY or error_code(e) in ("PreconditionFailed", "ConditionalRequestConflict")
            try:
                stored = self.read(key)
            except Exception:
                if admissible:
                    raise
                raise failure from None
            if stored == value:
                return
            if stored is None:
                raise failure from None
            raise Unknown("RECORD_CONFLICT", "RECORD_PUT") from None

    def own(self, i: object):
        c, a = self.c, self.a
        # DescribeInstances drops SubnetId, SecurityGroups and IamInstanceProfile
        # once an instance is terminated (observed on the first real run) and
        # already while it is shutting down (run 22: the worker powers off after
        # its receipt and the next watch poll saw the instance in transition);
        # those fields are required while present. The client token (the
        # admission digest), image, type and both tags are always required.
        # Unknown or missing lifecycle states are never owned.
        state = i.get("State", {}).get("Name")
        terminated = state in ("shutting-down", "terminated")
        groups = {g["GroupId"] for g in i.get("SecurityGroups", [])}
        return (state in INSTANCE_STATES
                and i.get("ClientToken") == self.token
                # DescribeInstances has no LaunchTemplate field. The exact
                # template/version live in the durable admission bound by this
                # client token; verify the observable instance fields below.
                and not i.get("PublicIpAddress")
                and (groups == {c["SECURITY_GROUP"]} or (terminated and not groups))
                and ((i.get("IamInstanceProfile") or {}).get("Arn") == c["PROFILE"]
                     or (terminated and not i.get("IamInstanceProfile")))
                and i.get("ImageId") == a["ami"]
                and (i.get("SubnetId") == c["SUBNET"] or (terminated and not i.get("SubnetId")))
                and i.get("InstanceType") == c["INSTANCE_TYPE"]
                and {t["Key"]: t["Value"] for t in i.get("Tags", [])}.get("polis:probe-run") == a["id"]
                and {t["Key"]: t["Value"] for t in i.get("Tags", [])}.get("polis:probe-box") == c["BOX_ID"])

    def instances(self):
        found = []
        try:
            for page in self.ec2.get_paginator("describe_instances").paginate(Filters=[
                {"Name": "client-token", "Values": [self.token]},
            ]):
                for reservation in page["Reservations"]:
                    found.extend(reservation["Instances"])
        except Exception as e:
            raise sdk_error("INSTANCE_DESCRIBE_UNKNOWN", "INSTANCE_DESCRIBE", e) from None
        if any(not self.own(i) for i in found) or len(found) > 1:
            raise Unknown("INSTANCE_OWNERSHIP_UNKNOWN", "INSTANCE_DESCRIBE")
        return found

    def observe(self):
        """The owned instance, or None. DescribeInstances stops listing an
        instance about an hour after termination; for an instance this tool
        recorded, "no longer exists" is stronger than "terminated" and is
        reported as a terminated instance with no disks."""
        instances = self.instances()
        if instances:
            return instances[0]
        prior = self.read(self.prefix + "instance.json")
        if not prior:
            return None
        if (not isinstance(prior, dict) or type(prior.get("id")) is not str
                or not INSTANCE_ID.fullmatch(prior["id"])):
            raise Unknown("INSTANCE_CHANGED", "CONTROL_GET")
        try:
            response = self.ec2.describe_instances(InstanceIds=[prior["id"]])
        except Exception as e:
            # Absence has this narrow meaning only on the recorded by-ID lookup.
            if error_code(e) != "InvalidInstanceID.NotFound":
                raise sdk_error("INSTANCE_DESCRIBE_UNKNOWN", "INSTANCE_DESCRIBE_BY_ID", e) from None
            found = []
        else:
            found = [i for r in response["Reservations"] for i in r["Instances"]]
        if found:
            if len(found) != 1 or not self.own(found[0]):
                raise Unknown("INSTANCE_OWNERSHIP_UNKNOWN", "INSTANCE_DESCRIBE_BY_ID")
            return found[0]
        return {"InstanceId": prior["id"], "State": {"Name": "terminated"}, "BlockDeviceMappings": [], "gone": True}

    def inventory(self, iid):
        """The recorded disposal inventory P, validated against the bound run and
        the observed instance before any mapping is treated as partial. Missing
        is None; a wrong binding or an incomplete/duplicate/malformed inventory
        refuses and is never repaired by guessing."""
        prior = self.read(self.prefix + "instance.json")
        if prior is None:
            return None
        if (not isinstance(prior, dict) or prior.get("id") != iid
                or prior.get("admissionSha256") != self.token):
            raise Unknown("INSTANCE_CHANGED", "CONTROL_GET")
        volumes = prior.get("volumes")
        if (set(prior) != {"id", "volumes", "admissionSha256"} or not isinstance(volumes, list)
                or len(volumes) != DISKS_PER_INSTANCE or any(volume_id(v) is None for v in volumes)
                or len(set(volumes)) != DISKS_PER_INSTANCE):
            raise Unknown("DISK_INVENTORY_UNKNOWN", "CONTROL_GET")
        return prior

    def clean_record(self, clean, prior):
        """clean.json proves resource cleanup only when its status, admission
        digest, instance ID and complete inventory match the bound run's record."""
        ok = (isinstance(clean, dict) and isinstance(prior, dict)
              and clean.get("status") == "CLEAN" and clean.get("admissionSha256") == self.token
              and prior.get("admissionSha256") == self.token
              and type(clean.get("instanceId")) is str and clean.get("instanceId") == prior.get("id"))
        if ok:
            volumes, recorded = clean.get("volumes"), prior.get("volumes")
            ok = (isinstance(volumes, list) and len(volumes) == DISKS_PER_INSTANCE
                  and all(volume_id(v) for v in volumes) and len(set(volumes)) == DISKS_PER_INSTANCE
                  and isinstance(recorded, list) and all(volume_id(v) for v in recorded))
        if ok:
            base = {"admissionSha256", "instanceId", "volumes", "status"}
            if clean.get("attested") is True:
                # The manual release closes an incomplete recorded inventory
                # against an operator-attested complete set.
                ok = set(clean) == base | {"attested"} and set(recorded) <= set(volumes)
            else:
                ok = set(clean) - {"heartbeat"} == base and volumes == recorded
        if not ok:
            raise Unknown("CLEAN_RECORD_INVALID", "CONTROL_GET")
        return clean

    def launch_once(self):
        # Guards the launch: refuse an admission already expired, or one whose window is
        # longer than any job the contract admits plus margin (a forged or stale expiry).
        if self.now >= self.expiry or self.expiry - self.now > BUDGET_CEILING_SECONDS:
            raise Unknown("ADMISSION_EXPIRED_OR_OVER_BUDGET")
        if self.read(self.prefix + "clean.json") or self.read(self.prefix + "cancel.json"):
            raise Unknown("RUN_CLOSED")
        image = self.ec2.describe_images(ImageIds=[self.a["ami"]])["Images"]
        if len(image) != 1 or image[0].get("Architecture") != "arm64" or image[0].get("State") != "available" or image[0].get("OwnerId") != self.a["account"]:
            raise Unknown("IMAGE_NOT_ADMITTED")
        self.now = self.clock()
        if self.now >= self.expiry:
            raise Unknown("ADMISSION_EXPIRED")
        self.record(self.prefix + "claim.json", {"admissionSha256": self.token, "started": self.a["started"]})
        # Body contains only fixed template and token. Caller cannot supply overrides.
        self.ec2.run_instances(LaunchTemplate={"LaunchTemplateId": self.c["TEMPLATE"], "Version": self.c["TEMPLATE_VERSION"]},
                               MinCount=1, MaxCount=1, ClientToken=self.token,
                               TagSpecifications=[{"ResourceType": kind,"Tags":[{"Key":"polis:probe-box","Value":self.c["BOX_ID"]},{"Key":"polis:probe-run","Value":self.a["id"]}]} for kind in ("instance","volume")])
        return self.reconcile()

    def heartbeat_missing(self, instance: object, claim: object):
        if self.c['MODE'] == 'provision':
            return False
        if self.now - claim["started"] < 600:
            return False  # bounded boot grace, included in the campaign ceiling
        arn = f'arn:aws:ec2:{self.a["region"]}:{self.a["account"]}:instance/{instance["InstanceId"]}'
        try:
            obj = self.s3.head_object(Bucket=self.c["CONTROL_BUCKET"], Key=f'heartbeats/{self.a["id"]}/{arn}.json')
            return self.now - obj["LastModified"].timestamp() > 300
        except Exception as e:
            if error_code(e) in ("404", "NoSuchKey", "NotFound"):
                return True
            raise sdk_error("HEARTBEAT_UNKNOWN", "HEARTBEAT_HEAD", e) from None

    def cpu_activity(self, iid):
        """Only a fresh, finite EC2 CPU sample can establish busy or quiet.

        A successful response without such a sample is 'unknown' (insufficient
        evidence). A failed or malformed read is also 'unknown' here, but its
        classified cause is kept in cpu_error and raised by the caller before
        any other liveness evidence is weighed, so it is never pending."""
        self.cpu_error = None
        if self.monitoring is None:
            return 'unknown'
        try:
            result = self.monitoring.get_metric_statistics(Namespace='AWS/EC2',
                MetricName='CPUUtilization', Dimensions=[{'Name': 'InstanceId', 'Value': iid}],
                StartTime=dt.datetime.fromtimestamp(self.now-300, dt.timezone.utc),
                EndTime=dt.datetime.fromtimestamp(self.now, dt.timezone.utc),
                Period=60, Statistics=['Average'])
        except Exception as e:
            self.cpu_error = sdk_error('LIVENESS_UNKNOWN', 'CPU_METRIC_READ', e)
            return 'unknown'
        try:
            values = []
            for point in result['Datapoints']:
                stamp, value = point.get('Timestamp'), point.get('Average')
                if (isinstance(stamp, dt.datetime) and stamp.tzinfo is not None
                        and self.now-300 <= stamp.timestamp() <= self.now
                        and type(value) in (float, int) and math.isfinite(value) and 0 <= value <= 100):
                    values.append(value)
            return ('busy' if max(values) > 2 else 'quiet') if values else 'unknown'
        except Exception:
            # A malformed response is a schema failure, not missing evidence.
            self.cpu_error = Unknown('LIVENESS_UNKNOWN', 'CPU_METRIC_READ')
            return 'unknown'

    def secondary_liveness(self, instance):
        """Positive fallback evidence defers a missing-S3 kill until run expiry.

        A first tag is only a baseline (possibly stale). Allow two pulse periods
        to observe advancement. Both observations survive operator restarts.
        Unavailable monitoring is uncertainty, never proof of an idle machine.
        """
        iid = instance['InstanceId']
        binding = {'admissionSha256': self.token, 'instanceId': iid}
        def read_bound(name):
            record = self.read(self.prefix+name)
            if record is not None:
                fields = set(binding) | {'observedAt', 'pulse'}
                if name == 'liveness.json':
                    fields |= {'schema', 'cpu', 'tag'}
                if (not isinstance(record, dict) or set(record) != fields
                        or any(record.get(k) != v for k, v in binding.items())
                        or type(record.get('observedAt')) is not int
                        or not self.a['started'] <= record['observedAt'] <= self.now
                        or (record.get('pulse') is not None
                            and clean_heartbeat(record['pulse']) != record['pulse'])):
                    raise Unknown('LIVENESS_BINDING')
                if name == 'liveness.json':
                    if (record['schema'] != 'polis-probe-liveness/1'
                            or not known(record['cpu'], {'busy', 'quiet', 'unknown'})
                            or not known(record['tag'], {'advanced', 'unchanged', 'absent'})
                            or not (record['cpu'] == 'busy' or record['tag'] == 'advanced')
                            or (record['tag'] != 'absent' and not record['pulse'])):
                        raise Unknown('LIVENESS_BINDING')
                elif not record['pulse']:
                    raise Unknown('LIVENESS_BINDING')
            return record
        saved = read_bound('liveness.json')
        if saved is not None:
            return True
        pulse = clean_pulse_tag(instance)
        baseline = read_bound('liveness-baseline.json')
        tag = 'absent'
        if pulse:
            if baseline is None:
                self.record(self.prefix+'liveness-baseline.json',
                    {**binding, 'observedAt': int(self.now), 'pulse': pulse})
                baseline = read_bound('liveness-baseline.json')
            tag = 'advanced' if pulse['pulse'] > baseline['pulse']['pulse'] else 'unchanged'
        cpu = self.cpu_activity(iid)
        if self.cpu_error is not None:
            # An attempted read that failed keeps its own classification
            # (refusal, auth, or a bounded transient retry) before any pulse
            # evidence or baseline grace is considered. It never kills.
            raise self.cpu_error
        if tag == 'advanced' or cpu == 'busy':
            self.record(self.prefix+'liveness.json', {**binding,
                'schema': 'polis-probe-liveness/1', 'observedAt': int(self.now),
                'cpu': cpu, 'tag': tag, 'pulse': pulse})
            return True
        if baseline is not None and self.now-baseline['observedAt'] < 120:
            return True
        if cpu == 'unknown':
            # A successful read with too little fresh evidence is pending and
            # never kills; expiry and cancel still terminate through reconcile.
            raise Unknown('LIVENESS_UNKNOWN', 'CPU_METRIC_READ', PENDING)
        return False

    def reconcile(self, cancel: object = False):
        claim = self.read(self.prefix + "claim.json")
        clean = self.read(self.prefix + "clean.json")
        if clean is not None:
            # A present record is proof only after it is validated against the run.
            self.clean_record(clean, self.read(self.prefix + "instance.json"))
            return {"status": "CLEAN", "admissionId": self.a["id"]}
        if cancel:
            self.record(self.prefix + "cancel.json", {"admissionSha256": self.token})
        # Guards a claim outliving its admission: a box older than any admissible job plus
        # margin is expired even if its recorded expiry says otherwise.
        expired = self.now >= self.expiry or (claim and self.now - claim["started"] >= BUDGET_CEILING_SECONDS)
        cancelled = bool(self.read(self.prefix + "cancel.json"))
        if not claim:
            # An INTENT may precede claim creation or the actual launch call.
            # No observation can prove that its actor will never resume.
            raise Unknown("LAUNCH_ACK_UNKNOWN")
        i = self.observe()
        if i is None:
            raise Unknown("LAUNCH_ACK_UNKNOWN")
        iid, state = i["InstanceId"], i["State"]["Name"]
        # Every mapping and the recorded inventory P are validated before any
        # mutation in this observation. V is compared with P as a set.
        volume_ids = mapped_volumes(i)
        prior = self.inventory(iid)
        if prior and not set(volume_ids) <= set(prior["volumes"]):
            raise Unknown("INSTANCE_CHANGED", "INSTANCE_DESCRIBE")
        if state in ("shutting-down", "terminated"):
            # Disks detach as the instance goes away: V may be any subset of a
            # complete bound P, including empty. The first disposal inventory is
            # never recorded from a shutting-down or terminated response.
            if not prior:
                raise Unknown("DISK_INVENTORY_UNKNOWN", "CONTROL_GET")
            self.record_boot_failure(i)
            if state == "shutting-down":
                # Incomplete: no boot object, second termination, disk deletion or clean record.
                return {"status": "TERMINATION_PENDING", "admissionId": self.a["id"], "state": state}
            return self.dispose(iid, prior)
        if state in ("stopping", "stopped") and prior and set(volume_ids) != set(prior["volumes"]):
            # Stopped disks stay attached; shutdown exceptions do not apply.
            raise Unknown("INSTANCE_CHANGED", "INSTANCE_DESCRIBE")
        # RunInstances reconciliation may see both disks before the immediate
        # status read sees only a subset. Keep the complete disposal inventory;
        # only that owned subset may be treated as a partial attachment view.
        attaching = state in ("pending", "running") and len(volume_ids) < DISKS_PER_INSTANCE
        if not prior and not attaching:
            if len(volume_ids) != DISKS_PER_INSTANCE:
                raise Unknown("DISK_INVENTORY_UNKNOWN", "INSTANCE_DESCRIBE")
            self.record(self.prefix + "instance.json", {"id": iid, "volumes": volume_ids, "admissionSha256": self.token})
            prior = self.inventory(iid)
        self.record_boot_failure(i)
        if expired or cancelled or (self.heartbeat_missing(i, claim)
                                   and not self.secondary_liveness(i)):
            # Preserve the final observation BEFORE termination can destroy it.
            # CLEAN still means observed instance/disks gone, never a kill ACK.
            key = self.prefix + 'termination.json'
            if self.c['MODE'] == 'worker' and not self.read(key):
                arn = f'arn:aws:ec2:{self.a["region"]}:{self.a["account"]}:instance/{iid}'
                try:
                    raw = self.read(f'heartbeats/{self.a["id"]}/{arn}.json')
                    heartbeat = clean_heartbeat(raw)
                    if heartbeat and raw.get('schema') == FAILURE_SCHEMA:
                        heartbeat = {'schema': FAILURE_SCHEMA, **heartbeat}
                    elif raw == {}:
                        heartbeat = {}
                except (Unknown, ValueError, TypeError):
                    heartbeat = None
                self.record(key, {'admissionSha256': self.token, 'instanceId': iid,
                                  'heartbeat': heartbeat})
            try:
                self.ec2.terminate_instances(InstanceIds=[iid])
            except Exception as e:
                # A retry is a fresh observation that re-derives this authority.
                raise sdk_error("INSTANCE_TERMINATE_UNKNOWN", "INSTANCE_TERMINATE", e) from None
            # Observe on a later sweep; do not call accepted termination CLEAN.
            raise Unknown("TERMINATION_PENDING", "INSTANCE_TERMINATE", PENDING)
        if attaching:
            # Never publish a partial disposal inventory or boot object.
            return {"status": "ATTACHING", "admissionId": self.a["id"], "state": state}
        boot = {"admission": self.a, "admissionSha256": self.token, "instanceId": iid,
                "template": self.c["TEMPLATE"], "templateVersion": self.c["TEMPLATE_VERSION"],
                "evidenceBucket": self.c["EVIDENCE_BUCKET"], "assetBucket": self.c["ASSET_BUCKET"],
                "secretArn": self.c["SECRET_ARN"], "replicaHost": self.c["REPLICA_HOST"],
                "database": self.c["DATABASE"], "secretsUrl": self.c["SECRETS_URL"],
                "controlBucket": self.c["CONTROL_BUCKET"], "evidenceKey": self.c["CONTROL_KEY"],
                "endpoint": self.c["ENDPOINT"], "started": claim["started"],
                "terminateBy": self.expiry}
        if self.c['MODE'] == 'provision':
            boot['provision'] = self.a['provision']
            boot['adminSecretArn'] = self.c['ADMIN_SECRET_ARN']
            boot['owner'] = self.c['PROVISION_OWNER']
        self.record(f'boot/{self.c["MODE"]}/arn:aws:ec2:{self.a["region"]}:{self.a["account"]}:instance/{iid}.json', boot)
        return {"status": "RUNNING", "admissionId": self.a["id"], "state": state}

    def record_boot_failure(self, i):
        failure = clean_boot_tag(i)
        if failure and self.c['MODE'] == 'worker':
            self.record(self.prefix+'boot-failure.json', {
                'admissionSha256': self.token, 'instanceId': i["InstanceId"], 'failure': failure})

    def present(self, recorded, iid):
        """Recorded disks still observable by ID. Only an explicit
        InvalidVolume.NotFound is absence; an empty success is not."""
        found = {}
        for vid in recorded:
            try:
                response = self.ec2.describe_volumes(VolumeIds=[vid])
            except Exception as e:
                if error_code(e) == "InvalidVolume.NotFound":
                    continue
                raise sdk_error("DISK_DESCRIBE_UNKNOWN", "VOLUME_DESCRIBE_BY_ID", e) from None
            volumes = response.get("Volumes") if isinstance(response, dict) else None
            if volumes == []:
                raise Unknown("DISK_DESCRIBE_EMPTY", "VOLUME_DESCRIBE_BY_ID")
            if (not isinstance(volumes, list) or len(volumes) != 1 or not isinstance(volumes[0], dict)
                    or volumes[0].get("VolumeId") != vid):
                raise Unknown("DISK_DESCRIBE_UNKNOWN", "VOLUME_DESCRIBE_BY_ID")
            self.attached_here(volumes[0], iid)
            found[vid] = volumes[0]
        return found

    @staticmethod
    def attached_here(volume, iid):
        """A disk attached to any other instance, or with a malformed attachment,
        is a hard refusal even when tagged for this run."""
        attachments = volume.get("Attachments", [])
        if (not isinstance(attachments, list)
                or any(not isinstance(a, dict) or a.get("InstanceId") != iid for a in attachments)):
            raise Unknown("DISK_ATTACHMENT_FOREIGN", "VOLUME_DESCRIBE")
        return bool(attachments)

    def dispose(self, iid, prior):
        """Terminated or gone: delete only recorded, detached, available disks and
        close only after each recorded ID is explicitly absent by ID."""
        recorded = prior["volumes"]
        tagged = []
        try:
            # Include tagged unexpected disks, but never delete on tag alone.
            for page in self.ec2.get_paginator("describe_volumes").paginate(Filters=[{"Name": "tag:polis:probe-run", "Values": [self.a["id"]]}]):
                tagged.extend(page["Volumes"])
        except Exception as e:
            raise sdk_error("DISK_DESCRIBE_UNKNOWN", "VOLUME_DESCRIBE", e) from None
        observed = {}
        for v in tagged:
            vid = volume_id(v.get("VolumeId")) if isinstance(v, dict) else None
            if vid is None or vid in observed:
                raise Unknown("DISK_INVENTORY_UNKNOWN", "VOLUME_DESCRIBE")
            if vid not in recorded:
                raise Unknown("UNKNOWN_DISK", "VOLUME_DESCRIBE")
            self.attached_here(v, iid)
            observed[vid] = v
        # Independently query the actual IDs too; missing/changed tags cannot hide disks.
        observed.update(self.present(recorded, iid))
        # Nothing is deleted in an observation until every disk in it has passed.
        busy = [v for v in observed.values() if v.get("Attachments") or v.get("State") != "available"]
        if busy:
            deleting = all(v.get("State") == "deleting" and not v.get("Attachments") for v in busy)
            raise Unknown("DISK_REMAINS" if deleting else "DISK_NOT_DETACHED", "VOLUME_DESCRIBE", PENDING)
        for vid in sorted(observed):
            try:
                self.ec2.delete_volume(VolumeId=vid)
            except Exception as e:
                code = error_code(e)
                if code == "InvalidVolume.NotFound":
                    continue
                if code == "VolumeInUse":
                    # Pending only when a fresh read proves the attachment is to
                    # the bound instance; foreign or unknown attachment refuses.
                    fresh = self.present([vid], iid)
                    if vid in fresh and fresh[vid].get("Attachments"):
                        raise Unknown("DISK_NOT_DETACHED", "VOLUME_DELETE", PENDING) from None
                    raise Unknown("DISK_DELETE_UNKNOWN", "VOLUME_DELETE") from None
                raise sdk_error("DISK_DELETE_UNKNOWN", "VOLUME_DELETE", e) from None
        # A delete acknowledgement is not absence: re-observe every recorded ID.
        if observed and self.present(recorded, iid):
            raise Unknown("DISK_REMAINS", "VOLUME_DESCRIBE_BY_ID", PENDING)
        clean = {"admissionSha256": self.token, "instanceId": iid,
                 "volumes": prior["volumes"], "status": "CLEAN"}
        termination = self.read(self.prefix + 'termination.json')
        if termination:
            if termination.get('admissionSha256') != self.token or termination.get('instanceId') != iid:
                raise Unknown('INSTANCE_CHANGED', 'CONTROL_GET')
            clean['heartbeat'] = termination['heartbeat']
        self.record(self.prefix + "clean.json", clean)
        return {"status": "CLEAN", "admissionId": self.a["id"]}



class Session:
    """Operator-owned durable register. No launch retry, expiry-based lock theft,
    background service or credential handling. SDK clients are injected for tests.
    """
    def __init__(self, ec2, s3, cfg, clock=time.time, monitoring=None):
        self.ec2, self.s3, self.cfg, self.clock = ec2, s3, cfg, clock
        self.monitoring = monitoring

    def active(self):
        try:
            obj = self.s3.get_object(Bucket=self.cfg['CONTROL_BUCKET'], Key='active.json')
            # A body stream error belongs to the GetObject that opened it.
            raw = obj['Body'].read(65537)
            etag = obj.get('ETag')
        except Exception as error:
            if error_code(error) == 'NoSuchKey':
                return None, None
            raise sdk_error('CONTROL_READ_UNKNOWN', 'ACTIVE_GET', error) from None
        if len(raw) > 65536:
            raise Unknown('CONTROL_OVERSIZE', 'ACTIVE_GET')
        try:
            state = json.loads(raw)
        except ValueError:
            raise Unknown('CONTROL_SCHEMA', 'ACTIVE_GET') from None
        if (not isinstance(state, dict) or set(state) != {'generation', 'admission', 'phase', 'nonce'}
                or state['phase'] not in ('RESERVED', 'INTENT', 'CLEAN')
                or not isinstance(state['generation'], str) or len(state['generation']) != 32
                or not isinstance(state['admission'], dict) or not etag):
            raise Unknown('CONTROL_SCHEMA', 'ACTIVE_GET')
        return state, etag

    @staticmethod
    def binding(state):
        """What a watch owns: run, generation, admission and configuration digests."""
        a = state['admission']
        return dict(run=a.get('id'), generation=state['generation'], admission=sha(a),
                    configuration=a.get('configSha256'))

    def bind(self, state, bound):
        current = self.binding(state)
        if bound is None:
            return current
        if not bound:
            bound.update(current)
        elif bound != current:
            raise Unknown('BINDING_CHANGED', 'ACTIVE_GET')
        return bound

    def cas(self, old_etag, value):
        condition = {'IfMatch': old_etag} if old_etag else {'IfNoneMatch': '*'}
        try:
            self.s3.put_object(Bucket=self.cfg['CONTROL_BUCKET'], Key='active.json',
                Body=encoded(value), ServerSideEncryption='aws:kms',
                SSEKMSKeyId=self.cfg['CONTROL_KEY'], **condition)
        except Exception:
            # The random nonce belongs only to this invocation. Readback can
            # resolve its lost acknowledgement, but cannot confer another permit.
            actual, _ = self.active()
            if actual != value:
                raise Unknown('ACTIVE_CONFLICT') from None
        actual, etag = self.active()
        if actual != value:
            raise Unknown('ACTIVE_CHANGED')
        return etag

    def control(self, state):
        a = state['admission']
        # Every operational input is bound; a different stack/config cannot
        # reconcile or release a previous installation's run.
        if a['configSha256'] != sha(self.cfg):
            raise Unknown('CONFIGURATION_CHANGED')
        return Control(self.ec2, self.s3, dict(self.cfg, ADMISSION=encoded(a).decode(),
                       ADMISSION_SHA256=sha(a)), self.clock, monitoring=self.monitoring)

    def start(self, job):
        job = validate_job(job)
        if self.cfg['MODE'] != 'worker':
            raise Unknown('MODE_CONFLICT')
        return self.start_request(job['run_id'], {'job':job}, job['max_seconds'])

    def start_provision(self, request):
        import re
        if (self.cfg['MODE'] != 'provision' or set(request) != {'run_id','adminVersion','readerVersion'}
                or not re.fullmatch('[a-f0-9]{32}', request['run_id'])
                or any(not re.fullmatch('[A-Za-z0-9-]{32,64}', request[k]) for k in ('adminVersion','readerVersion'))):
            raise Unknown('PROVISION_REQUEST')
        return self.start_request(request['run_id'], {'provision':request}, 900)

    def start_request(self, run_id, payload, max_seconds):
        state, etag = self.active()
        if state and state['admission']['id'] == run_id:
            if any(state['admission'].get(k) != v for k,v in payload.items()):
                raise Unknown('RUN_CONFLICT')
            self.control(state)
            if state['phase'] == 'CLEAN':
                raise Unknown('RUN_CLOSED')
        else:
            if state and state['phase'] != 'CLEAN':
                raise Unknown('PREVIOUS_RUN_NOT_CLEAN')
            now = int(self.clock())
            a = dict(id=run_id, **payload, ami=self.cfg['AMI'],
                     account=self.cfg['ACCOUNT'], region=self.cfg['REGION'],
                     launch={k: self.cfg[k] for k in LAUNCH_KEYS}, started=now,
                     configSha256=sha(self.cfg),
                     expiresAt=dt.datetime.fromtimestamp(now+max_seconds,dt.timezone.utc).isoformat())
            state = dict(generation=uuid.uuid4().hex, admission=a, phase='RESERVED', nonce=uuid.uuid4().hex)
            c = self.control(state)
            # A run ID is permanently single-use, including losing contenders.
            c.record('claims/'+run_id+'.json', state)
            etag = self.cas(etag, state)
        if state['phase'] == 'RESERVED':
            permit = dict(state, phase='INTENT', nonce=uuid.uuid4().hex)
            self.cas(etag, permit)
            # Only the successful INTENT CAS invocation may reach this call.
            # Both SDK and application retries must be disabled for EC2 launch.
            self.control(permit).launch_once()
        return self.status(run_id)

    def status(self, run_id, cancel=False, bound=None):
        """One bound lifecycle observation. Not read-only: it reconciles, and so
        can publish control/boot records, manage alarms, terminate the owned
        instance and delete owned disks. A watch passes the same `bound` dict to
        every poll; it is filled from the first valid register and every later
        register must match it. Nothing mutates before that binding succeeds."""
        state, etag = self.active()
        if not state or state['admission'].get('id') != run_id:
            raise Unknown('RUN_CONFLICT', 'ACTIVE_GET')
        c = self.control(state)
        bound = self.bind(state, bound)
        if state['phase'] == 'RESERVED':
            if not cancel:
                return dict(run_id=run_id, complete=False, passed=False)
            # CAS defeats any stale RESERVED -> INTENT actor. No launch permit
            # ever existed for this generation, so cancellation may close it.
            self.cas(etag, dict(state, phase='CLEAN', nonce=uuid.uuid4().hex))
            return dict(run_id=run_id, complete=True, passed=False)
        if state['phase'] != 'CLEAN':
            # Reconcile first: an alarm failure can never hide expiry or cleanup.
            result = c.reconcile(cancel=cancel)
            if result['status'] != 'CLEAN':
                # Alarms only for an admitted pending/running instance; never
                # for one shutting down or gone, nor once clean.json exists.
                if result.get('state') in ('pending', 'running'):
                    self.put_alarms(c)
                return dict(run_id=run_id, complete=False, passed=False)
            # Alarm deletion is lifecycle cleanup and precedes the terminal CAS.
            self.delete_alarms(c)
            self.close(c, state, etag, bound)
        else:
            # A CLEAN register is not itself cleanup proof. A run that recorded
            # an instance needs its validated cleanup record (resource or
            # attested release); only a run that never recorded one (a
            # RESERVED cancel) has none to show, and then no clean record may
            # exist either. It still owes the same exact alarm deletion.
            owned = c.read(c.prefix + 'instance.json')
            clean = c.read(c.prefix + 'clean.json')
            if owned is not None or clean is not None:
                c.clean_record(clean, owned)
            self.delete_alarms(c)
        passed = False
        failure = None
        public_defaults = None
        owned = c.read(c.prefix+'instance.json')
        if owned:
            arn = f'arn:aws:ec2:{c.a["region"]}:{c.a["account"]}:instance/{owned["id"]}'
            provision = self.cfg['MODE'] == 'provision'
            # The admitted job (or provisioning) fixes the ceiling before any read.
            limit = 131072 if provision else receipt_limit(c.a['job'])
            try:
                obj = self.s3.get_object(Bucket=self.cfg['CONTROL_BUCKET'] if provision else self.cfg['EVIDENCE_BUCKET'],
                    Key=f'provision-results/{arn}.json' if provision else f'results/{arn}/receipt.json')
                # A body stream error belongs to the GetObject that opened it.
                raw = obj['Body'].read(limit + 1)
            except Exception as error:
                if error_code(error) != 'NoSuchKey':
                    raise sdk_error('RECEIPT_READ_UNKNOWN', 'RECEIPT_GET', error) from None
                if not provision:
                    failure = self.failure(c, arn)
            else:
                if len(raw) > limit:
                    raise Unknown('RECEIPT_LIMIT')
                if provision:
                    from provision_login import validate_public_defaults
                    try:
                        receipt = json.loads(raw)
                        if type(receipt) is not dict:
                            raise ValueError('PROVISION_RECEIPT')
                        version = receipt.get('schema')
                        fields = {'schema','admissionSha256','success'}
                        if version == 'polis-probe-provision/2':
                            fields.add('public_defaults')
                            public_defaults = validate_public_defaults(receipt.get('public_defaults'))
                            if receipt.get('success') is not True and public_defaults:
                                raise ValueError('PROVISION_RECEIPT')
                        elif version != 'polis-probe-provision/1':
                            raise ValueError('PROVISION_RECEIPT')
                        if (set(receipt) != fields or receipt['admissionSha256'] != c.token
                                or type(receipt['success']) is not bool):
                            raise ValueError('PROVISION_RECEIPT')
                    except (ValueError, TypeError, KeyError):
                        raise Unknown('PROVISION_RECEIPT') from None
                    passed = receipt['success']
                else:
                    try:
                        receipt = decode_receipt(raw, c.a['job'])
                    except (ValueError, TypeError, KeyError):
                        raise InvalidReceipt('RECEIPT_INVALID', 'RECEIPT_GET') from None
                    passed = receipt['verdict'] == 'PASS'
        result = dict(run_id=run_id, complete=True, passed=passed)
        if public_defaults is not None:
            result['public_defaults'] = public_defaults
        if failure:
            result['failure'] = failure
        return result

    def failure(self, c, arn):
        """The worker's fixed-vocabulary failure record, when it replaced its last heartbeat.

        Only identifier-shaped strings, integers and booleans under known keys pass
        through; anything else in the object is dropped unread."""
        try:
            record = c.read(f'heartbeats/{c.a["id"]}/{arn}.json')
        except (Unknown, ValueError, TypeError):
            record = None
        terminal = clean_heartbeat(record)
        if terminal and record.get('schema') == FAILURE_SCHEMA:
            return terminal
        clean = c.read(c.prefix + 'clean.json')
        saved = clean_heartbeat((clean or {}).get('heartbeat'))
        tagged = c.read(c.prefix+'boot-failure.json')
        tag_failure = None
        if tagged:
            from boot_report import SCHEMA
            if tagged.get('admissionSha256') != c.token or tagged.get('instanceId') != arn.rsplit('/', 1)[-1]:
                raise Unknown('INSTANCE_CHANGED')
            value = tagged.get('failure', {})
            if type(value) is dict and set(value) == {'stage', 'phase', 'exit'} and value['stage'] == 'boot':
                tag_failure = clean_boot_failure({'schema': SCHEMA, 'phase': value['phase'], 'exit': value['exit']})
        # The shell trap also runs after a pulsed worker is killed. Its coarse
        # marker must not hide the last real stage or a saved failure record.
        return saved or terminal or self.boot_failure(c, arn) or tag_failure

    def boot_failure(self, c, arn):
        """Pre-job diagnostics or a coarse shell marker, used without a job pulse.

        The trap can also run after the worker started; that marker alone does
        not prove the failure preceded the first heartbeat."""
        try:
            record = c.read(f'heartbeats/boot/{arn}.json')
        except (Unknown, ValueError, TypeError):
            return None
        closed = clean_boot_failure(record)
        if closed:
            return closed
        terminal = clean_heartbeat(record)
        if terminal and terminal.get('stage') == 'boot':
            return terminal
        if not isinstance(record, dict) or record.get('schema') != BOOT_FAILURE_SCHEMA:
            return None
        from vocabulary import PHASES
        phase = record.get('phase')
        if known(phase, PHASES):
            return {'stage': 'boot', 'phase': phase}
        return None

    def release(self, run_id, attested_volumes):
        """Operator-attested close for a terminated instance whose recorded disk
        inventory is incomplete. Requires: the instance observed terminated, the
        recorded volumes a subset of the attested set, every attested volume
        observed absent by ID, and no tagged disk remaining. Deletes nothing,
        never releases a running box, and never reports PASS."""
        state, etag = self.active()
        if not state or state['admission']['id'] != run_id or state['phase'] in ('RESERVED', 'CLEAN'):
            raise Unknown('RUN_CONFLICT')
        c = self.control(state)
        prior = c.read(c.prefix + 'instance.json')
        i = c.observe() if prior else None
        if not prior or i is None or i['InstanceId'] != prior['id']:
            raise Unknown('LAUNCH_ACK_UNKNOWN')
        if i['State']['Name'] != 'terminated':
            raise Unknown('RELEASE_REFUSED_RUNNING')
        attested = sorted(set(attested_volumes))
        if len(attested) != DISKS_PER_INSTANCE or not set(prior['volumes']) <= set(attested):
            raise Unknown('RELEASE_ATTESTATION')
        for vid in attested:
            try:
                response = c.ec2.describe_volumes(VolumeIds=[vid])
            except Exception as e:
                if getattr(e, 'response', {}).get('Error', {}).get('Code') == 'InvalidVolume.NotFound':
                    continue
                raise Unknown('DISK_DESCRIBE_UNKNOWN') from None
            raise Unknown('DISK_REMAINS' if response.get('Volumes') else 'DISK_DESCRIBE_EMPTY')
        tagged = []
        for page in c.ec2.get_paginator('describe_volumes').paginate(Filters=[{'Name': 'tag:polis:probe-run', 'Values': [run_id]}]):
            tagged.extend(page['Volumes'])
        if tagged:
            raise Unknown('DISK_REMAINS')
        c.record(c.prefix + 'clean.json', {'admissionSha256': c.token, 'instanceId': prior['id'],
                 'volumes': attested, 'status': 'CLEAN', 'attested': True})
        self.cas(etag, dict(state, phase='CLEAN', nonce=uuid.uuid4().hex))
        self.monitor(c, True)
        return dict(run_id=run_id, complete=True, passed=False)

    def close(self, c, state, etag, bound):
        """Terminal INTENT -> CLEAN CAS, after resource and alarm cleanup.

        A lost acknowledgement or a concurrent closer is resolved by reading the
        register back at once: only the same run, generation, admission and
        configuration in phase CLEAN, with a validated resource-cleanup record,
        is accepted (its nonce may differ; it grants no launch permission). The
        same bound INTENT is closed again by the next fresh observation, with a
        fresh ETag. A permanent write cause is resolved only by exact equality."""
        value = dict(state, phase='CLEAN', nonce=uuid.uuid4().hex)
        try:
            self.s3.put_object(Bucket=self.cfg['CONTROL_BUCKET'], Key='active.json',
                Body=encoded(value), ServerSideEncryption='aws:kms',
                SSEKMSKeyId=self.cfg['CONTROL_KEY'], IfMatch=etag)
        except Exception as error:
            kind = sdk_cause(error)
            conflict = error_code(error) in ('PreconditionFailed', 'ConditionalRequestConflict')
            permanent = (Unknown('AUTH_UNAVAILABLE', 'TERMINAL_CAS') if kind == 'auth'
                         else Unknown('ACTIVE_CONFLICT', 'TERMINAL_CAS'))
            try:
                actual, _ = self.active()
            except Exception:
                # A failed readback never replaces a permanent write cause.
                if kind == 'transient' or conflict:
                    raise
                raise permanent from None
            if actual == value:
                return
            if kind != 'transient' and not conflict:
                raise permanent from None
            self.closed_by_bound(c, actual, bound, 'ACTIVE_CONFLICT', reclose=True)
            return
        actual, _ = self.active()
        if actual != value:
            self.closed_by_bound(c, actual, bound, 'ACTIVE_CHANGED', reclose=False)

    def closed_by_bound(self, c, actual, bound, reason, reclose):
        if not actual or self.binding(actual) != bound:
            raise Unknown(reason, 'TERMINAL_CAS')
        c.clean_record(c.read(c.prefix + 'clean.json'), c.read(c.prefix + 'instance.json'))
        if actual['phase'] == 'CLEAN':
            return
        if actual['phase'] == 'INTENT' and reclose:
            raise Unknown(reason, 'TERMINAL_CAS', RETRY)
        raise Unknown(reason, 'TERMINAL_CAS')

    def alarm_names(self, c):
        """The two exact alarm names bound to this run; provision mode and the
        no-monitoring test mode are exempt."""
        if self.monitoring is None or self.cfg['MODE'] != 'worker':
            return None
        return [self.cfg['BOX_ID']+'-worker-'+c.a['id']+'-'+m for m in ('StatusCheckFailed','StatusCheckFailed_System')]

    def put_alarms(self, c):
        names = self.alarm_names(c)
        if not names:
            return
        owned = c.read(c.prefix+'instance.json')
        if not owned:
            return
        for name, metric in zip(names, ('StatusCheckFailed','StatusCheckFailed_System')):
            try:
                self.monitoring.put_metric_alarm(AlarmName=name, Namespace='AWS/EC2',MetricName=metric,
                    Dimensions=[{'Name':'InstanceId','Value':owned['id']}], Statistic='Maximum', Period=60,
                    EvaluationPeriods=1,Threshold=1,ComparisonOperator='GreaterThanOrEqualToThreshold',
                    TreatMissingData='breaching',ActionsEnabled=True,AlarmActions=[self.cfg['NOTIFICATION_TOPIC']])
            except Exception as error:
                raise sdk_error('ALARM_UNKNOWN', 'ALARM_PUT', error) from None

    def delete_alarms(self, c):
        """An acknowledged DeleteAlarms of the two exact names is alarm cleanup;
        an uncertain one is repeated idempotently by the next observation."""
        names = self.alarm_names(c)
        if not names:
            return
        try:
            self.monitoring.delete_alarms(AlarmNames=names)
        except Exception as error:
            raise sdk_error('ALARM_UNKNOWN', 'ALARM_DELETE', error) from None

    def monitor(self, c, clean):
        if clean:
            self.delete_alarms(c)
        else:
            self.put_alarms(c)


def clients(region, profile):
    import boto3
    from botocore.config import Config
    session = boto3.Session(profile_name=profile, region_name=region)
    # total_max_attempts includes the first call. This applies to launch too.
    config = Config(retries={'total_max_attempts': 1, 'mode': 'standard'},
                    connect_timeout=10, read_timeout=30,
                    s3={'us_east_1_regional_endpoint':'regional','addressing_style':'virtual'})
    return session.client('ec2', config=config), session.client('s3', config=config), session.client('cloudwatch', config=config)


UNRESOLVED = 'PROBE_UNRESOLVED: use status/cancel with the same run ID; never relaunch'


def outcome(error):
    """Closed (reason, operation, disposition) for any exception; never its text."""
    if isinstance(error, Unknown):
        reason = error.reason if error.reason in REASONS else 'UNCLASSIFIED'
        operation = error.operation if error.operation in OPERATIONS else 'UNKNOWN_OPERATION'
        disposition = error.disposition if error.disposition in (REFUSE, RETRY, PENDING) else REFUSE
        return reason, operation, disposition
    return 'UNCLASSIFIED', 'UNKNOWN_OPERATION', REFUSE


def diagnose(reason, operation, disposition, attempt, last=None):
    """One stderr line of closed values: UTC time, reason, operation, disposition
    and a bounded attempt number. No exception text, SDK code or message,
    request/response, control key, identifier or receipt byte."""
    fields = [('time', dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')),
              ('reason', reason if reason in REASONS else 'UNCLASSIFIED')]
    if last is not None:
        fields.append(('last', last if last in REASONS else 'UNCLASSIFIED'))
    fields += [('operation', operation if operation in OPERATIONS else 'UNKNOWN_OPERATION'),
               ('disposition', disposition if disposition in (REFUSE, RETRY, PENDING) else REFUSE),
               ('attempt', str(min(max(int(attempt), 0), WATCH_TRANSIENT_ATTEMPTS)))]
    print('PROBE_DIAGNOSTIC ' + ' '.join(f'{k}={v}' for k, v in fields), file=sys.stderr)


def unresolved(error, attempt=1):
    reason, operation, disposition = outcome(error)
    diagnose(reason, operation, disposition, attempt)
    # No DB identifiers, receipt bytes or SDK messages in terminal output.
    print(UNRESOLVED)
    return 2


def finish(result):
    print(json.dumps(result, sort_keys=True))
    return 0 if result['complete'] and result['passed'] else 1


def watch(session, run_id):
    """Bounded lifecycle reconciliation until complete. The deadline is fixed
    before the first observation and never extended. Pending resource states
    are observed again every WATCH_POLL_SECONDS; transient failures get two
    further observations in total; everything else refuses at once. Only
    status is ever called: no retry path can reach a launch."""
    end = time.monotonic() + WATCH_CEILING_SECONDS
    bound = {}
    failures = 0
    last = None
    while True:
        if time.monotonic() >= end:
            # Never start another observation at or after the deadline.
            reason, operation, _ = last or (None, 'UNKNOWN_OPERATION', None)
            diagnose('WATCH_CEILING', operation, REFUSE, failures, last=reason)
            print(UNRESOLVED)
            return 2
        try:
            result = session.status(run_id, bound=bound)
        except Exception as error:
            reason, operation, disposition = outcome(error)
            last = (reason, operation, disposition)
            if disposition == PENDING:
                failures = 0
            elif disposition == RETRY:
                failures += 1
                diagnose(reason, operation, RETRY, failures)
                if failures >= WATCH_TRANSIENT_ATTEMPTS:
                    diagnose('RETRY_EXHAUSTED', operation, REFUSE, failures, last=reason)
                    print(UNRESOLVED)
                    return 2
            else:
                return unresolved(error, failures + 1)
        else:
            failures, last = 0, None
            if result['complete']:
                return finish(result)
        remaining = end - time.monotonic()
        if remaining <= 0:
            continue
        time.sleep(min(WATCH_POLL_SECONDS, remaining))


def main():
    import argparse
    from pathlib import Path
    parser = argparse.ArgumentParser(description='Operator probe lifecycle; local closed-receipt validation')
    parser.add_argument('action', choices=('launch', 'status', 'cancel', 'watch', 'release'))
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--profile', required=True)
    parser.add_argument('--job', type=Path)
    parser.add_argument('--run-id')
    parser.add_argument('--attest-volume', action='append', default=[])
    args = parser.parse_args()
    try:
        cfg = json.loads(args.config.read_bytes())
        region, mode = cfg['REGION'], cfg['MODE']
    except Exception:
        return unresolved(Unknown('CONFIG_UNKNOWN', 'CONFIG_LOAD'))
    try:
        ec2, s3, monitoring = clients(region, args.profile)
        session = Session(ec2, s3, cfg, monitoring=monitoring)
    except Exception as error:
        return unresolved(sdk_error('CLIENT_SETUP_UNKNOWN', 'CLIENT_SETUP', error))
    try:
        if args.action == 'release':
            if not args.run_id or args.job or not args.attest_volume:
                raise Unknown('REQUEST_REFUSED')
            return finish(session.release(args.run_id, args.attest_volume))
        if args.action == 'launch':
            if not args.job or args.run_id or args.attest_volume:
                raise Unknown('REQUEST_REFUSED')
            request = json.loads(args.job.read_bytes())
            # Exactly one SDK attempt and no application retry.
            return finish(session.start_provision(request) if mode == 'provision' else session.start(request))
        if not args.run_id or args.job or args.attest_volume:
            raise Unknown('REQUEST_REFUSED')
        if args.action == 'watch':
            return watch(session, args.run_id)
        # status/cancel: one observation, no loop. A pending resource state is
        # an incomplete result; a transient failure is exit 2 with its reason.
        try:
            result = session.status(args.run_id, cancel=args.action == 'cancel')
        except Unknown as error:
            if outcome(error)[2] != PENDING:
                raise
            result = dict(run_id=args.run_id, complete=False, passed=False)
        return finish(result)
    except Exception as error:
        return unresolved(error)

if __name__ == '__main__':
    raise SystemExit(main())
