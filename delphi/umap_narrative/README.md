# EVōC for pol.is Visualization

This repository contains tools for visualizing pol.is conversations using EVōC (Embedding Vector Oriented Clustering) and interactive visualization techniques.

## Overview

EVōC provides parameter-free clustering that's well-suited for clustering participants based on their voting patterns in pol.is conversations. This approach offers several advantages over traditional PCA+KMeans clustering:

1. **Parameter-free operation** - No need to specify number of clusters
2. **Multi-scale clustering** - Automatically discovers hierarchical structure
3. **No expert supervision required** - Suitable for deployment without data scientist oversight

## Key Components

The repository includes several key scripts:

- `visualize_participants.py` - Clusters and visualizes participants based on voting patterns
- `visualize_participants_with_layers.py` - Creates multi-layer hierarchical visualizations of participants
- `visualize_comments_with_layers.py` - Clusters and visualizes comments with multi-layer support
- `enhance_participant_viz.py` - Adds topic labeling and cluster characterization
- `integrate_topic_labeling.py` - Combines multi-layer visualization with topic labeling

## Features

- **Parameter-free clustering** using EVōC
- **Multi-layer visualization** to explore different levels of clustering granularity
- **Topic labeling** to provide meaningful descriptions of clusters
- **Interactive visualization** with DataMapPlot
- **Joint visualization** to show both participants and comments together

## Usage

### Installation

1. Clone the repository
2. Install dependencies:

```bash
pip install -e ".[dev,notebook]"  # From delphi root (eg $HOME/polis/delphi)
```

### Running the visualization

To generate multi-layer visualizations with topic labeling:

```bash
python umap_narrative/integrate_topic_labeling.py --conversation [conversation_name] --data-type [participant/comment/both]
```

Where:

- `conversation_name` is one of: biodiversity, sji, bg2050, vw
- `data-type` specifies which data to process: participant, comment, or both

## Documentation

Detailed documentation is available in the following files:

- `EVOC_PARTICIPANT_NOTES.md` - Notes on EVōC's parameter-free advantages
- `PARTICIPANT_VISUALIZATION_README.md` - Details on participant visualization
- `MULTILAYER_VISUALIZATION_README.md` - Details on multi-layer visualization
- `INTEGRATED_TOPIC_LABELING_README.md` - Details on the integrated topic labeling approach
- `JOURNAL.md` - Development journal showing progress and decisions

## Dependencies

- [EVōC](https://github.com/TuringLab/evoc) - For parameter-free clustering
- [DataMapPlot](https://github.com/TuringLab/datamapplot) - For interactive visualization
- [UMAP](https://github.com/lmcinnes/umap) - For dimensionality reduction
- [Sentence Transformers](https://github.com/UKPLab/sentence-transformers) - For text embeddings

## License

MIT
