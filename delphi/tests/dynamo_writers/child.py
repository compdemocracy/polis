#!/usr/local/bin/python
"""CI-only result producer: fixed data, actual resource and daemon protocol.

Does not replace production scripts or call providers. Its executable path is
selected explicitly by test-dynamo-writers.sh inside an isolated worker.
"""
import os
from datetime import datetime,timedelta,timezone
from polismath import job_child
from polismath.delphi_storage.resource import result_resource
from polismath.delphi_storage.postgres import RESULT_FAMILIES
from polismath.delphi_storage.codec import FAMILIES

job=job_child.JobContext.from_env(expected_stage=os.environ['DELPHI_STAGE'],zid=None,
    allowed_phases={'run','submit','recheck'},default_phase='run')
assert 'QUEUE_DATABASE_URL' not in os.environ
resource=result_resource()
phase=job.phase
cost={'llm_tokens_in':None,'llm_tokens_out':None,'provider_batches':None}
outcome='succeeded';after=None
if phase=='run':
    # Exercise every computational family with exact tagged data. Actual math
    # and language generation remain covered by their independent suites.
    for family in sorted(RESULT_FAMILIES-{'Delphi_NarrativeReports','report_narrative_store','Delphi_CollectiveStatement','Delphi_TopicAgendaSelections'}):
        special={'zid':'1','conversation_id':'1','zid_tick':'1:1','zid_tick_gid':'1:1:0'}
        for index in range(3 if family=='Delphi_CommentEmbeddings' else 1):
            row={k:(index if tag=='N' else special.get(k,str(index))) for k,tag in FAMILIES[family]['key']}
            row['generated_result_fixture']=True
            resource.Table(family).put_item(Item=row)
elif phase=='submit':
    job_child.request_provider_intent(job,provider='anthropic',model='fixed-provider-proof',batch={'request_count':1})
    cost['provider_batches']=[{'provider':'anthropic','batch_id':'generated-provider-batch','submitted_at':'2026-01-01T00:00:00Z'}]
    outcome='parked';after=(datetime.now(timezone.utc)+timedelta(seconds=1)).isoformat()
else:
    assert job.provider_batch_id=='generated-provider-batch'
    resource.Table('Delphi_NarrativeReports').put_item(Item={
        'rid_section_model':'rlocalwriter#section#fixed-provider-proof','timestamp':'2026-01-01T00:00:00Z',
        'report_id':'rlocalwriter','job_id':job.job_id,'report_data':'{"provider_fixture":true}'})
    cost['provider_batches']=[{'provider':'anthropic','batch_id':job.provider_batch_id,'submitted_at':'2026-01-01T00:00:00Z'}]
manifest=job_child.build_manifest(job,outcome=outcome,inputs=job_child.empty_inputs(),outputs=[],
    models={'embed':None,'topic':None,'narrative':'fixed-provider-proof' if phase!='run' else None},cost=cost,recheck_after=after)
job_child.write_manifest(job,manifest)
