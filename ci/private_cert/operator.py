#!/usr/bin/env python3
"""Scoped operator invocation. No SDK client is constructed on import."""
import argparse
import json
import re


def main():
    p = argparse.ArgumentParser()
    p.add_argument('action', choices=['launch', 'status', 'cancel'])
    p.add_argument('--admission-id', required=True)
    p.add_argument('--function', required=True)
    p.add_argument('--region', required=True)
    args = p.parse_args()
    if not re.fullmatch('[a-f0-9]{32}', args.admission_id):
        raise SystemExit('Invalid admission id')
    import boto3
    result = boto3.client('lambda', region_name=args.region).invoke(
        FunctionName=args.function, InvocationType='RequestResponse',
        Payload=json.dumps({'action': args.action, 'admissionId': args.admission_id}).encode())
    if result.get('FunctionError'):
        raise SystemExit('TEARDOWN_UNKNOWN; reconcile with status; never create another admission to bypass it')
    raw = result['Payload'].read(4097)
    if len(raw) > 4096:
        raise SystemExit('Unexpected control response')
    parsed = json.loads(raw)
    if set(parsed) != {'status', 'admissionId'} or parsed['admissionId'] != args.admission_id or parsed['status'] not in ('STAGED', 'RUNNING', 'CLEAN'):
        raise SystemExit('Unexpected control response')
    print(json.dumps(parsed))


if __name__ == '__main__': main()
