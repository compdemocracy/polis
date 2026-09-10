"""P-053 trusted control plane. Never logs events, SDK errors or private bytes.

One admission, one ClientToken, one launch attempt. Reserved concurrency is one.
A lost RunInstances response is reconciled by token; it is NEVER retried as a new
launch. Every mutation verifies template/profile/token/network AND ledger tags.
Only fixture staging is deleted. Evidence and immutable control records remain.
"""
import datetime as dt
import hashlib
import json
import os
import time


class Unknown(RuntimeError):
    pass


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def sha(value):
    return hashlib.sha256(encoded(value)).hexdigest()


class Control:
    def __init__(self, ec2, s3, cfg, now=None):
        self.ec2, self.s3, self.c = ec2, s3, cfg
        self.a = json.loads(cfg["ADMISSION"])
        self.now = time.time() if now is None else now
        if sha(self.a) != cfg["ADMISSION_SHA256"]:
            raise Unknown("ADMISSION_INVALID")
        self.expiry = dt.datetime.fromisoformat(self.a["expiresAt"].replace("Z", "+00:00")).timestamp()
        self.token = self.c["ADMISSION_SHA256"]
        self.prefix = f'control/{self.a["id"]}/'

    def read(self, key):
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

    def record(self, key, value):
        """Create-only, including after lost acknowledgement. No hidden overwrite."""
        try:
            self.s3.put_object(Bucket=self.c["CONTROL_BUCKET"], Key=key, Body=encoded(value),
                               IfNoneMatch="*", ServerSideEncryption="aws:kms", SSEKMSKeyId=self.c["CONTROL_KEY"])
        except Exception:
            if self.read(key) != value:
                raise Unknown("RECORD_CONFLICT") from None

    def own(self, i):
        c, a = self.c, self.a
        return (i.get("ClientToken") == self.token
                and i.get("LaunchTemplate", {}).get("LaunchTemplateId") == c["TEMPLATE"]
                and i.get("LaunchTemplate", {}).get("Version") == c["TEMPLATE_VERSION"]
                and not i.get("PublicIpAddress")
                and {g["GroupId"] for g in i.get("SecurityGroups", [])} == {c["SECURITY_GROUP"]}
                and i.get("IamInstanceProfile", {}).get("Arn") == c["PROFILE"]
                and i.get("ImageId") == a["ami"] and i.get("SubnetId") == c["SUBNET"]
                and i.get("InstanceType") == "r8g.4xlarge"
                and {t["Key"]: t["Value"] for t in i.get("Tags", [])}.get("polis:private-cert") == a["id"])

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
        if self.now < dt.datetime.fromisoformat(self.a["stagingExpiresAt"].replace("Z", "+00:00")).timestamp():
            raise Unknown("INGESTION_STILL_OPEN")
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
                               MinCount=1, MaxCount=1, ClientToken=self.token)
        return self.reconcile()

    def heartbeat_missing(self, instance, claim):
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

    def dispose_fixture(self):
        b, prefix = self.c["FIXTURE_BUCKET"], f'staging/{self.a["id"]}/'
        # Paginate each inventory before mutating it; successful requests alone
        # are insufficient. A fresh empty inventory is the deletion receipt.
        for page in self.s3.get_paginator("list_multipart_uploads").paginate(Bucket=b, Prefix=prefix):
            for u in page.get("Uploads", []):
                self.s3.abort_multipart_upload(Bucket=b, Key=u["Key"], UploadId=u["UploadId"])
        versions = []
        for page in self.s3.get_paginator("list_object_versions").paginate(Bucket=b, Prefix=prefix):
            versions.extend(page.get("Versions", []) + page.get("DeleteMarkers", []))
        for v in versions:
            self.s3.delete_object(Bucket=b, Key=v["Key"], VersionId=v["VersionId"])
        for page in self.s3.get_paginator("list_object_versions").paginate(Bucket=b, Prefix=prefix):
            if page.get("Versions") or page.get("DeleteMarkers"):
                raise Unknown("FIXTURE_REMAINS")
        for page in self.s3.get_paginator("list_multipart_uploads").paginate(Bucket=b, Prefix=prefix):
            if page.get("Uploads"):
                raise Unknown("UPLOAD_REMAINS")

    def reconcile(self, cancel=False):
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
                self.dispose_fixture()
                # No launch claim ever existed, so no launch can be in flight.
                self.record(self.prefix + "clean.json", {"admissionSha256": self.token, "instanceId": None, "volumes": [], "fixtureVersions": 0, "status": "CLEAN"})
                return {"status": "CLEAN", "admissionId": self.a["id"]}
            return {"status": "STAGED", "admissionId": self.a["id"]}
        if expired or cancelled:
            # Expiry destroys staged bytes even if EC2 reconciliation is unknown.
            self.dispose_fixture()
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
                    "fixtureBucket": self.c["FIXTURE_BUCKET"], "evidenceBucket": self.c["EVIDENCE_BUCKET"],
                    "controlBucket": self.c["CONTROL_BUCKET"], "evidenceKey": self.c["CONTROL_KEY"],
                    "endpoint": self.c["ENDPOINT"], "started": claim["started"]}
            self.record(f'boot/{self.a["id"]}.json', boot)
            return {"status": "RUNNING", "admissionId": self.a["id"]}
        if not prior or len(prior["volumes"]) != 2:
            raise Unknown("DISK_INVENTORY_UNKNOWN")
        # Include tagged unexpected disks, but never delete on tag alone.
        disks = []
        for page in self.ec2.get_paginator("describe_volumes").paginate(Filters=[{"Name": "tag:polis:private-cert", "Values": [self.a["id"]]}]):
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
        self.dispose_fixture()
        self.record(self.prefix + "clean.json", {"admissionSha256": self.token, "instanceId": iid,
                    "volumes": prior["volumes"], "fixtureVersions": 0, "status": "CLEAN"})
        return {"status": "CLEAN", "admissionId": self.a["id"]}


def handler(event, context):
    import boto3
    # No free-form output or private exception payload reaches CloudWatch.
    try:
        cfg = dict(os.environ)
        a = json.loads(cfg["ADMISSION"])
        if set(event) != {"action", "admissionId"} or event["admissionId"] != a["id"]:
            raise Unknown("REQUEST_NOT_ADMITTED")
        c = Control(boto3.client("ec2"), boto3.client("s3"), cfg)
        if event["action"] == "launch":
            result = c.launch()
        elif event["action"] in ("sweep", "cancel", "status"):
            result = c.reconcile(cancel=event["action"] == "cancel")
        else:
            raise Unknown("ACTION_NOT_ADMITTED")
        print(json.dumps({"healthy": 1, "unknown": 0}))
        return result
    except Exception:
        print(json.dumps({"healthy": 0, "unknown": 1}))
        # Fixed exception makes Lambda Errors/alarm fire without leaking raw SDK
        # responses, IDs, manifest fields or operator-supplied text.
        raise RuntimeError("TEARDOWN_UNKNOWN") from None
