"""Serialized reusable probe lifecycle; no raw data, logging or launch retries."""
from __future__ import annotations
import datetime as dt
import hashlib
import json
import os
import time

LAUNCH_KEYS = ('TEMPLATE', 'TEMPLATE_VERSION', 'PROFILE', 'SUBNET', 'SECURITY_GROUP')


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
        self.now = time.time() if now is None else now
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
        return (i.get("ClientToken") == self.token
                # DescribeInstances has no LaunchTemplate field. The exact
                # template/version live in the durable admission bound by this
                # client token; verify the observable instance fields below.
                and not i.get("PublicIpAddress")
                and {g["GroupId"] for g in i.get("SecurityGroups", [])} == {c["SECURITY_GROUP"]}
                and i.get("IamInstanceProfile", {}).get("Arn") == c["PROFILE"]
                and i.get("ImageId") == a["ami"] and i.get("SubnetId") == c["SUBNET"]
                and i.get("InstanceType") == "r8g.4xlarge"
                and {t["Key"]: t["Value"] for t in i.get("Tags", [])}.get("polis:probe-run") == a["id"])

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

    def launch(self):
        if self.now >= self.expiry or self.expiry - self.now > 12 * 3600:
            raise Unknown("ADMISSION_EXPIRED_OR_OVER_BUDGET")
        if self.read(self.prefix + "clean.json") or self.read(self.prefix + "cancel.json"):
            raise Unknown("RUN_CLOSED")
        if self.read(self.prefix + "claim.json"):
            # No RunInstances retry: its idempotency horizon is not unbounded.
            return self.reconcile()
        image = self.ec2.describe_images(ImageIds=[self.a["ami"]])["Images"]
        if len(image) != 1 or image[0].get("Architecture") != "arm64" or image[0].get("State") != "available" or image[0].get("OwnerId") != self.a["account"]:
            raise Unknown("IMAGE_NOT_ADMITTED")
        self.record(self.prefix + "claim.json", {"admissionSha256": self.token, "started": self.now})
        # Body contains only fixed template and token. Caller cannot supply overrides.
        self.ec2.run_instances(LaunchTemplate={"LaunchTemplateId": self.c["TEMPLATE"], "Version": self.c["TEMPLATE_VERSION"]},
                               MinCount=1, MaxCount=1, ClientToken=self.token,
                               TagSpecifications=[{"ResourceType": kind,"Tags":[{"Key":"polis:probe-box","Value":self.c["BOX_ID"]},{"Key":"polis:probe-run","Value":self.a["id"]}]} for kind in ("instance","volume")])
        return self.reconcile()

    def heartbeat_missing(self, instance: object, claim: object):
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
            if expired or cancelled:
                # No launch claim ever existed, so no launch can be in flight.
                self.record(self.prefix + "clean.json", {"admissionSha256": self.token, "instanceId": None, "volumes": [], "status": "CLEAN"})
                return {"status": "CLEAN", "admissionId": self.a["id"]}
            return {"status": "STAGED", "admissionId": self.a["id"]}
        instances = self.instances()
        if not instances:
            raise Unknown("LAUNCH_ACK_UNKNOWN")
        i = instances[0]
        iid = i["InstanceId"]
        volume_ids = sorted(b["Ebs"]["VolumeId"] for b in i.get("BlockDeviceMappings", []) if "Ebs" in b)
        prior = self.read(self.prefix + "instance.json")
        if not prior and volume_ids:
            self.record(self.prefix + "instance.json", {"id": iid, "volumes": volume_ids, "admissionSha256": self.token})
            prior = self.read(self.prefix + "instance.json")
        if prior and prior["id"] != iid:
            raise Unknown("INSTANCE_CHANGED")
        if i["State"]["Name"] != "terminated":
            if expired or cancelled or self.heartbeat_missing(i, claim):
                self.ec2.terminate_instances(InstanceIds=[iid])
                # Observe on a later sweep; do not call accepted termination CLEAN.
                raise Unknown("TERMINATION_PENDING")
            if not prior or len(prior["volumes"]) != 2:
                raise Unknown("DISK_INVENTORY_UNKNOWN")
            boot = {"admission": self.a, "admissionSha256": self.token, "instanceId": iid,
                    "template": self.c["TEMPLATE"], "templateVersion": self.c["TEMPLATE_VERSION"],
                    "evidenceBucket": self.c["EVIDENCE_BUCKET"], "assetBucket": self.c["ASSET_BUCKET"],
                    "secretArn": self.c["SECRET_ARN"], "replicaHost": self.c["REPLICA_HOST"],
                    "database": self.c["DATABASE"], "secretsUrl": self.c["SECRETS_URL"],
                    "controlBucket": self.c["CONTROL_BUCKET"], "evidenceKey": self.c["CONTROL_KEY"],
                    "endpoint": self.c["ENDPOINT"], "started": claim["started"]}
            self.record(f'boot/arn:aws:ec2:{self.a["region"]}:{self.a["account"]}:instance/{iid}.json', boot)
            return {"status": "RUNNING", "admissionId": self.a["id"]}
        if not prior or len(prior["volumes"]) != 2:
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



