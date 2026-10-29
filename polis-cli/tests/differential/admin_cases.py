"""Dedicated existing-route scenarios; errors describe current fixture limits."""
from cases import C, R

def admin_cases():
    rows=[]
    def add(command,args=(),exit=0,scope='live',actor='owner'):
        rows.append(dict(command=command,args=command.split()+list(args),expected_exit=exit,scope=scope,actor=actor,stdin=None))
    c=['--conversation',C];r=['--report',R]
    add('node doctor');add('node database');add('account domain list')
    for name in ['metadata view','metadata choices','participant group','vote mine','vote famous','agenda list','invite mine list','participant invitation-status','comment next']:
        add(name,c,actor='participant')
    add('invite mine export',c+['--output','mine.csv'],actor='participant')
    add('participant xid capability-export',['--key-file','capability.txt','--output','capability.csv'])
    add('participant allowlist view',c);add('participant allowlist export',c+['--output','allowlist.csv'])
    add('conversation started',actor='admin');add('conversation activity',actor='admin');add('conversation preload',c)
    add('participant activity',c);add('ops conversations list',actor='admin')
    add('agenda priorities',c,scope='empty-store')
    add('invite email lookup',['--code-file','verification.txt'])
    add('report export-results',c+['--filename','polis-export-'+C+'-1700000000.zip','--output','export-capability.json'],scope='capability-only')
    add('delphi overview',r)
    add('delphi logs',['--job','generated-job'])
    add('report topic-stats',r,scope='empty-store')
    for kind in ['list','consensus','topics']:
        add('report feed '+kind,r+['--output','feed-'+kind],scope='empty-store')
    add('ops status',exit=1,scope='disabled-feature');add('ops page',['--page','overview'],exit=1,scope='disabled-feature')
    add('ops performance');add('participant query',c+['--answers','1'])
    add('account domain replace',['--domains','generated.example','--yes'])
    add('participant allowlist import',c+['--from','allowlist.json','--yes'])
    add('math correlation',r+['--yes'])
    add('report export-start',c+['--yes'])
    for name in ['subscribe','unsubscribe']:
        add('notification '+name,c+['--email','owner@example.invalid','--signature-file',name+'.txt','--yes'])
    add('notification set',c+['--email','owner@example.invalid','--state','subscribe','--yes'])
    add('comment translations',c+['--statement','0','--language','en','--yes'],exit=1,scope='server-limitation')
    add('delphi narrative run',r+['--yes'],exit=7,scope='missing-store')
    add('account verify',['--code-file','verification.txt','--yes'])
    add('delphi run',r+['--yes'],actor='admin')
    add('delphi batch',r+['--model','generated-model','--yes'],actor='admin')
    add('topic moderate',c+['--action','accept','--statements','1','--yes'])
    add('collective generate',r+['--topic','generated#0#1','--name','Generated topic','--yes'],exit=7,scope='permission-refusal')
    for name in ['add','replace','remove']:
        add('agenda '+name,c+([] if name=='remove' else ['--from','agenda-replace.json' if name=='replace' else 'agenda.json'])+['--yes'],actor='participant')
    add('comment flag',c+['--statement','1','--as-important','true','--yes'],actor='participant')
    add('conversation upvote',c+['--yes'])
    for name in ['star','trash']:
        add('comment '+name,c+['--statement','1','--state','on','--yes'],exit=7 if name=='star' else 0,scope='persisted-then-error' if name=='star' else 'live',actor='participant')
    add('report comments select',r+['--statement','0','--include','true','--yes'])
    add('account edit',['--name','Generated edited account','--yes'])
    add('math refresh',c+['--type','update','--yes'])
    add('report edit',r+['--name','Generated edited report','--yes'])
    add('conversation email-link',c+['--yes'],exit=7,scope='blocked-mail')
    add('participant highlight set',c+['--participant','0','--moderation','1','--yes'])
    add('invite email send',['--email','generated-invite@example.invalid','--yes'],exit=7,scope='blocked-mail')
    add('account invite',c+['--emails','generated-member@example.invalid','--yes'],exit=7,scope='blocked-mail')
    add('support contribute',['--agreement-version','1','--name','Generated contributor','--email','owner@example.invalid','--github-id','generated','--company-name','Generated','--yes'],exit=7,scope='missing-table')
    return rows
