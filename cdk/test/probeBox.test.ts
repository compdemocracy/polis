import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ProbeBox, ProbeConfig, validateProbeConfig } from '../probeBox';
const config: ProbeConfig = {
 schema:'polis-probe-box/1',id:'public-fixture',account:'111111111111',region:'us-east-1',ami:'ami-'+'1'.repeat(17),
 vpcId:'vpc-12345678',subnetCidr:'10.0.240.0/24',availabilityZone:'us-east-1a',resolverAddress:'10.0.0.2',
 replicaHost:'public-fixture-replica.abc.us-east-1.rds.amazonaws.com',replicaSecurityGroupId:'sg-12345678',database:'polis',
 primaryHost:'public-fixture-primary.abc.us-east-1.rds.amazonaws.com',primarySecurityGroupId:'sg-87654321',
 adminSecretArn:'arn:aws:secretsmanager:us-east-1:111111111111:secret:public-fixture-admin',
 postgresLayerArn:'arn:aws:lambda:us-east-1:111111111111:layer:public-fixture-postgres:1',s3PrefixListId:'pl-12345678',
 reviewerRoleArns:['arn:aws:iam::111111111111:role/public-fixture-reader'],assetPublisherRoleArn:'arn:aws:iam::111111111111:role/public-fixture-publisher',
 githubRepo:'example/example',githubEnvironment:'probe-box',githubRef:'refs/heads/edge',notificationTopicArn:'arn:aws:sns:us-east-1:111111111111:public-fixture'};
function build(){const app=new cdk.App();const stack=new cdk.Stack(app,'Probe',{env:{account:config.account,region:config.region}});new ProbeBox(stack,'Box',config);return Template.fromStack(stack);}
const resources=(j:any,t:string):any[]=>Object.values(j.Resources).filter((r:any)=>r.Type===t);
function named(j:any,prefix:string,type?:string):any{return (Object.entries(j.Resources).find(([id,r]:any)=>id.startsWith(prefix)&&(!type||r.Type===type))![1] as any).Properties;}
test('existing VPC isolated routes and no public ingress',()=>{const t=build(),j=t.toJSON();
 for(const type of ['AWS::EC2::VPC','AWS::EC2::NatGateway','AWS::EC2::InternetGateway','AWS::EC2::Route','AWS::EC2::Instance','AWS::SSM::Document'])t.resourceCountIs(type,0);
 t.resourceCountIs('AWS::EC2::Subnet',1);t.resourceCountIs('AWS::EC2::VPCEndpoint',2);
 const sg=named(j,'BoxWorkerSg');expect(sg.SecurityGroupIngress).toBeUndefined();expect(sg.SecurityGroupEgress).toHaveLength(3);expect(JSON.stringify(sg)).not.toContain('0.0.0.0/0');});
test('fixed encrypted disposable launch and restricted metadata',()=>{const d=resources(build().toJSON(),'AWS::EC2::LaunchTemplate')[0].Properties.LaunchTemplateData;
 expect(d.ImageId).toBe(config.ami);expect(d.KeyName).toBeUndefined();expect(d.MetadataOptions.HttpTokens).toBe('required');expect(d.MetadataOptions.HttpPutResponseHopLimit).toBe(1);
 expect(d.InstanceInitiatedShutdownBehavior).toBe('terminate');expect(d.NetworkInterfaces[0].AssociatePublicIpAddress).toBe(false);
 expect(d.BlockDeviceMappings.map((b:any)=>[b.Ebs.Encrypted,b.Ebs.DeleteOnTermination])).toEqual([[true,true],[true,true]]);});
test('worker cannot read evidence or primary secret or administer resources',()=>{const policy=named(build().toJSON(),'BoxWorkerDefaultPolicy').PolicyDocument,raw=JSON.stringify(policy);
 for(const forbidden of ['ssm:','ec2:Run','logs:','s3:Delete','s3:List',config.adminSecretArn])expect(raw).not.toContain(forbidden);
 const writes=policy.Statement.filter((s:any)=>s.Action==='s3:PutObject');expect(writes).toHaveLength(2);expect(JSON.stringify(writes)).toContain('${ec2:SourceInstanceARN}');
 expect(writes.some((s:any)=>s.Condition.StringEquals['s3:if-none-match']==='*')).toBe(true);
 for(const s of policy.Statement.filter((s:any)=>s.Action==='s3:GetObject'))expect(JSON.stringify(s.Resource)).not.toContain('results/');});
test('public principal only invokes controller with exact environment and branch',()=>{const j=build().toJSON(),role=named(j,'BoxDispatch','AWS::IAM::Role');
 expect(role.AssumeRolePolicyDocument.Statement[0].Condition.StringEquals).toEqual({'token.actions.githubusercontent.com:aud':'sts.amazonaws.com','token.actions.githubusercontent.com:sub':'repo:example/example:environment:probe-box','token.actions.githubusercontent.com:ref':'refs/heads/edge'});
 expect(named(j,'BoxDispatchDefaultPolicy').PolicyDocument.Statement.map((s:any)=>s.Action)).toEqual(['lambda:InvokeFunction']);});
test('reader login schema operation is separate and secret retained',()=>{const t=build(),j=t.toJSON();t.resourceCountIs('AWS::SecretsManager::Secret',1);
 expect(resources(j,'AWS::SecretsManager::Secret')[0].DeletionPolicy).toBe('Retain');const c=resources(j,'AWS::CloudFormation::CustomResource')[0].Properties;
 expect(c.PrimaryHost).toBe(config.primaryHost);expect(c.ReaderSecretArn).toBeDefined();expect(JSON.stringify(c)).not.toContain('password');});
test('private receipt buckets and independent sweep alarms',()=>{const t=build(),j=t.toJSON();t.resourceCountIs('AWS::S3::Bucket',3);t.resourceCountIs('AWS::Events::Rule',1);t.resourceCountIs('AWS::CloudWatch::Alarm',2);
 for(const b of resources(j,'AWS::S3::Bucket')){expect(Object.values(b.Properties.PublicAccessBlockConfiguration)).toEqual([true,true,true,true]);expect(b.DeletionPolicy).toBe('Retain');}
 const p=JSON.stringify(resources(j,'AWS::S3::BucketPolicy'));for(const sid of ['PrivateReaders','WorkerWrites','CreateOnly','PrivateEndpoint'])expect(p).toContain(sid);});
test.each(['ami','replicaHost','primaryHost','account','database'] as const)('invalid %s fails before synth',field=>{expect(()=>validateProbeConfig({...config,[field]:'!invalid'})).toThrow();});
