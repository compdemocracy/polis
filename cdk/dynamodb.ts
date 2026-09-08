import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

/**
 * Delphi DynamoDB tables.
 *
 * OWNERSHIP, READ THIS FIRST. The other `Delphi_*` tables are NOT managed by
 * CloudFormation. They are created imperatively by
 * `delphi/create_dynamodb_tables.py`, which the Delphi container runs from its
 * CMD on every start ("Ensuring DynamoDB tables are set up (runs in all
 * environments)"), and which the compose stacks and CI also run directly. CDK's
 * only involvement until now was `iamRoles.ts`, which grants item-level actions
 * on `arn:aws:dynamodb:us-east-1:<account>:table/Delphi_*` — a wildcard, so it
 * already covers any new table, but it grants no CreateTable/ListTables, so in
 * AWS that bootstrap script cannot actually create anything.
 *
 * `Delphi_JobActiveGuard` is new in P-003 S3 and is the table the server writes
 * its active-work guard rows into. It must exist before the server change is
 * deployed, or every submission silently takes the degraded (un-deduplicated)
 * path. Rather than leave that to a manual `aws dynamodb create-table`, the
 * table is defined here so `cdk deploy` creates it.
 *
 * Because CloudFormation cannot adopt a table that already exists, do NOT
 * hand-create `Delphi_JobActiveGuard` in an account where this stack is
 * deployed: let the deploy create it. The removal policy is RETAIN, so a stack
 * operation cannot take live guard rows with it.
 *
 * Schema notes, mirroring `delphi/create_dynamodb_tables.py` and
 * `delphi/docs/JOB_QUEUE_SCHEMA.md`:
 *  - single `guard_key` string partition key, no sort key, no indexes;
 *  - PAY_PER_REQUEST, like the other Delphi tables;
 *  - deliberately NO time-to-live attribute. An automatic expiry could release
 *    a submission scope while paid provider work is still live. Guard rows are
 *    deleted by the server under an exact job/version condition instead.
 *
 * No tags are set here: no other resource in this stack sets any, so tagging
 * only this one would be the odd case out.
 */
export default (self: Construct) => {
  const delphiJobActiveGuardTable = new dynamodb.Table(
    self,
    'DelphiJobActiveGuardTable',
    {
      tableName: 'Delphi_JobActiveGuard',
      partitionKey: {
        name: 'guard_key',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    }
  );

  return { delphiJobActiveGuardTable };
};
