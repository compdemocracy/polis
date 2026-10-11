"""Bounded numerical Delphi graph adapters; all durable writes are fenced by SQL.

Narratives and topic names use explicitly labelled fixed stand-ins for plumbing proof.
Demo snapshots with 5–2000 texts are admitted by this initial adapter.
Raw votes never enter these adapters; narrative inputs contain signed aggregate
counts from the math snapshot. Comment ids are supplied explicitly.
"""
from decimal import Decimal
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
# Load the frozen stdlib-only codec without importing unrelated math poller modules.
import importlib.util
_spec = importlib.util.spec_from_file_location('delphi_graph_codec', ROOT / 'polismath/delphi_storage/codec.py')
_codec = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_codec)
encode_family, decode_family = _codec.encode_family, _codec.decode_family
item_from_python, to_python = _codec.item_from_python, _codec.to_python

MODELS = {'graph_embed': 'sentence-transformers/all-MiniLM-L6-v2',
          'graph_cluster': 'delphi-umap-evoc/1', 'graph_topics': 'delphi-tfidf-keywords/1',
          'graph_narrative': 'local-narrative-fixture/1'}


def code_digest():
    paths = [Path(__file__), ROOT / 'umap_narrative/numerical_stages.py',
             ROOT / 'umap_narrative/polismath_commentgraph/utils/converter.py',
             ROOT / 'umap_narrative/polismath_commentgraph/schemas/dynamo_models.py',
             ROOT / 'umap_narrative/narrative_data.py']
    paths.extend(sorted((ROOT / 'umap_narrative/report_experimental').rglob('*.xml')))
    digest = hashlib.sha256()
    for path in paths:
        digest.update(path.read_bytes())
    return digest.hexdigest()


def model_digest(path):
    """Pin actual local model bytes, independent of machine-specific cache paths."""
    path = Path(path)
    files = sorted(p for p in path.rglob('*') if p.is_file() and '.cache' not in p.parts)
    if not files or not any(p.name.endswith(('.safetensors', '.bin')) for p in files):
        raise ValueError('local embedding model weights required')
    h = hashlib.sha256()
    for p in files:
        h.update(p.relative_to(path).as_posix().encode() + b'\0')
        with p.open('rb') as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b''):
                h.update(chunk)
    return h.hexdigest()


