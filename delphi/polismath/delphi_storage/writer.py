"""Attempt-local compatibility writes, collected by the fenced daemon after exit.

SQLite is a private scratchpad shared by pipeline subprocesses, never a serving
store. Its base is the immutable publication captured at admission. No database
credentials or Dynamo connection are needed here. Failed attempts cannot publish.
"""
from __future__ import annotations
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
from types import SimpleNamespace
from .codec import FAMILIES, dumps, encode_family, item_from_python, to_python, encode_item
from .postgres import RESULT_FAMILIES, decode_rows
from .resource import _clauses


class WriterResource:
    def __init__(self):
        manifest = Path(os.environ['DELPHI_OUTPUT_MANIFEST'])
        frame = json.loads(Path(os.environ['DELPHI_FRAME']).read_text())
        base = frame.get('writer_base', {})
        if (not manifest.is_absolute() or base.get('schema') != 'delphi-writer-base/1'
                or frame['job_id'] != os.environ['DELPHI_JOB_ID']
                or frame['attempt_id'] != os.environ['DELPHI_ATTEMPT_ID']
                or frame['run_id'] != os.environ['DELPHI_RUN_ID']
                or frame['config'].get('result_backend') != 'postgres'
                or base['zid'] != frame['zid']):
            raise ValueError('Postgres writes require a bound queue attempt')
        self.directory = manifest.parent
        self.frame = frame
        self.connection = sqlite3.connect(self.directory/'writer.sqlite', timeout=30)
        self.connection.execute('PRAGMA busy_timeout=30000')
        self.connection.executescript('''CREATE TABLE IF NOT EXISTS binding(value TEXT PRIMARY KEY);
          CREATE TABLE IF NOT EXISTS items(family TEXT,key TEXT,item TEXT,PRIMARY KEY(family,key));
          CREATE TABLE IF NOT EXISTS dirty(family TEXT PRIMARY KEY);''')
        binding = dumps({k:frame[k] for k in ('env','job_id','run_id','attempt_id','lease_epoch')})
        with self.connection:
            self.connection.execute('BEGIN IMMEDIATE')
            row = self.connection.execute('SELECT value FROM binding').fetchone()
            if row is None:
                self.connection.execute('INSERT INTO binding VALUES(?)',(binding,))
                for family, rows in base['families'].items():
                    if family not in RESULT_FAMILIES:
                        raise ValueError('unsupported base family')
                    for item in rows:
                        self.connection.execute('INSERT INTO items VALUES(?,?,?)',
                            (family,self.key(family,item),dumps(item)))
            elif row[0] != binding:
                raise ValueError('attempt scratch binding mismatch')
        self.meta = SimpleNamespace(client=self)
        self.tables = SimpleNamespace(all=lambda:[self.Table(f) for f in sorted(RESULT_FAMILIES)])

    @staticmethod
    def key(family, item):
        return dumps([item[name] for name,_ in FAMILIES[family]['key']])

    def Table(self, name):
        if name not in RESULT_FAMILIES and name != 'Delphi_JobQueue':
            raise ValueError('unsupported writer family')
        return WriterTable(self,name)

    def list_tables(self, **kwargs):
        return {'TableNames':sorted(RESULT_FAMILIES)}

    def describe_table(self, TableName, **kwargs):
        self.Table(TableName)
        return {'Table':{'TableName':TableName,'TableStatus':'ACTIVE'}}

    def batch_get_item(self, RequestItems, **kwargs):
        return {'Responses':{f:[x for key in request['Keys'] if (x:=self.Table(f).get_item(Key=key).get('Item'))]
                             for f,request in RequestItems.items()},'UnprocessedKeys':{}}

    def reset(self):
        with self.connection:
            families = RESULT_FAMILIES - {'Delphi_NarrativeReports','report_narrative_store','Delphi_CollectiveStatement','Delphi_TopicAgendaSelections'}
            self.connection.executemany('DELETE FROM items WHERE family=?',[(f,) for f in families])
            self.connection.executemany('INSERT OR IGNORE INTO dirty VALUES(?)',[(f,) for f in families])

    def spool(self):
        result = {}
        total = 0
        # Emit the full snapshot, including empty families. No deleted item can
        # reappear through the previous-artifact edge. Preserve untouched rows.
        for family in sorted(RESULT_FAMILIES):
            rows = [json.loads(row[0]) for row in self.connection.execute('SELECT item FROM items WHERE family=?',(family,))]
            wire = encode_family(family,[item_from_python(row) for row in [row for tagged in rows for row in decode_rows(family,[tagged])]])
            total += len(wire)
            if len(wire)>67108864 or total>268435456:
                raise ValueError('result spool byte limit')
            filename = family+'.jsonl'
            path = self.directory/filename
            with path.open('xb') as f:
                f.write(wire)
            result[family] = dict(file=filename,sha256=hashlib.sha256(wire).hexdigest())
        return result


