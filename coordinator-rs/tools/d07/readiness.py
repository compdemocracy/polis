"""Fail-closed D07 drain predicate; no writer capability and no database I/O."""
FIELDS=('ObserverHealthy','PollHealthy','CurrentPointerHealthy')
ZERO=('PendingOperations','UnresolvedOperations','WithdrawnPendingOperations')


def drained(sample, operations):
    return (all(sample.get(k)==1 for k in FIELDS)
            and all(sample.get(k)==0 for k in ZERO)
            and bool(operations)
            and all(o.get('state')=='resolved' and o.get('exact') is True for o in operations)
            and len({o.get('operation_id') for o in operations})==len(operations)
            and all(isinstance(o.get('operation_id'),str) and o['operation_id'] for o in operations))


def bucket_counts_match(data,fold):
    """Independent raw-vote counts over the published cluster membership.

    Unclustered voters still belong in user-vote-counts. votes-base deliberately
    covers clustered voters only; never assume every public voter is clustered.
    This verifies aggregation, not the scientific choice of cluster membership.
    """
    base=data.get('base-clusters') or {}
    ids,members=base.get('id'),base.get('members')
    if not isinstance(ids,list) or not isinstance(members,list) or len(ids)!=len(members):return False
    if any(type(i) is not int for i in ids) or len(set(ids))!=len(ids):return False
    if any(not isinstance(group,list) or any(type(pid) is not int for pid in group) for group in members):return False
    clustered=[pid for group in members for pid in group]
    if len(clustered)!=len(set(clustered)) or not set(clustered)<=fold.participants:return False
    positions={pid:i for i,(_,group) in enumerate(sorted(zip(ids,members))) for pid in group}
    expected={str(tid):{key:[0]*len(ids) for key in ('A','D','S')} for tid in fold.comments}
    for (pid,tid),vote in fold.cells.items():
        if pid not in positions:continue
        i=positions[pid];entry=expected[str(tid)]
        entry['S'][i]+=1
        if vote==1:entry['A'][i]+=1
        elif vote==-1:entry['D'][i]+=1
    return data.get('votes-base')==expected
