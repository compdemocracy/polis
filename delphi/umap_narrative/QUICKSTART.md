# EVōC Pipeline Quickstart

This pipeline processes Polis conversations through a series of steps:

- `500_generate_embedding_umap_cluster.py` - Generates embeddings and performs clustering
- `600_generate_llm_topic_names.py` - Names topics using LLMs
- `700_datamapplot_for_layer.py` - Creates interactive visualizations

## Setup

1. Install dependencies: `pip install -r requirements.txt`
2. Start local DynamoDB: `docker run -p 8000:8000 amazon/dynamodb-local`
3. Create tables: `python create_dynamodb_tables.py`

## Processing Pipeline

### 1. Process Conversation with EVōC

```bash
# Activate virtual environment
source delphi-env/bin/activate

# Option 1: Run full pipeline in one step
python run_pipeline.py --zid CONVERSATION_ID --use-ollama

# Option 2: Run pipeline steps separately
python 500_generate_embedding_umap_cluster.py --conversation_id CONVERSATION_ID
python 600_generate_llm_topic_names.py --conversation_id CONVERSATION_ID
```

### 2. Generate Visualizations

```bash
# Generate visualizations for each layer
python 700_datamapplot_for_layer.py --conversation_id CONVERSATION_ID --layer 0
python 700_datamapplot_for_layer.py --conversation_id CONVERSATION_ID --layer 1
python 700_datamapplot_for_layer.py --conversation_id CONVERSATION_ID --layer 2
```

### 3. Extract Cluster Comments

```bash
# Get comments from a specific cluster
python 800_report_topic_clusters.py --conversation_id CONVERSATION_ID --layer 0 --cluster 1
```

### 4. Generate LLM Reports

```bash
# Generate a complete analysis report for a conversation
python 800_report_topic_clusters.py --conversation_id CONVERSATION_ID

# Generate a specific section of the report
python 800_report_topic_clusters.py --conversation_id CONVERSATION_ID --section groups

# Force regeneration of reports (ignore cache)
python 800_report_topic_clusters.py --conversation_id CONVERSATION_ID --no-cache

# Use a specific model
python 800_report_topic_clusters.py --conversation_id CONVERSATION_ID --model "llama3"
```

## Notes

- PostgreSQL must be running with proper credentials
- Ollama must be running for topic naming
- Visualizations are saved to `polis_data/CONVERSATION_ID/python_output/`