class WriterTable:
    def __init__(self, resource, name):
        self.resource = resource
        self.name = self.table_name = name
        self.meta = resource.meta
        self.table_status = 'ACTIVE'

    def load(self):
        return self.resource.describe_table(TableName=self.name)

    def _writable(self, kwargs):
        if self.name not in RESULT_FAMILIES:
            raise RuntimeError('queue state belongs to polis-jobs')
        if kwargs.get('ConditionExpression'):
            raise ValueError('conditional result writes are not supported')

    def put_item(self, Item, **kwargs):
        self._writable(kwargs)
        tagged = item_from_python(Item)
        # Validate all values and primary key before modifying the scratchpad.
        encode_family(self.name,[tagged])
        zid = str(self.resource.frame['zid'])
        for field in ('conversation_id','zid'):
            if field in Item and str(Item[field]) != zid:
                raise ValueError('writer conversation mismatch')
        with self.resource.connection:
            self.resource.connection.execute('INSERT OR REPLACE INTO items VALUES(?,?,?)',
                (self.name,self.resource.key(self.name,tagged),encode_item(self.name,tagged)))
            self.resource.connection.execute('INSERT OR IGNORE INTO dirty VALUES(?)',(self.name,))
        return {}

    def delete_item(self, Key, **kwargs):
        self._writable(kwargs)
        with self.resource.connection:
            self.resource.connection.execute('DELETE FROM items WHERE family=? AND key=?',
                (self.name,self.resource.key(self.name,item_from_python(Key))))
            self.resource.connection.execute('INSERT OR IGNORE INTO dirty VALUES(?)',(self.name,))
        return {}

    def update_item(self, Key, UpdateExpression, **kwargs):
        self._writable(kwargs)
        # Audited result producers use SET of whole attributes. Refuse every
        # other grammar instead of silently approximating Dynamo semantics.
        if not UpdateExpression.startswith('SET '):
            raise ValueError('unsupported result update')
        names = kwargs.get('ExpressionAttributeNames',{})
        values = kwargs.get('ExpressionAttributeValues',{})
        item = self.get_item(Key=Key).get('Item',dict(Key))
        for clause in UpdateExpression[4:].split(','):
            match = re.fullmatch(r'\s*([#\w]+)\s*=\s*(:\w+)\s*',clause)
            if match is None:
                raise ValueError('unsupported result update')
            item[names.get(match[1],match[1])] = values[match[2]]
        self.put_item(Item=item)
        return {'Attributes':item} if kwargs.get('ReturnValues')=='ALL_NEW' else {}

    @contextmanager
    def batch_writer(self, **kwargs):
        self._writable(kwargs)
        yield self

    def get_item(self, Key, **kwargs):
        items = self._read(dict(kwargs,Key=Key))['Items']
        return {'Item':items[0]} if items else {}

    def query(self, **kwargs):return self._read(kwargs)
    def scan(self, **kwargs):return self._read(kwargs)

    def _read(self, params):
        names,values = params.get('ExpressionAttributeNames',{}),params.get('ExpressionAttributeValues',{})
        conditions = _clauses(params.get('KeyConditionExpression'),names,values)
        conditions += [('=',k,v) for k,v in params.get('Key',{}).items()]
        matches = lambda item,clauses: all(item.get(k)==v if op=='=' else isinstance(item.get(k),str) and item[k].startswith(v) for op,k,v in clauses)
        tagged = [json.loads(row[0]) for row in self.resource.connection.execute('SELECT item FROM items WHERE family=?',(self.name,))]
        items = [row for item in tagged for row in decode_rows(self.name,[item])]
        items = [item for item in items if matches(item,conditions)]
        keys = [k for k,_ in FAMILIES[self.name]['key']]
        indexes={'ConversationIndex':'created_at','ReportIdTimestampIndex':'timestamp','zid-created_at-index':'created_at'}
        index=params.get('IndexName')
        if index and index not in indexes:raise ValueError('unsupported result index')
        ordering=([indexes[index]] if index else [])+keys
        if index:items=[item for item in items if indexes[index] in item]
        items.sort(key=lambda item:tuple(item[k] for k in ordering),reverse=params.get('ScanIndexForward') is False)
        start=params.get('ExclusiveStartKey')
        if start:
            position=next((i for i,item in enumerate(items) if all(item.get(k)==v for k,v in start.items())),None)
            if position is None:raise ValueError('stale writer cursor')
            items=items[position+1:]
        limit=params.get('Limit',1000)
        if type(limit) is not int or limit<1:raise ValueError('invalid result limit')
        page=items[:limit]
        filtered=[item for item in page if matches(item,_clauses(params.get('FilterExpression'),names,values))]
        result={'Items':filtered,'Count':len(filtered),'ScannedCount':len(page)}
        if len(items)>limit:result['LastEvaluatedKey']={k:page[-1][k] for k in keys}
        if params.get('ProjectionExpression'):
            fields=[names.get(k.strip(),k.strip()) for k in params['ProjectionExpression'].split(',')]
            result['Items']=[{k:v for k,v in item.items() if k in fields} for item in filtered]
        if params.get('Select')=='COUNT':result.pop('Items')
        return result
