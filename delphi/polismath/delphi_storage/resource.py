"""Read-only compatibility surface for published PostgreSQL result families.

Selection is explicit; a PostgreSQL error never opens a DynamoDB connection.
Legacy writers must move through graph finalization instead of mutating results.
"""
from __future__ import annotations
import os
import json
import re
from decimal import Decimal
from types import SimpleNamespace
from typing import Any
from .codec import FAMILIES, canonical_number, decode_family, dumps, item_from_python
from .postgres import RESULT_FAMILIES, decode_rows


def result_resource(service_name='dynamodb', **kwargs):
    backend = os.environ.get('DELPHI_RESULT_BACKEND', 'dynamodb')
    if backend not in ('dynamodb', 'postgres'):
        raise ValueError('invalid DELPHI_RESULT_BACKEND')
    if service_name != 'dynamodb' or backend == 'dynamodb':
        import boto3
        return boto3.resource(service_name, **kwargs)
    return PostgresResource()


def _clauses(expression, names, values):
    if expression is None:
        return []
    if not isinstance(expression, str):
        node=expression.get_expression()
        op=node['operator']; args=node['values']
        if op=='AND':
            return _clauses(args[0],names,values)+_clauses(args[1],names,values)
        if op in ('=', 'begins_with'):
            return [(op,args[0].name,args[1])]
        raise ValueError(f'unsupported result condition {op}')
    result=[]
    for part in re.split(r'\s+AND\s+',expression,flags=re.I):
        equal=re.fullmatch(r'\s*([#\w]+)\s*=\s*(:\w+)\s*',part)
        prefix=re.fullmatch(r'\s*begins_with\(\s*([#\w]+)\s*,\s*(:\w+)\s*\)\s*',part)
        match=equal or prefix
        if match is None:
            raise ValueError(f'unsupported result expression {part}')
        result.append(('=' if equal else 'begins_with',names.get(match[1],match[1]),values[match[2]]))
    return result


def _tag(value):
    if isinstance(value,str):return 'S',value
    if isinstance(value,bool):return 'BOOL',value
    if isinstance(value,(int,Decimal)):return 'N',canonical_number(str(value))
    raise ValueError('result filter requires string, boolean or exact numeric value')


class PostgresResource:
    def __init__(self, connection=None):
        self.env=os.environ.get('DELPHI_RESULT_ENV')
        if not self.env:
            raise ValueError('DELPHI_RESULT_ENV is required for Postgres results')
        self.connection=connection
        self.meta=SimpleNamespace(client=self)
        self.tables=SimpleNamespace(all=lambda: [self.Table(f) for f in sorted(RESULT_FAMILIES)])

    def _connect(self):
        if self.connection is None:
            import psycopg2
            dsn=os.environ.get('DELPHI_RESULT_DATABASE_URL') or os.environ.get('DATABASE_URL')
            if not dsn:
                raise ValueError('DELPHI_RESULT_DATABASE_URL or DATABASE_URL is required')
            self.connection=psycopg2.connect(dsn,application_name='delphi-pg-results/1')
            self.connection.autocommit=True
        return self.connection

    def Table(self,name):
        if name not in RESULT_FAMILIES and name != 'Delphi_JobQueue':
            raise ValueError(f'{name} is not a published result family; use the queue graph API')
        return PostgresTable(self,name)

    def list_tables(self,**kwargs):return {'TableNames':sorted(RESULT_FAMILIES)}
    def describe_table(self,TableName,**kwargs):
        self.Table(TableName)
        with self._connect().cursor() as cursor:
            cursor.execute('SELECT 1 FROM public.delphi_result_current_rows LIMIT 0')
        return {'Table':{'TableName':TableName,'TableStatus':'ACTIVE'}}
    def batch_get_item(self,RequestItems,**kwargs):
        response={}
        for family,request in RequestItems.items():
            table=self.Table(family)
            response[family]=[item for key in request['Keys'] if (item:=table.get_item(Key=key).get('Item')) is not None]
        return {'Responses':response,'UnprocessedKeys':{}}


