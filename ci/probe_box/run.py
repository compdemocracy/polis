"""Serialized reusable probe lifecycle; no raw data, logging or launch retries."""
from __future__ import annotations
import datetime as dt
import hashlib
import json
import re
import time
import uuid
from contracts import validate_job
from receipt import validate_receipt, decode_receipt, receipt_limit

LAUNCH_KEYS = ('TEMPLATE', 'TEMPLATE_VERSION', 'PROFILE', 'SUBNET', 'SECURITY_GROUP')
# A worker that ends without a receipt leaves this record in its heartbeat object (worker.py).
FAILURE_SCHEMA = 'polis-probe-failure/1'
BOOT_FAILURE_SCHEMA = 'polis-probe-boot-failure/1'
TOKEN = re.compile(r'[A-Za-z0-9_.-]{1,96}')
# Both launch templates carry exactly two EBS mappings: the root and one private disk.
# EBS attaches after RunInstances returns, so an observation with fewer disks is partial.
DISKS_PER_INSTANCE = 2


class Unknown(RuntimeError):
    pass


def encoded(value: object):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def sha(value: object):
    return hashlib.sha256(encoded(value)).hexdigest()


class Control:
    def __init__(self, ec2: object, s3: object, cfg: object, now: object = None):
        self.ec2, self.s3, self.c = ec2, s3, cfg
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
        except Exception as e:
            if getattr(e, "response", {}).get("Error", {}).get("Code") == "NoSuchKey":
                return None
            raise Unknown("CONTROL_READ_UNKNOWN") from None
        raw = obj["Body"].read(65537)
        if len(raw) > 65536:
            raise Unknown("CONTROL_OVERSIZE")
        return json.loads(raw)

    def record(self, key: object, value: object):
        """Create-only, including after lost acknowledgement. No hidden overwrite."""
        try:
            self.s3.put_object(Bucket=self.c["CONTROL_BUCKET"], Key=key, Body=encoded(value),
                               IfNoneMatch="*", ServerSideEncryption="aws:kms", SSEKMSKeyId=self.c["CONTROL_KEY"])
        except Exception:
            if self.read(key) != value:
                raise Unknown("RECORD_CONFLICT") from None

    def own(self, i: object):
        c, a = self.c, self.a
        # DescribeInstances drops SubnetId, SecurityGroups and IamInstanceProfile
        # once an instance is terminated (observed on the first real run);
        # those fields are required while present. The client token (the
        # admission digest), image, type and both tags are always required.
        terminated = i.get("State", {}).get("Name") == "terminated"
        groups = {g["GroupId"] for g in i.get("SecurityGroups", [])}
        return (i.get("ClientToken") == self.token
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
        for page in self.ec2.get_paginator("describe_instances").paginate(Filters=[
            {"Name": "client-token", "Values": [self.token]},
        ]):
            for reservation in page["Reservations"]:
                found.extend(reservation["Instances"])
        if any(not self.own(i) for i in found) or len(found) > 1:
            raise Unknown("INSTANCE_OWNERSHIP_UNKNOWN")
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
        try:
            found = [i for r in self.ec2.describe_instances(InstanceIds=[prior["id"]])["Reservations"] for i in r["Instances"]]
        except Exception as e:
            if getattr(e, "response", {}).get("Error", {}).get("Code") != "InvalidInstanceID.NotFound":
                raise Unknown("INSTANCE_DESCRIBE_UNKNOWN") from None
            found = []
        if found:
            if len(found) != 1 or not self.own(found[0]):
                raise Unknown("INSTANCE_OWNERSHIP_UNKNOWN")
            return found[0]
        return {"InstanceId": prior["id"], "State": {"Name": "terminated"}, "BlockDeviceMappings": [], "gone": True}

    def launch_once(self):
        if self.now >= self.expiry or self.expiry - self.now > 12 * 3600:
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
            if getattr(e, "response", {}).get("Error", {}).get("Code") in ("404", "NoSuchKey", "NotFound"):
                return True
            raise Unknown("HEARTBEAT_UNKNOWN") from None

    def reconcile(self, cancel: object = False):
        claim = self.read(self.prefix + "claim.json")
        clean = self.read(self.prefix + "clean.json")
        if clean:
            return {"status": "CLEAN", "admissionId": self.a["id"]}
        if cancel:
            self.record(self.prefix + "cancel.json", {"admissionSha256": self.token})
        expired = self.now >= self.expiry or (claim and self.now - claim["started"] >= 12 * 3600)
        cancelled = bool(self.read(self.prefix + "cancel.json"))
        if not claim:
            # An INTENT may precede claim creation or the actual launch call.
            # No observation can prove that its actor will never resume.
            raise Unknown("LAUNCH_ACK_UNKNOWN")
        i = self.observe()
        if i is None:
            raise Unknown("LAUNCH_ACK_UNKNOWN")
        iid = i["InstanceId"]
        volume_ids = sorted(b["Ebs"]["VolumeId"] for b in i.get("BlockDeviceMappings", []) if "Ebs" in b)
        prior = self.read(self.prefix + "instance.json")
        if not prior and i["State"]["Name"] != "terminated":
            if len(volume_ids) != len(set(volume_ids)) or len(volume_ids) > DISKS_PER_INSTANCE:
                raise Unknown("DISK_INVENTORY_UNKNOWN")
            if len(volume_ids) < DISKS_PER_INSTANCE:
                # A partial disk set must never become the disposal inventory;
                # observe again on a later poll (the boot object waits with it).
                return {"status": "ATTACHING", "admissionId": self.a["id"]}
            self.record(self.prefix + "instance.json", {"id": iid, "volumes": volume_ids, "admissionSha256": self.token})
            prior = self.read(self.prefix + "instance.json")
        if prior and (prior["id"] != iid or prior["admissionSha256"] != self.token
                      or (volume_ids and volume_ids != prior["volumes"])):
            raise Unknown("INSTANCE_CHANGED")
        if i["State"]["Name"] != "terminated":
            if expired or cancelled or self.heartbeat_missing(i, claim):
                self.ec2.terminate_instances(InstanceIds=[iid])
                # Observe on a later sweep; do not call accepted termination CLEAN.
                raise Unknown("TERMINATION_PENDING")
            if not prior or len(set(prior["volumes"])) != 2:
                raise Unknown("DISK_INVENTORY_UNKNOWN")
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
            return {"status": "RUNNING", "admissionId": self.a["id"]}
        if not prior or len(set(prior["volumes"])) != 2:
            raise Unknown("DISK_INVENTORY_UNKNOWN")
        # Include tagged unexpected disks, but never delete on tag alone.
        disks = []
        for page in self.ec2.get_paginator("describe_volumes").paginate(Filters=[{"Name": "tag:polis:probe-run", "Values": [self.a["id"]]}]):
            disks.extend(page["Volumes"])
        if any(v["VolumeId"] not in prior["volumes"] for v in disks):
            raise Unknown("UNKNOWN_DISK")
        for v in disks:
            if v.get("Attachments") or v.get("State") != "available":
                raise Unknown("DISK_NOT_DETACHED")
            self.ec2.delete_volume(VolumeId=v["VolumeId"])
        # Independently query the actual IDs too; missing/changed tags cannot hide disks.
        for vid in prior["volumes"]:
            try:
                response = self.ec2.describe_volumes(VolumeIds=[vid])
            except Exception as e:
                if getattr(e, "response", {}).get("Error", {}).get("Code") == "InvalidVolume.NotFound":
                    continue
                raise Unknown("DISK_DESCRIBE_UNKNOWN") from None
            if response.get("Volumes"):
                raise Unknown("DISK_REMAINS")
            raise Unknown("DISK_DESCRIBE_EMPTY")
        self.record(self.prefix + "clean.json", {"admissionSha256": self.token, "instanceId": iid,
                    "volumes": prior["volumes"], "status": "CLEAN"})
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
        except Exception as error:
            if getattr(error, 'response', {}).get('Error', {}).get('Code') == 'NoSuchKey':
                return None, None
            raise Unknown('CONTROL_READ_UNKNOWN') from None
        raw = obj['Body'].read(65537)
        if len(raw) > 65536:
            raise Unknown('CONTROL_OVERSIZE')
        state = json.loads(raw)
        if (set(state) != {'generation', 'admission', 'phase', 'nonce'}
                or state['phase'] not in ('RESERVED', 'INTENT', 'CLEAN')
                or not isinstance(state['generation'], str) or len(state['generation']) != 32
                or not obj.get('ETag')):
            raise Unknown('CONTROL_SCHEMA')
        return state, obj['ETag']

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
                       ADMISSION_SHA256=sha(a)), self.clock)

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

    def status(self, run_id, cancel=False):
        state, etag = self.active()
        if not state or state['admission']['id'] != run_id:
            raise Unknown('RUN_CONFLICT')
        c = self.control(state)
        if state['phase'] == 'RESERVED':
            if not cancel:
                return dict(run_id=run_id, complete=False, passed=False)
            # CAS defeats any stale RESERVED -> INTENT actor. No launch permit
            # ever existed for this generation, so cancellation may close it.
            self.cas(etag, dict(state, phase='CLEAN', nonce=uuid.uuid4().hex))
            return dict(run_id=run_id, complete=True, passed=False)
        if state['phase'] != 'CLEAN':
            self.monitor(c, False)
            result = c.reconcile(cancel=cancel)
            if result['status'] != 'CLEAN':
                return dict(run_id=run_id, complete=False, passed=False)
            self.cas(etag, dict(state, phase='CLEAN', nonce=uuid.uuid4().hex))
        self.monitor(c, True)
        passed = False
        failure = None
        owned = c.read(c.prefix+'instance.json')
        if owned:
            arn = f'arn:aws:ec2:{c.a["region"]}:{c.a["account"]}:instance/{owned["id"]}'
            provision = self.cfg['MODE'] == 'provision'
            try:
                obj = self.s3.get_object(Bucket=self.cfg['CONTROL_BUCKET'] if provision else self.cfg['EVIDENCE_BUCKET'],
                    Key=f'provision-results/{arn}.json' if provision else f'results/{arn}/receipt.json')
            except Exception as error:
                if getattr(error,'response',{}).get('Error',{}).get('Code') != 'NoSuchKey':
                    raise Unknown('RECEIPT_READ_UNKNOWN') from None
                if not provision:
                    failure = self.failure(c, arn)
            else:
                raw = obj['Body'].read(131073)
                if len(raw) > (131072 if provision else receipt_limit(c.a['job'])):
                    raise Unknown('RECEIPT_LIMIT')
                if provision:
                    receipt = json.loads(raw)
                    if (set(receipt) != {'schema','admissionSha256','success'} or receipt['schema'] != 'polis-probe-provision/1'
                            or receipt['admissionSha256'] != c.token or type(receipt['success']) is not bool):
                        raise Unknown('PROVISION_RECEIPT')
                    passed = receipt['success']
                else:
                    receipt = decode_receipt(raw, c.a['job'])
                    passed = receipt['verdict'] == 'PASS'
        result = dict(run_id=run_id, complete=True, passed=passed)
        if failure:
            result['failure'] = failure
        return result

    def failure(self, c, arn):
        """The worker's fixed-vocabulary failure record, when it replaced its last heartbeat.

        Only identifier-shaped strings, integers and booleans under known keys pass
        through; anything else in the object is dropped unread."""
        try:
            record = c.read(f'heartbeats/{c.a["id"]}/{arn}.json')
        except Unknown:
            return None
        if not isinstance(record, dict) or record.get('schema') != FAILURE_SCHEMA:
            return self.boot_failure(c, arn)
        # Closed vocabularies derived from the reviewed source tree (vocabulary.py):
        # identifier-shaped is not enough, a hostile container could spell into it.
        from vocabulary import Vocabulary, STAGES, LABELS, RELAY, REASON_CODES
        v = Vocabulary()
        clean = {}
        if record.get('stage') in STAGES: clean['stage'] = record['stage']
        if v.class_name(record.get('type')): clean['type'] = record['type']
        if v.code(record.get('code')): clean['code'] = record['code']
        if isinstance(record.get('aws'), str) and re.fullmatch(r'[A-Za-z0-9.]{1,64}', record['aws']): clean['aws'] = record['aws']
        container = record.get('container')
        if isinstance(container, dict):
            c = {}
            if container.get('label') in LABELS: c['label'] = container['label']
            if v.class_name(container.get('class')): c['class'] = container['class']
            if v.code(container.get('code')): c['code'] = container['code']
            if container.get('reason') in REASON_CODES: c['reason'] = container['reason']
            if v.slug(container.get('role')): c['role'] = container['role']
            for k, kind in (('exit', int), ('oom', bool), ('rank', int), ('candidates', int)):
                if type(container.get(k)) is kind:
                    c[k] = container[k]
            clean['container'] = c
        relay = record.get('relay')
        if isinstance(relay, dict):
            clean['relay'] = {k: v_ for k, v_ in relay.items() if k in RELAY and type(v_) is int}
        return clean or None

    def boot_failure(self, c, arn):
        """The start script's phase marker, written only when the box failed before the
        worker's first heartbeat (private disk, container daemon, ...). A fixed token."""
        try:
            record = c.read(f'heartbeats/boot/{arn}.json')
        except Unknown:
            return None
        if not isinstance(record, dict) or record.get('schema') != BOOT_FAILURE_SCHEMA:
            return None
        from vocabulary import PHASES
        phase = record.get('phase')
        if phase in PHASES:
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

    def monitor(self, c, clean):
        if self.monitoring is None or self.cfg['MODE'] != 'worker':
            return
        names = [self.cfg['BOX_ID']+'-worker-'+c.a['id']+'-'+m for m in ('StatusCheckFailed','StatusCheckFailed_System')]
        if clean:
            self.monitoring.delete_alarms(AlarmNames=names)
            return
        owned = c.read(c.prefix+'instance.json')
        if not owned:
            return
        for name, metric in zip(names, ('StatusCheckFailed','StatusCheckFailed_System')):
            self.monitoring.put_metric_alarm(AlarmName=name, Namespace='AWS/EC2',MetricName=metric,
                Dimensions=[{'Name':'InstanceId','Value':owned['id']}], Statistic='Maximum', Period=60,
                EvaluationPeriods=1,Threshold=1,ComparisonOperator='GreaterThanOrEqualToThreshold',
                TreatMissingData='breaching',ActionsEnabled=True,AlarmActions=[self.cfg['NOTIFICATION_TOPIC']])


