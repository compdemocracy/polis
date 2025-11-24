"""
Dataset auto-discovery for regression testing.

Datasets are auto-discovered from real_data/ and real_data/.local/ based on
directory naming: <report_id>-<name>/

Required files for regression testing:
- *-votes.csv, *-comments.csv, golden_snapshot.json

Optional files:
- {report_id}_math_blob.json (for Clojure comparison - requires database access to download)
"""

import glob
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional

# Optional metadata for known datasets
DATASET_METADATA = {
    'biodiversity': 'NZ Biodiversity Strategy',
    'vw': 'VW Conversation',
}

# Pattern: <report_id>-<name> where report_id starts with 'r'
_DIR_PATTERN = re.compile(r'^(r[a-z0-9]+)-(.+)$')


@dataclass
class DatasetInfo:
    """Auto-discovered dataset information."""
    name: str
    report_id: str
    path: Path
    is_local: bool
    has_golden: bool
    has_math_blob: bool
    has_votes: bool
    has_comments: bool

    @property
    def is_valid(self) -> bool:
        """Has all files needed for regression testing (math_blob is optional)."""
        return all([self.has_golden, self.has_votes, self.has_comments])

    @property
    def has_clojure_reference(self) -> bool:
        """Has math_blob for comparison with Clojure implementation."""
        return self.has_math_blob

    @property
    def description(self) -> str:
        return DATASET_METADATA.get(self.name, f'Dataset: {self.name}')


def get_real_data_dir() -> Path:
    """Path to delphi/real_data/"""
    return (Path(__file__).parent.parent.parent / 'real_data').resolve()


def get_local_data_dir() -> Path:
    """Path to delphi/real_data/.local/"""
    return get_real_data_dir() / '.local'


def _check_files(path: Path, report_id: str) -> dict:
    """Check which required files exist."""
    return {
        'has_votes': any(path.glob(f"*-{report_id}-votes.csv")),
        'has_comments': any(path.glob(f"*-{report_id}-comments.csv")),
        'has_math_blob': (path / f"{report_id}_math_blob.json").exists(),
        'has_golden': (path / "golden_snapshot.json").exists(),
    }


def _discover_in_dir(search_dir: Path, is_local: bool) -> Dict[str, DatasetInfo]:
    """Discover datasets in a directory."""
    if not search_dir.exists():
        return {}

    datasets = {}
    for item in search_dir.iterdir():
        if not item.is_dir():
            continue
        match = _DIR_PATTERN.match(item.name)
        if match:
            report_id, name = match.groups()
            datasets[name] = DatasetInfo(
                name=name, report_id=report_id, path=item, is_local=is_local,
                **_check_files(item, report_id)
            )
    return datasets


def discover_datasets(include_local: bool = False) -> Dict[str, DatasetInfo]:
    """Auto-discover datasets from real_data/ and optionally .local/"""
    datasets = _discover_in_dir(get_real_data_dir(), is_local=False)
    if include_local:
        local_datasets = _discover_in_dir(get_local_data_dir(), is_local=True)
        # Warn about name collisions (local would shadow committed)
        collisions = set(datasets.keys()) & set(local_datasets.keys())
        if collisions:
            import warnings
            warnings.warn(
                f"Local datasets shadow committed datasets with same name: {', '.join(sorted(collisions))}. "
                f"Local versions will be used.",
                UserWarning
            )
        datasets.update(local_datasets)
    return datasets


def list_regression_datasets(include_local: bool = False) -> List[str]:
    """List dataset names valid for regression testing."""
    return [n for n, d in discover_datasets(include_local).items() if d.is_valid]


def list_available_datasets(include_local: bool = False) -> Dict[str, dict]:
    """List datasets in legacy dict format for backward compatibility."""
    return {
        name: {
            'report_id': d.report_id,
            'description': d.description,
            'is_local': d.is_local,
            'has_golden': d.has_golden,
            'has_math_blob': d.has_math_blob,
            'has_clojure_reference': d.has_clojure_reference,
        }
        for name, d in discover_datasets(include_local).items()
    }


def get_dataset_info(name: str) -> DatasetInfo:
    """Get dataset by name (searches both locations)."""
    datasets = discover_datasets(include_local=True)
    if name not in datasets:
        raise ValueError(f"Unknown dataset: {name}. Available: {', '.join(sorted(datasets))}")
    return datasets[name]


def get_dataset_report_id(name: str) -> str:
    """Get report_id for a dataset name."""
    return get_dataset_info(name).report_id


def get_dataset_files(name: str) -> Dict[str, str]:
    """Get file paths for a dataset."""
    info = get_dataset_info(name)
    rid = info.report_id

    def find_file(pattern: str) -> str:
        matches = list(info.path.glob(pattern))
        if not matches:
            raise FileNotFoundError(f"No file matching {pattern} in {info.path}")
        if len(matches) > 1:
            raise ValueError(f"Multiple files matching {pattern} in {info.path}: {matches}")
        return str(matches[0].resolve())

    return {
        'report_id': rid,
        'data_dir': str(info.path),
        'votes': find_file(f"*-{rid}-votes.csv"),
        'comments': find_file(f"*-{rid}-comments.csv"),
        'summary': find_file(f"*-{rid}-summary.csv"),
        'math_blob': str(info.path / f"{rid}_math_blob.json"),
    }


# Legacy aliases
def get_dataset_directory(report_id: str, dataset_name: Optional[str] = None) -> Path:
    """Find dataset directory by report_id."""
    for search_dir in [get_real_data_dir(), get_local_data_dir()]:
        if not search_dir.exists():
            continue
        if dataset_name:
            path = search_dir / f"{report_id}-{dataset_name}"
            if path.exists():
                return path
        path = search_dir / report_id
        if path.exists():
            return path
    raise FileNotFoundError(f"Dataset not found: {report_id}")


def find_dataset_file(report_id: str, suffix: str, dataset_name: Optional[str] = None) -> str:
    """Find a file by report_id and suffix."""
    report_dir = get_dataset_directory(report_id, dataset_name)
    pattern = f"{report_id}_math_blob.json" if suffix == 'math_blob.json' else f"*-{report_id}-{suffix}"
    matches = glob.glob(str(report_dir / pattern))
    if not matches:
        raise FileNotFoundError(f"No {suffix} in {report_dir}")
    return matches[0]