def _handle(event: dict, context: object) -> dict:
    import boto3
    from contracts import validate_job
    cfg = dict(os.environ)
    s3, ec2 = boto3.client("s3"), boto3.client("ec2")
    now = time.time()
    action = event.get("action")
    if action not in ("launch", "status", "cancel", "sweep"):
        raise RuntimeError("REQUEST_REFUSED")
    def get_active() -> dict | None:
        try:
            body = s3.get_object(Bucket=cfg["CONTROL_BUCKET"], Key="active.json")["Body"].read(65537)
        except Exception as error:
            if getattr(error, "response", {}).get("Error", {}).get("Code") == "NoSuchKey":
                return None
            raise RuntimeError("CONTROL_UNAVAILABLE") from None
        if len(body) > 65536:
            raise RuntimeError("CONTROL_INVALID")
        return json.loads(body)
    active = get_active()
    if action == "launch":
        if set(event) != {"action", "job"}:
            raise RuntimeError("REQUEST_REFUSED")
        job = validate_job(event["job"])
        if active and active["job"]["run_id"] != job["run_id"]:
            old_cfg = dict(cfg, ADMISSION=json.dumps(active), ADMISSION_SHA256=sha(active))
            if Control(ec2, s3, old_cfg, now).reconcile()["status"] != "CLEAN":
                raise RuntimeError("PREVIOUS_RUN_NOT_CLEAN")
        if not active or active["job"]["run_id"] != job["run_id"]:
            active = {"id": job["run_id"], "job": job, "ami": cfg["AMI"],
                      "account": cfg["ACCOUNT"], "region": cfg["REGION"],
                      "launch": {key: cfg[key] for key in LAUNCH_KEYS},
                      "expiresAt": dt.datetime.fromtimestamp(now+job["max_seconds"],dt.timezone.utc).isoformat()}
            # A run id is single-use even after a subsequent run replaced active.
            try:
                s3.put_object(Bucket=cfg["CONTROL_BUCKET"], Key=f'claims/{job["run_id"]}.json',
                              Body=encoded(active), IfNoneMatch="*", ServerSideEncryption="aws:kms", SSEKMSKeyId=cfg["CONTROL_KEY"])
            except Exception:
                raise RuntimeError("RUN_ALREADY_CLAIMED_OR_UNKNOWN") from None
            s3.put_object(Bucket=cfg["CONTROL_BUCKET"], Key="active.json", Body=encoded(active),
                          ServerSideEncryption="aws:kms", SSEKMSKeyId=cfg["CONTROL_KEY"])
        if active["job"] != job:
            raise RuntimeError("RUN_CONFLICT")
    elif set(event) != ({"action"} if action == "sweep" else {"action", "run_id"}):
        raise RuntimeError("REQUEST_REFUSED")
    if active is None:
        return {"complete": False, "passed": False}
    if action not in ("launch", "sweep") and event["run_id"] != active["id"]:
        raise RuntimeError("RUN_CONFLICT")
    c = Control(ec2, s3, dict(cfg, ADMISSION=json.dumps(active), ADMISSION_SHA256=sha(active)), now)
    try:
        result = c.launch() if action == "launch" else c.reconcile(cancel=action == "cancel")
        passed = False
        if result["status"] == "CLEAN":
            owned = c.read(c.prefix + "instance.json")
            if owned:
                arn = f'arn:aws:ec2:{cfg["REGION"]}:{cfg["ACCOUNT"]}:instance/{owned["id"]}'
                from receipt import validate_receipt
                try:
                    response = s3.get_object(Bucket=cfg["EVIDENCE_BUCKET"], Key=f'results/{arn}/receipt.json')
                except Exception as error:
                    if getattr(error,'response',{}).get('Error',{}).get('Code')=='NoSuchKey':
                        return {'run_id': active['id'], 'complete': True, 'passed': False}
                    raise
                raw = response["Body"].read(131073)
                if len(raw) > 131072:
                    raise RuntimeError("RECEIPT_LIMIT")
                receipt = validate_receipt(json.loads(raw), active["job"])
                passed = receipt["verdict"] == "PASS"
        return {"run_id": active["id"], "complete": result["status"] == "CLEAN", "passed": passed}
    except Exception:
        # Fixed response; uncertainty never confers PASS. The sweeper keeps
        # reconciling the durable active/claim records after caller failure.
        if action == "sweep":
            raise RuntimeError("PROBE_TEARDOWN_UNKNOWN") from None
        return {"run_id": active["id"], "complete": False, "passed": False}


def handler(event: dict, context: object) -> dict:
    try:
        return _handle(event, context)
    except Exception:
        raise RuntimeError("PROBE_CONTROL_FAILED") from None