def clients(region, profile):
    import boto3
    from botocore.config import Config
    session = boto3.Session(profile_name=profile, region_name=region)
    # total_max_attempts includes the first call. This applies to launch too.
    config = Config(retries={'total_max_attempts': 1, 'mode': 'standard'},
                    connect_timeout=10, read_timeout=30,
                    s3={'us_east_1_regional_endpoint':'regional','addressing_style':'virtual'})
    return session.client('ec2', config=config), session.client('s3', config=config), session.client('cloudwatch', config=config)


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
    cfg = json.loads(args.config.read_bytes())
    ec2, s3, monitoring = clients(cfg['REGION'], args.profile)
    session = Session(ec2, s3, cfg, monitoring=monitoring)
    try:
        if args.action == 'release':
            if not args.run_id or args.job or not args.attest_volume:
                raise Unknown('REQUEST_REFUSED')
            result = session.release(args.run_id, args.attest_volume)
        elif args.action == 'launch':
            if not args.job or args.run_id or args.attest_volume:
                raise Unknown('REQUEST_REFUSED')
            request = json.loads(args.job.read_bytes())
            result = session.start_provision(request) if cfg['MODE'] == 'provision' else session.start(request)
        else:
            if not args.run_id or args.job or args.attest_volume:
                raise Unknown('REQUEST_REFUSED')
            result = session.status(args.run_id, cancel=args.action == 'cancel')
            if args.action == 'watch':
                end = time.monotonic()+18900
                while not result['complete']:
                    if time.monotonic() >= end:
                        raise Unknown('WATCH_CEILING')
                    time.sleep(30)
                    result = session.status(args.run_id)
        print(json.dumps(result, sort_keys=True))
        return 0 if result['complete'] and result['passed'] else 1
    except Exception:
        # No DB identifiers, receipt bytes or SDK messages in terminal output.
        print('PROBE_UNRESOLVED: use status/cancel with the same run ID; never relaunch')
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
