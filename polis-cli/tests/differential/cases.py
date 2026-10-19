"""Explicit command census; adding an implemented command requires a scenario.

Each scenario declares whether it proves a successful call or only a refusal.
The latter is never counted as a working backend implementation.
"""
C = '2p027generated'
R = 'r2p027generated'

def cases():
    rows=[]
    def add(command,args=(),*,exit=0,scope='live',stdin=None,actor='owner'):
        rows.append(dict(command=command,args=command.split()+list(args),expected_exit=exit,scope=scope,stdin=stdin,actor=actor))
    # Local discovery is exercised as commands, not substituted for API calls.
    for command,args in [('schema',[]),('help',[]),('completion',['bash']),('tutorial',[]),('agent guide',[]),('conversation share',[C]),('plan upgrade',[]),('plan manage',[])]:
        add(command,args,scope='local')
    add('auth login',['--with-token'],stdin='owner')
    add('auth status');add('auth token',scope='credential')
    add('account view');add('plan view')
    add('conversation list');add('conversation view',[C]);add('conversation stats',[C])
    add('math view',['--conversation',C])
    add('api',['/api/v3/users'])
    add('join',[C],actor='participant')
    for path,args in [
      ('statement list',[]),('statement view',['0']),('moderate list',['--status','all']),
      ('participant list',[]),('participant status',[]),('participant xid list',[]),
      ('vote list',['--pid','0']),('report list',[]),('participant highlight list',[]),
      ('participant group-members',[]),('participant locations',['--group','0']),
      ('metadata question list',[]),('metadata answer list',[]),('invite code list',[]),
      ('invite wave list',[]),('invite list',[]),('invite status',[])]:
        add(path,[*args,'--conversation',C])
    add('context list');add('conversation uuid',[C]);add('report view',[R])
    add('report stats',[R]);add('report statements list',[R])
    add('participant export',['--conversation',C,'--output','participants.csv'])
    add('participant xid export',['--conversation',C,'--output','xids.csv'])
    add('invite export',['--conversation',C,'--output','invites.csv'])
    # Stored-result fixtures intentionally have no computation/provider backing.
    # These cases prove the current missing-store/error contract, not analysis.
    for path,args in [
      ('topic list',['--conversation',C]),('topic statements',['generated#0#1','--conversation',C]),
      ('topic hierarchy',['--conversation',C]),('topic proximity',['--conversation',C]),
      ('topic stats',['--conversation',C]),('report topics',[R]),
      ('collective statements',[R]),('collective list',['--report',R]),('collective view',['generated#0#1']),
      ('delphi status',['--report',R]),('delphi results',['--report',R]),
      ('delphi narrative view',['--report',R]),('delphi visualization view',['--report',R]),
      ('delphi show',[R]),
      ('report export',[R,'--type','format.json','--output','report.json'])]:
        add(path,args,exit={'topic list':1,'topic statements':6,'topic hierarchy':1,'topic proximity':1,'topic stats':0,'report topics':1,'collective statements':6,'collective list':6,'collective view':6,'delphi status':6,'delphi results':1,'delphi narrative view':1,'delphi visualization view':6,'delphi show':1,'report export':0}[path],scope='missing-store')
    # Import rejection uses a real file, parsed by the real contract; these do
    # not claim a successful provider result import or replace its own suite.
    for path in ['collective import','delphi statement import','delphi narrative import']:
        add(path,[C,'invalid-result.json','--report',R],exit=2,scope='invalid-input')
    # The collective-statement export route is served; this fixture has no
    # stored topics behind it, so these rows record the store's refusal, not a
    # successful export (the server suite covers that). The narrative routes
    # (/api/v3/delphi/narrative/{inputs,results}) are not served by this server
    # version: that row records the refusal of an unserved route, not an empty
    # store. A server that answers 404 makes the CLI report
    # capability_unavailable (exit 8).
    for path in ['collective export','delphi statement export']:
        add(path,[C,'--report',R,'--topic','generated#0#1','--output',path.replace(' ','-')],exit=6,scope='missing-store')
    add('delphi narrative export',[C,'--report',R,'--output','narrative'],exit=6,scope='unserved')
    add('vote',[C,'--statement','0','--agree'],actor='participant')
    add('comment',[C,'Generated participant statement'],actor='participant')
    # The fixture stores no topics, so this proves the participant's own empty read.
    add('topic prioritize',[C,'--show'],actor='participant')
    add('participant preferences',['--conversation',C,'--translations','true'])
    add('moderate accept',['--conversation',C,'--tid','0'])
    add('moderate reject',['--conversation',C,'--tid','1'])
    add('context create',['--name','Generated CLI context'])
    add('metadata question add',['--conversation',C,'--key','Generated question'])
    add('metadata answer add',['--conversation',C,'--question','1','--value','Generated choice','--yes'])
    add('metadata answer delete',['--conversation',C,'--question','1','--answer','1','--yes'])
    add('metadata question delete',['--conversation',C,'--question','1','--yes'])
    add('invite code create',['--conversation',C])
    add('invite wave create',['--conversation',C,'--per-user','0','--owner-invites','1'])
    add('conversation edit',[C,'--topic','Generated edited topic'])
    add('conversation close',[C]);add('conversation reopen',[C])
    add('seed csv validate',['seeds.csv'],scope='local')
    add('seed csv preview',['seeds.csv'],scope='local')
    add('seed add',['--conversation',C,'--text','Generated seeded statement'])
    add('seed import',['seeds.csv','--conversation',C])
    add('report create',['--conversation',C])
    add('conversation reserve')
    add('conversation create',['--topic','Generated simple creation'])
    add('conversation new',['--from','setup.json'])
    from admin_cases import admin_cases
    rows.extend(admin_cases())
    add('auth logout',scope='local')
    return rows
