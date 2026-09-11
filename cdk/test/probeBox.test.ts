import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ProbeBox, ProbeConfig, validateProbeConfig } from '../probeBox';
const config: ProbeConfig = {
 schema:'polis-probe-box/1',id:'public-fixture',account:'111111111111',region:'us-east-1',ami:'ami-'+'1'.repeat(17),
 vpcId:'vpc-12345678',subnetCidr:'10.0.240.0/24',availabilityZone:'us-east-1a',resolverAddress:'10.0.0.2',
 replicaHost:'public-fixture-replica.abc.us-east-1.rds.amazonaws.com',replicaSecurityGroupId:'sg-12345678',database:'polis',
 primaryHost:'public-fixture-primary.abc.us-east-1.rds.amazonaws.com',primarySecurityGroupId:'sg-87654321',
 adminSecretArn:'arn:aws:secretsmanager:us-east-1:111111111111:secret:public-fixture-admin',
 provisionOwner:'polis-probe-login:public-fixture',s3PrefixListId:'pl-12345678',
 reviewerRoleArns:['arn:aws:iam::111111111111:role/public-fixture-reader'],assetPublisherRoleArn:'arn:aws:iam::111111111111:role/public-fixture-publisher',
 operatorRoleArns:['arn:aws:iam::111111111111:role/public-fixture-operator'],notificationTopicArn:'arn:aws:sns:us-east-1:111111111111:public-fixture'};
function build(input: ProbeConfig = config){const app=new cdk.App();const stack=new cdk.Stack(app,'Probe',{env:{account:config.account,region:config.region}});new ProbeBox(stack,'Box',input);return Template.fromStack(stack);}
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
test('operator SSO trust and constrained infrastructure authority',()=>{const j=build().toJSON(),role=named(j,'BoxOperator','AWS::IAM::Role');
 expect(JSON.stringify(role.AssumeRolePolicyDocument)).toContain(config.operatorRoleArns[0]);
 const policy=named(j,'BoxOperatorDefaultPolicy').PolicyDocument;
 expect(JSON.stringify(policy)).not.toContain('lambda:');
 expect(JSON.stringify(policy)).not.toContain(config.adminSecretArn);
 const launches=policy.Statement.filter((s:any)=>s.Action==='ec2:RunInstances');expect(launches).toHaveLength(2);
 for(const s of launches){expect(s.Condition.Bool['ec2:IsLaunchTemplateResource']).toBe('true');expect(s.Condition.ArnEquals['ec2:LaunchTemplate']).toBeDefined();}
 expect(policy.Statement.filter((s:any)=>s.Action==='iam:PassRole')).toHaveLength(2);
});
test('native reader secret and disposable provisioner have no automatic database action',()=>{const t=build(),j=t.toJSON();t.resourceCountIs('AWS::SecretsManager::Secret',1);
 expect(resources(j,'AWS::SecretsManager::Secret')[0].DeletionPolicy).toBe('Retain');
 t.resourceCountIs('AWS::EC2::LaunchTemplate',2);t.resourceCountIs('AWS::IAM::InstanceProfile',2);
 const policy=JSON.stringify(named(j,'BoxProvisionerDefaultPolicy').PolicyDocument);
 expect(policy).toContain(config.adminSecretArn);expect(policy).toContain('boot/provision/');
 for(const no of ['ec2:Run','ssm:','/results/${','s3:List','s3:Delete','images/*'])expect(policy).not.toContain(no);
 const boot=JSON.stringify(named(j,'BoxProvisionTemplate').LaunchTemplateData);
 expect(boot).toContain('provision');expect(boot).not.toContain('password');
});
test('private buckets and native worker alarms without scheduled controller',()=>{const t=build(),j=t.toJSON();t.resourceCountIs('AWS::S3::Bucket',3);t.resourceCountIs('AWS::Events::Rule',0);t.resourceCountIs('AWS::CloudWatch::Alarm',2);
 for(const b of resources(j,'AWS::S3::Bucket')){expect(Object.values(b.Properties.PublicAccessBlockConfiguration)).toEqual([true,true,true,true]);expect(b.DeletionPolicy).toBe('Retain');}
 const p=JSON.stringify(resources(j,'AWS::S3::BucketPolicy'));for(const sid of ['PrivateReaders','WorkerWrites','CreateOnly','PrivateEndpoint','ProvisionResultsAuthority'])expect(p).toContain(sid);
 for(const alarm of resources(j,'AWS::CloudWatch::Alarm')){expect(alarm.Properties.Namespace).toBe('AWS/EC2');expect(alarm.Properties.AlarmActions).toEqual([config.notificationTopicArn]);}
});
test('recursive synth gate: zero Lambda, layer, provider or custom resources',()=>{
 const visit=(node:any):void=>{if(!node||typeof node!=='object')return;
  if(typeof node.Type==='string'){expect(node.Type.startsWith('AWS::Lambda::')).toBe(false);expect(node.Type.startsWith('Custom::')).toBe(false);expect(node.Type).not.toBe('AWS::CloudFormation::CustomResource');}
  expect(node.ServiceToken).toBeUndefined();for(const value of Object.values(node))visit(value);
 };visit(build().toJSON());
 expect(()=>validateProbeConfig({...config,postgresLayerArn:'obsolete'} as ProbeConfig)).toThrow();
});
test.each(['ami','replicaHost','primaryHost','account','database'] as const)('invalid %s fails before synth',field=>{expect(()=>validateProbeConfig({...config,[field]:'!invalid'})).toThrow();});

test.each([false,true])('read target and provisioner rules remain distinct (live=%s)',live=>{
 const input={...config,...(live?{replicaHost:config.primaryHost,replicaSecurityGroupId:config.primarySecurityGroupId}:{})};
 expect(validateProbeConfig(input)).toBe(input);
 const j=build(input).toJSON();
 const ingress=resources(j,'AWS::EC2::SecurityGroupIngress').map(r=>r.Properties);
 const db=ingress.filter(r=>r.FromPort===5432);
 expect(db).toHaveLength(2);
 expect(db.map(r=>r.GroupId)).toEqual([input.replicaSecurityGroupId,input.primarySecurityGroupId]);
 expect(db[0].SourceSecurityGroupId).not.toEqual(db[1].SourceSecurityGroupId);
 const key=(r:any)=>JSON.stringify([r.GroupId,r.SourceSecurityGroupId,r.IpProtocol,r.FromPort,r.ToPort]);
 expect(new Set(ingress.map(key)).size).toBe(ingress.length);
 expect(named(j,'BoxWorkerSg').SecurityGroupEgress[0].DestinationSecurityGroupId).toBe(input.replicaSecurityGroupId);
 expect(named(j,'BoxProvisionSg').SecurityGroupEgress[0].DestinationSecurityGroupId).toBe(input.primarySecurityGroupId);
 expect(JSON.stringify(j.Outputs)).toContain(input.replicaHost);
 expect(JSON.stringify(j.Outputs)).toContain(input.primaryHost);
 const policy=JSON.stringify(named(j,'BoxWorkerDefaultPolicy').PolicyDocument);
 expect(policy).not.toContain(input.adminSecretArn);
});