def _decimal(value):
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, dict):
        return {k: _decimal(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_decimal(v) for v in value]
    return value


def family_files(families):
    return {name: encode_family(name, [item_from_python(_decimal(row)) for row in rows]).decode()
            for name, rows in families.items()}


def read_family(output, name):
    family, rows = decode_family(output['family_files'][name].encode())
    if family != name:
        raise ValueError('family identity mismatch')
    return [{k: to_python(v) for k, v in row.items()} for row in rows]


def upstream(frame, role):
    artifact = frame['input']['artifacts'][role]
    if hashlib.sha256(artifact['payload'].encode()).hexdigest() != artifact['sha256']:
        raise ValueError('upstream artifact digest mismatch')
    value = json.loads(artifact['payload'])
    hydrated = frame.get('result_families', {}).get(role)
    if hydrated is not None:
        value['family_files'] = hydrated
    return value



def narrative_sections(topics, context, ids, texts):
    """Use existing topic/global filters, selection limits, XML and report prompts."""
    import asyncio
    import xmltodict
    import xml.etree.ElementTree as ET
    from umap_narrative.narrative_data import NarrativeSelection
    if context.get('schema') != 'delphi-narrative-context/1':
        raise ValueError('invalid narrative context')
    text_by_id = dict(zip(ids,texts))
    records = [{**row,'comment':text_by_id[row['comment_id']]} for row in context['comments'] if row['comment_id'] in text_by_id]
    for topic in topics:
        members=set(topic['comment_ids'])
        for row in records:
            if row['comment_id'] in members:
                row[f"layer{topic['layer_id']}_cluster_id"]=topic['cluster_id']
    selector = NarrativeSelection()
    entries=[(topic,dict(topic_cluster_id=topic['cluster_id'],topic_layer_id=topic['layer_id'],
                         topic_citations=topic['comment_ids']), 'topics') for topic in topics]
    for name,filter_type,threshold in [('groups','comment_extremity',1.0),
            ('group_informed_consensus','group_aware_consensus','dynamic'),('uncertainty','uncertainty_ratio',0.2)]:
        entries.append((dict(topic_label=name,size=len(records),_global=name),
                        dict(filter_type=filter_type,filter_threshold=threshold),name))
    directory=ROOT/'umap_narrative/report_experimental'
    system=(directory/'system.xml').read_text()
    result=[]
    for topic,args,template in entries:
        selected=[row for row in records if selector.filter_topics(row,**args)]
        if not selected:
            continue
        structured=asyncio.run(selector.get_comments_as_xml(dict(processed_comments=records),selector.filter_topics,args))
        document=xmltodict.parse((directory/'subtaskPrompts'/f'{template}.xml').read_text())
        document['polisAnalysisPrompt']['data']={'content':{'structured_comments':structured}}
        topic=dict(topic,_prompt=xmltodict.unparse(document,pretty=True),_system=system,
                   _allowed_ids=[int(row.attrib['id']) for row in ET.fromstring(structured).findall('comment')])
        result.append(topic)
    return result

def execute(frame):
    d = frame['input']['declared']
    stage = frame['stage']
    if MODELS.get(stage) != d['model']:
        raise ValueError('stage model mismatch')
    texts = d['snapshot']['data']['texts']
    config = d['config']
    ids = config['comment_ids']
    if not 5 <= len(texts) <= 2000 or any(not isinstance(t, str) or not t.strip() or len(t) > 4096 for t in texts):
        raise ValueError('expected 5–2000 nonempty bounded texts')
    if len(ids) != len(texts) or len(set(ids)) != len(ids) or any(type(i) is not int or i < 0 for i in ids):
        raise ValueError('unique nonnegative comment ids required')
    zid = str(frame['zid'])
    families = {}
    output = {'model': d['model'], 'statement_count': len(texts)}
    if stage == 'graph_embed':
        import numpy as np
        from sentence_transformers import SentenceTransformer
        model_path = os.environ['DELPHI_EMBED_MODEL_PATH']
        if model_digest(model_path) != config['model_sha256']:
            raise ValueError('embedding model bytes differ from admission')
        model = SentenceTransformer(model_path, device='cpu', local_files_only=True)
        vectors = model.encode(texts, convert_to_numpy=True, batch_size=32, show_progress_bar=False)
        if vectors.shape != (len(texts), 384) or not np.isfinite(vectors).all() or (np.linalg.norm(vectors, axis=1) == 0).any():
            raise ValueError('invalid MiniLM embedding output')
        families['Delphi_CommentEmbeddings'] = [dict(conversation_id=zid, comment_id=i,
            embedding=dict(vector=v.tolist(), dimensions=384, model=d['model'])) for i,v in zip(ids,vectors)]
    elif stage == 'graph_cluster':
        import numpy as np
        source = read_family(upstream(frame, 'embeddings'), 'Delphi_CommentEmbeddings')
        by_id = {int(row['comment_id']): row for row in source}
        vectors = np.asarray([by_id[i]['embedding']['vector'] for i in ids], dtype=np.float32)
        if str(ROOT / 'umap_narrative') not in sys.path:
            sys.path.insert(0, str(ROOT / 'umap_narrative'))
        from umap_narrative.numerical_stages import project_and_cluster, characterize_comment_clusters
        from polismath_commentgraph.utils.converter import DataConverter
        points, layers = project_and_cluster(vectors)
        if not layers or any(len(layer) != len(texts) for layer in layers) or not np.isfinite(points).all():
            raise ValueError('invalid Delphi clustering output')
        output.update(layers=[layer.tolist() for layer in layers], points=points.tolist())
        dump = lambda models: [model.model_dump(exclude_none=True) for model in models]
        families['Delphi_CommentHierarchicalClusterAssignments'] = dump(
            DataConverter.batch_convert_clusters(zid,layers,points,ids))
        families['Delphi_UMAPGraph'] = dump(DataConverter.batch_convert_umap_edges(zid,points,layers,comment_ids=ids))
        families['Delphi_UMAPConversationConfig'] = [DataConverter.create_conversation_meta(
            zid,vectors,layers).model_dump(exclude_none=True)]
    elif stage == 'graph_topics':
        import numpy as np
        if str(ROOT / 'umap_narrative') not in sys.path:
            sys.path.insert(0, str(ROOT / 'umap_narrative'))
        from umap_narrative.numerical_stages import project_and_cluster, characterize_comment_clusters
        from polismath_commentgraph.utils.converter import DataConverter
        clusters = upstream(frame, 'clusters')
        layers, points = [np.asarray(layer) for layer in clusters['layers']], np.asarray(clusters['points'])
        characteristics, names, features = {}, {}, []
        for layer_id, labels in enumerate(layers):
            chars = {str(key):value for key,value in characterize_comment_clusters(labels,texts).items()}
            characteristics[f'layer{layer_id}'] = chars
            names[f'layer{layer_id}'] = {key:'Keywords: '+', '.join(value.get('top_words',[])[:3])
                                        for key,value in chars.items()}
            features.extend(model.model_dump(exclude_none=True) for model in
                DataConverter.batch_convert_cluster_characteristics(zid,chars,layer_id))
        topics = [model.model_dump(exclude_none=True) for model in
                  DataConverter.batch_convert_topics(zid,layers,points,texts,names,characteristics)]
        for topic in topics:
            indexes = [i for i,label in enumerate(layers[topic['layer_id']]) if label == topic['cluster_id']]
            topic['sample_statements'] = [dict(id=ids[i],text=texts[i]) for i in indexes[:3]]
            topic['comment_ids'] = [ids[i] for i in indexes]
        families['Delphi_CommentClustersStructureKeywords'] = topics
        families['Delphi_CommentClustersFeatures'] = features
        output['topics'] = topics
    else:
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
    output['family_files'] = family_files(families)
    return output
