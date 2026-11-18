"""Reference adapters installed only in test builds."""
import json
from pathlib import Path

def definitions():
    return json.loads(Path(__file__).with_name('job-test-models.json').read_text())

def reference(frame):
    stage = frame['stage']
    inp = frame['input']
    declared = inp['declared']
    if stage == 'graph_embed':
        if declared['model'] != 'local-token-count/1':
            raise ValueError('unsupported embedding model')
        texts = declared['snapshot']['data']['texts']
        if not texts or len(texts) > 100 or any(not isinstance(t, str) or len(t)>4096 for t in texts):
            raise ValueError('bounded text snapshot required')
        vocabulary = sorted({word for text in texts for word in text.lower().split()})
        output = {'vocabulary': vocabulary, 'vectors': [[text.lower().split().count(w) for w in vocabulary] for text in texts]}
    elif stage == 'graph_cluster':
        if declared['model'] != 'local-nearest-centroid/1':
            raise ValueError('unsupported cluster model')
        vectors = json.loads(inp['artifacts']['embeddings']['payload'])['vectors']
        # Deterministic small reference Lloyd fit; independent of legacy resets.
        centers = [list(map(float, v)) for v in (vectors[0], vectors[-1])]
        labels = []
        for _ in range(20):
            labels = [min(range(len(centers)), key=lambda k: sum((a-b)**2 for a,b in zip(v, centers[k]))) for v in vectors]
            updated = [[sum(v[d] for v,l in zip(vectors, labels) if l==k)/labels.count(k) if k in labels else centers[k][d] for d in range(len(vectors[0]))] for k in range(len(centers))]
            if updated == centers:
                break
            centers = updated
        output = {'labels': labels, 'centers': centers}
    elif stage == 'graph_narrative':
        if declared['model'] != 'local-cluster-summary/1':
            raise ValueError('unsupported narrative model; paid adapters need admission and budget integration')
        clusters = json.loads(inp['artifacts']['clusters']['payload'])
        output = {'text': f"{len(clusters['labels'])} statements in {len(set(clusters['labels']))} clusters.", 'labels': clusters['labels']}
    else:
        raise ValueError('unsupported stage')
    return output

def narrative(frame, families):
    from datetime import datetime, timezone
    from delphi_graph_stages import upstream, narrative_sections
    d = frame['input']['declared']
    config = d['config']
    ids = config['comment_ids']
    texts = d['snapshot']['data']['texts']
    zid = str(frame['zid'])
    output = {}
    topics = upstream(frame, 'topics')['topics']
    if config.get('narrative_context'):
        topics = narrative_sections(topics, config['narrative_context'], ids, texts)
    report_id = config['report_id']
    job = frame['job_id']
    # A visible fixture exercises the complete queue/read/render contract only.
    names, reports = [], []
    completed_at = datetime.now(timezone.utc).isoformat()
    for topic in topics:
        label = topic.get('cluster_id',0)
        layer = topic.get('layer_id',0)
        title = 'Fixed proof topic'
        if not topic.get('_global'):
            names.append(dict(conversation_id=zid,topic_key=f'{job}#{layer}#{label}',layer_id=layer,cluster_id=label,
                topic_name=title,model_name=d['model'],job_id=job,created_at=completed_at))
        section = f"{job}_global_{topic['_global']}" if topic.get('_global') else f'{job}_{layer}_{label}'
        report = {'title':title,'paragraphs':[{'title':'Local provider fixture',
            'sentences':[{'clauses':[{'text':"Fixed narrative stand-in for queue, Postgres storage and report rendering proof. No LLM provider was called.",'citations':[]}]}]}],
            'provider_fixture':True}
        reports.append(dict(report_id=report_id,section=section,model=d['model'],
            rid_section_model=f'{report_id}#{section}#{d["model"]}',timestamp=completed_at,
            job_id=job,report_data=json.dumps(report,sort_keys=True),metadata={'provider_fixture':True}))
    completed_at = datetime.now(timezone.utc).isoformat()
    for row in names:
        row['created_at'] = completed_at
    for row in reports:
        row['timestamp'] = completed_at
    families['Delphi_CommentClustersLLMTopicNames'] = names
    families['Delphi_NarrativeReports'] = reports
    if config.get('narrative_context'):
        families['Delphi_CommentExtremity'] = [dict(conversation_id=zid,comment_id=str(row['comment_id']),
            extremity_value=row['comment_extremity'],calculation_method='pca_based',
            calculation_timestamp=completed_at,component_values={}) for row in config['narrative_context']['comments']]
    output.update(provider_fixture=True,topics=len(topics),
        text='Fixed stand-in; no LLM provider was called.')
    return output

def embedding_name():
    from graph_registry import named
    return named('MiniLm')