class PostgresTable:
    def __init__(self,resource,name):
        self.resource,self.name=resource,name
        self.table_name=name
        self.meta=resource.meta

    def load(self):return self.resource.describe_table(TableName=self.name)
    def get_item(self,**kwargs):
        rows=self._read(kwargs,True)
        if not rows['Items']:return {}
        item=rows['Items'][0]
        if self.name=='Delphi_JobQueue' and not item.get('archived'):
            with self.resource._connect().cursor() as cursor:
                cursor.execute('SELECT public.pq_job_status(%s::text,%s::uuid)',[self.resource.env,item['job_id']])
                status=cursor.fetchall()[0][0]
                attempt=(status or {}).get('attempt_id')
                entries=[]
                if attempt:
                    cursor.execute("""SELECT to_char(ts AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                        CASE stream WHEN 'stderr' THEN 'ERROR' ELSE 'INFO' END,line
                        FROM public.pq_attempt_logs(%s::text,%s::uuid,NULL,1000)
                        WHERE stream IN ('stdout','stderr')""",[self.resource.env,attempt])
                    entries=[dict(timestamp=timestamp,level=level,message=line) for timestamp,level,line in cursor.fetchall()]
            item={**item,'logs':json.dumps({'entries':entries}),'log_attempt_id':attempt}
        return {'Item':item}
    def query(self,**kwargs):return self._read(kwargs)
    def scan(self,**kwargs):return self._read(kwargs)
    def _read(self,params,get=False):
        conditions=_clauses(params.get('KeyConditionExpression'),params.get('ExpressionAttributeNames',{}),params.get('ExpressionAttributeValues',{}))
        conditions += [('=',k,v) for k,v in params.get('Key',{}).items()]
        binds=[self.resource.env,self.name]
        where=['env=%s','family=%s']
        scope=os.environ.get('DELPHI_RESULT_SCOPE')
        if scope:where.append('scope_key=%s');binds.append(scope)
        for op,key,value in conditions:
            tag,wire=_tag(value)
            if op=='begins_with':
                if tag!='S':raise ValueError('begins_with requires a string')
                where.append('starts_with(item->%s->>%s,%s)');binds.extend([key,tag,wire])
            else:
                where.append('item->%s = %s::jsonb');binds.extend([key,dumps({tag:wire})])
        with self.resource._connect().cursor() as cursor:
            if self.name == 'Delphi_JobQueue':
                cursor.execute('SELECT row_to_json(j) FROM public.delphi_result_jobs j WHERE env=%s'+(' AND scope_key=%s' if scope else ''), [self.resource.env,scope] if scope else [self.resource.env])
                jobs=[row[0] for row in cursor.fetchall()]
                active_ids={job['job_id'] for job in jobs}
                archive_where='env=%s AND family=%s'
                archive_binds=[self.resource.env,self.name]
                if scope:archive_where+=' AND scope_key=%s';archive_binds.append(scope)
                cursor.execute('SELECT zid,scope_key,generation,codec_wire FROM public.delphi_result_legacy_controls WHERE '+archive_where+' ORDER BY zid,scope_key',archive_binds)
                records=[]
                for zid,archive_scope,generation,wire in cursor.fetchall():
                    family,_=decode_family(wire.encode('utf-8'))
                    archived=[json.loads(line) for line in wire.splitlines()[1:]]
                    if family!=self.name:raise ValueError('legacy control family mismatch')
                    for tagged in archived:
                        if tagged['job_id']['S'] not in active_ids:
                            records.append((zid,archive_scope,generation,{**tagged,'archived':{'BOOL':True}}))
                records += [(job.get('conversation_id','queue'),'queue',0,item_from_python(job)) for job in jobs]
            else:
                cursor.execute('SELECT zid,scope_key,generation,item FROM public.delphi_result_current_rows WHERE '+' AND '.join(where)+' ORDER BY zid,scope_key,item_key::text',binds)
                records=cursor.fetchall()
        generations={dumps([str(zid),scope]):str(generation) for zid,scope,generation,_ in records}
        start=params.get('ExclusiveStartKey')
        if start and start.get('_polis_pg_generations')!=generations:
            raise ValueError('result generation changed; restart pagination')
        items=[];seen={}
        for zid,scope,generation,tagged in records:
            # decode_family validates sort order; one-row decoding retains every AV type.
            item=decode_rows(self.name,[tagged])[0]
            if not all(item.get(k)==v if op=='=' else isinstance(item.get(k),str) and item[k].startswith(v) for op,k,v in conditions):continue
            key=dumps([item_from_python(item)[name] for name,_ in FAMILIES[self.name]['key']])
            if key in seen:
                if seen[key]!=item:raise ValueError('ambiguous result scopes; set DELPHI_RESULT_SCOPE')
                continue
            seen[key]=item;items.append(item)
        keys=[key for key,_ in FAMILIES[self.name]['key']]
        index_order={'ConversationIndex':'created_at','StatusCreatedIndex':'created_at','ReportIdTimestampIndex':'timestamp','zid-created_at-index':'created_at'}
        index=params.get('IndexName')
        if index and index not in index_order:raise ValueError('unsupported result index')
        ordering=([index_order[index]] if index else [])+keys
        if index:items=[item for item in items if item.get(index_order[index]) is not None]
        items.sort(key=lambda item:tuple(item[key] for key in ordering))
        if params.get('ScanIndexForward') is False:items.reverse()
        if start:
            startkey={k:v for k,v in start.items() if k!='_polis_pg_generations'}
            position=next((i for i,item in enumerate(items) if all(item.get(k)==v for k,v in startkey.items())),None)
            if position is None:raise ValueError('stale result cursor')
            items=items[position+1:]
        limit=params.get('Limit',1000)
        if not isinstance(limit,int) or limit<1:raise ValueError('invalid result limit')
        page=items[:limit]
        filters=_clauses(params.get('FilterExpression'),params.get('ExpressionAttributeNames',{}),params.get('ExpressionAttributeValues',{}))
        filtered=[item for item in page if all(item.get(k)==v if op=='=' else isinstance(item.get(k),str) and item[k].startswith(v) for op,k,v in filters)]
        result={'Items':filtered,'Count':len(filtered),'ScannedCount':len(page)}
        if len(items)>limit:
            result['LastEvaluatedKey']={**{key:page[-1][key] for key in keys},'_polis_pg_generations':generations}
        if params.get('ProjectionExpression'):
            projected=[params.get('ExpressionAttributeNames',{}).get(k.strip(),k.strip()) for k in params['ProjectionExpression'].split(',')]
            result['Items']=[{k:v for k,v in item.items() if k in projected} for item in filtered]
        return result

    def __getattr__(self,name):
        if name in ('put_item','update_item','delete_item','batch_writer','delete'):
            raise RuntimeError('Published Delphi results are immutable; submit a new graph run')
        raise AttributeError(name)
