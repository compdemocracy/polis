"""
Named Matrix implementation for Pol.is math module.

This module provides a data structure for matrices with named rows and columns,
specifically optimized for the Pol.is voting data representation.
"""

import numpy as np
import pandas as pd
import time
import logging
from typing import List, Dict, Union, Optional, Tuple, Any, Set, Callable

# Set up logging
logger = logging.getLogger(__name__)

# Progress reporting constants
PROGRESS_INTERVAL = 5000   # Report progress every N items
REPORT_THRESHOLD = 8000    # Only report detailed progress for operations larger than this


class IndexHash:
    """
    Maintains an ordered index of names with fast lookup.
    Similar to the Clojure IndexHash implementation.
    """
    
    def __init__(self, names: Optional[List[Any]] = None):
        """
        Initialize an IndexHash with optional initial names.
        
        Args:
            names: Optional list of initial names
        """
        self._names = [] if names is None else list(names)
        self._index_hash = {name: idx for idx, name in enumerate(self._names)}
        
    def get_names(self) -> List[Any]:
        """Return the ordered list of names."""
        return self._names.copy()
    
    def next_index(self) -> int:
        """Return the next index value that would be assigned."""
        return len(self._names)
    
    def index(self, name: Any) -> Optional[int]:
        """
        Get the index for a given name, or None if not found.
        
        Args:
            name: The name to look up
            
        Returns:
            The index if found, None otherwise
        """
        return self._index_hash.get(name)
    
    def append(self, name: Any) -> 'IndexHash':
        """
        Add a new name to the index.
        
        Args:
            name: The name to add
            
        Returns:
            A new IndexHash with the added name
        """
        if name in self._index_hash:
            return self
            
        new_index = IndexHash(self._names)
        new_index._names.append(name)
        new_index._index_hash[name] = len(new_index._names) - 1
        return new_index
    
    def append_many(self, names: List[Any]) -> 'IndexHash':
        """
        Add multiple names to the index.
        
        Args:
            names: List of names to add
            
        Returns:
            A new IndexHash with the added names
        """
        result = self
        for name in names:
            result = result.append(name)
        return result
    
    def subset(self, names: List[Any]) -> 'IndexHash':
        """
        Create a subset of the index with only the specified names.
        
        Args:
            names: List of names to include in the subset
            
        Returns:
            A new IndexHash containing only the specified names
        """
        # Filter names that exist in the current index
        valid_names = [name for name in names if name in self._index_hash]
        return IndexHash(valid_names)
    
    def __len__(self) -> int:
        """Return the number of names in the index."""
        return len(self._names)
    
    def __contains__(self, name: Any) -> bool:
        """Check if a name is in the index."""
        return name in self._index_hash


class NamedMatrix:
    """
    A matrix with named rows and columns.
    
    This is the Python equivalent of the Clojure NamedMatrix implementation,
    using pandas DataFrame as the underlying storage.
    """
    
    def __init__(self, 
                 matrix: Optional[Union[np.ndarray, pd.DataFrame]] = None,
                 rownames: Optional[List[Any]] = None,
                 colnames: Optional[List[Any]] = None,
                 enforce_numeric: bool = True):
        """
        Initialize a NamedMatrix with optional initial data.
        
        Args:
            matrix: Initial matrix data (numpy array or pandas DataFrame)
            rownames: List of row names
            colnames: List of column names
            enforce_numeric: Whether to enforce numeric values (convert to float)
        """
        # Initialize row and column indices
        self._row_index = IndexHash(rownames)
        self._col_index = IndexHash(colnames)
        
        # Initialize the matrix data
        if matrix is None:
            # Create an empty DataFrame
            self._matrix = pd.DataFrame(
                index=self._row_index.get_names(),
                columns=self._col_index.get_names()
            )
        elif isinstance(matrix, pd.DataFrame):
            # If DataFrame is provided, use it directly
            self._matrix = matrix.copy()
            # Update indices if provided
            if rownames is not None:
                self._matrix.index = rownames
            else:
                # Use DataFrame's index as rownames
                rownames = list(matrix.index)
                self._row_index = IndexHash(rownames)
                
            if colnames is not None:
                self._matrix.columns = colnames
            else:
                # Use DataFrame's columns as colnames
                colnames = list(matrix.columns)
                self._col_index = IndexHash(colnames)
        else:
            # Convert numpy array to DataFrame
            rows = rownames if rownames is not None else range(matrix.shape[0])
            cols = colnames if colnames is not None else range(matrix.shape[1])
            self._matrix = pd.DataFrame(
                matrix,
                index=rows,
                columns=cols
            )
        
        # Ensure numeric data if requested
        if enforce_numeric:
            self._convert_to_numeric()

    @staticmethod
    def _normalize_vote_value(v: Any, convert_na_to_0: bool = True) -> float:
        """ Normalize a vote value to -1.0, 0.0, or 1.0
        
        Args:
            v: The value to normalize
            convert_na_to_0: Whether to keep NaN values as NaN (and NA converts to NaN), or convert them to 0.0. Default True.
        """
        # Process value into normalized form
        if v is None:
            return np.nan
        
        if pd.isna(v) and not convert_na_to_0:
            return np.nan 

        try:
            numeric_value = float(v)
            if numeric_value > 0:
                return 1.0
            elif numeric_value < 0:
                return -1.0
            else:
                # Note: np.nan is captured here if it has not been captured in (not convert_na_to_0)
                return 0.0
        except (ValueError, TypeError):
            return np.nan
    
    def _convert_to_numeric(self) -> None:
        """
        Convert all data in the matrix to numeric (float) values.
        Non-convertible values are replaced with NaN.
        """
        # Check if the matrix is empty
        if self._matrix.empty:
            return
            
        # Check if the matrix has any columns
        if len(self._matrix.columns) == 0:
            return
            
        # Check if the matrix has any rows
        if len(self._matrix.index) == 0:
            return
        
        # Check if the matrix is already numeric
        try:
            if pd.api.types.is_numeric_dtype(self._matrix.dtypes.iloc[0]) and not self._matrix.dtypes.iloc[0] == np.dtype('O'):
                return
        except (IndexError, AttributeError):
            # Handle empty DataFrames or other issues
            return
            
        # If matrix has object or non-numeric type, convert manually
        numeric_matrix = np.zeros(self._matrix.shape, dtype=float)
        
        # TODO: vectorize this operation for speed
        for i in range(self._matrix.shape[0]):
            for j in range(self._matrix.shape[1]):
                numeric_matrix[i, j] = self._normalize_vote_value(self._matrix.iloc[i, j], convert_na_to_0=True)
        
        # Create a new DataFrame with the numeric values
        self._matrix = pd.DataFrame(
            numeric_matrix,
            index=self._matrix.index,
            columns=self._matrix.columns
        )
    
    @property
    def matrix(self) -> pd.DataFrame:
        """Get the underlying DataFrame."""
        return self._matrix
    
    @property
    def values(self) -> np.ndarray:
        """Get the matrix as a numpy array."""
        return self._matrix.values
    
    def rownames(self) -> List[Any]:
        """Get the list of row names."""
        return self._row_index.get_names()
    
    def colnames(self) -> List[Any]:
        """Get the list of column names."""
        return self._col_index.get_names()
    
    def get_row_index(self) -> IndexHash:
        """Get the row index object."""
        return self._row_index
    
    def get_col_index(self) -> IndexHash:
        """Get the column index object."""
        return self._col_index
    
    def copy(self) -> 'NamedMatrix':
        """
        Create a deep copy of the NamedMatrix.
        
        Returns:
            A new NamedMatrix with the same data
        """
        result = NamedMatrix.__new__(NamedMatrix)
        result._matrix = self._matrix.copy()
        result._row_index = self._row_index
        result._col_index = self._col_index
        return result
    
    def update(self, 
               row: Any, 
               col: Any, 
               value: Any,
               normalize_value:bool = False) -> 'NamedMatrix':
        """
        Update a single value in the matrix, adding new rows/columns as needed.
        
        Args:
            row: Row name
            col: Column name
            value: New value
            normalize_value: Whether to normalize the value (convert positive values to 1.0, negative values to -1.0, and zero to 0.0). Default False.

        Note: Unlike batch_update, this method does *NOT* normalize values by default.

        Using the legacy behaviour here:
            update with strings:
                normalize_value = True ->  NaN
                normalize_value = False (default) ->  NaN

            update with NaN:
                normalize_values = True ->  0.0
                normalize_values = False (default) ->  NaN

            
        Returns:
            A new NamedMatrix with the updated value
        """
        # Convert value to numeric if needed
        # Like in batch update mode, we normalize to -1, 0, 1 for vote values
        if pd.isna(value):
            if normalize_value:
                value = 0.0

        if type(value) == str:
            value = np.nan

        if value is not None:
            try:
                # Try to convert to float
                numeric_value = float(value)
                value = numeric_value
                if normalize_value:
                    value = self._normalize_vote_value(value, convert_na_to_0=False)
            except (ValueError, TypeError):
                # If conversion fails, use NaN
                value = np.nan
        
        # Make a copy of the current matrix
        new_matrix = self._matrix.copy()
        
        # Handle the case of empty matrix
        if len(new_matrix.columns) == 0 and col is not None:
            # Initialize with a single column
            new_matrix[col] = np.nan
            new_col_index = self._col_index.append(col)
        else:
            new_col_index = self._col_index
            
            # Add column if it doesn't exist
            if col not in new_matrix.columns:
                new_matrix[col] = np.nan
                new_col_index = new_col_index.append(col)
        
        # Add row if it doesn't exist
        if row not in new_matrix.index:
            new_matrix.loc[row] = np.nan
            new_row_index = self._row_index.append(row)
        else:
            new_row_index = self._row_index
        
        # Update the value
        new_matrix.loc[row, col] = value
        
        # Create a new NamedMatrix with updated data
        result = NamedMatrix.__new__(NamedMatrix)
        result._matrix = new_matrix
        result._row_index = new_row_index
        result._col_index = new_col_index
        return result
    
    def batch_update(self, 
                    updates: List[Tuple[Any, Any, Any]],
                    normalize_values: bool = True) -> 'NamedMatrix':
        """
        Apply multiple updates to the matrix in a single efficient operation.
        
        Args:
            updates: List of (row, col, val) tuples
            normalize_values: Whether to normalize the values (convert positive values to 1.0, negative values to -1.0, and zero/NaN to 0.0). Default True.

        Note: unlike the single update method, this method *DOES* normalize values by default.
        
        Using legacy behaviour:
         
            batch_update  with strings:
                normalize_values = True (default) -> NaN
                normalize_values = False -> NaN

            batch_update with NaN:
                normalize_values = True (default) -> return 0.0 (as per legacy behavior)
                normalize_values = False -> NaN
            
        Returns:
            Updated NamedMatrix with all changes applied at once
        """
        if not updates:
            return self.copy()
        
        start_time = time.time()
        total_updates = len(updates)
        should_report = total_updates > REPORT_THRESHOLD
        
        if should_report:
            logger.info(f"Starting batch update of {total_updates} items")
            logger.info(f"[{time.time() - start_time:.2f}s] Matrix current size: {self._matrix.shape}")
        
        # Get existing row and column indices
        existing_rows = set(self._matrix.index)
        existing_cols = set(self._matrix.columns)
        
        if should_report:
            logger.info(f"[{time.time() - start_time:.2f}s] Found {len(existing_rows)} existing rows and {len(existing_cols)} existing columns")

        # Vectorized batch processing of updates

        # Step 1: Convert the list to a DataFrame with columns "row", "col", "value"
        if should_report:
            logger.info(f"[{time.time() - start_time:.2f}s] Converting updates to DataFrame...")

        updates_df = pd.DataFrame(updates, columns=['row', 'col', 'value'])

        # Step 2: Keep only the last update for each (row, col) pair
        original_count = len(updates_df)
        updates_df = updates_df.drop_duplicates(subset=['row', 'col'], keep='last')
        unique_count = len(updates_df)
        duplicates_removed = original_count - unique_count

        # Spot all strings in updates_df by 0.0
        are_strings = updates_df['value'].apply(lambda v: isinstance(v, str))
        updates_df.loc[are_strings,'value'] = np.nan

        if should_report:
            logger.info(f"[{time.time() - start_time:.2f}s] Removed {duplicates_removed} duplicate updates "
                       f"({duplicates_removed/original_count*100:.1f}%), kept {unique_count} unique updates")

        # Step 3: Normalize values if requested using vectorized operations
        if normalize_values:
            if should_report:
                logger.info(f"[{time.time() - start_time:.2f}s] Normalizing values...")


            # Vectorized normalization: convert to numeric, then apply sign function
            values = pd.to_numeric(updates_df['value'], errors='coerce')

            # Apply normalization: positive -> 1.0, negative -> -1.0, zero -> 0.0, nan -> nan
            normalized = np.sign(values)
            normalized.fillna(0.0, inplace=True)  # Convert NaN to 0.0 as per legacy behavior

            updates_df['value'] = normalized


        # Revert all strings to NaN
        updates_df.loc[are_strings,'value'] = np.nan

        # Step 4: Get new rows and columns by set difference
        if should_report:
            logger.info(f"[{time.time() - start_time:.2f}s] Identifying new rows and columns...")

        all_update_rows = set(updates_df['row'].unique())
        all_update_cols = set(updates_df['col'].unique())

        new_rows = all_update_rows - existing_rows
        new_cols = all_update_cols - existing_cols

        if should_report:
            logger.info(f"[{time.time() - start_time:.2f}s] Found {len(new_rows)} new rows and {len(new_cols)} new columns")

        # Step 5: Create complete row and column lists and reindex
        all_rows = sorted(list(existing_rows) + list(new_rows))
        all_cols = sorted(list(existing_cols) + list(new_cols))

        if should_report:
            logger.info(f"[{time.time() - start_time:.2f}s] Creating new matrix with {len(all_rows)} rows and {len(all_cols)} columns")
            logger.info(f"[{time.time() - start_time:.2f}s] Reindexing existing matrix...")

        matrix_copy = self._matrix.reindex(index=all_rows, columns=all_cols, fill_value=np.nan, copy=True)

        # Step 6: Apply all updates at once
        if should_report:
            logger.info(f"[{time.time() - start_time:.2f}s] Applying {unique_count} updates...")

        update_start = time.time()

        # Use .at for efficient individual cell updates
        for idx, row_data in updates_df.iterrows():
            matrix_copy.at[row_data['row'], row_data['col']] = row_data['value']

        if should_report:
            logger.info(f"[{time.time() - start_time:.2f}s] Updates applied in {time.time() - update_start:.2f}s")

        # Create a new NamedMatrix with the updated data
        result = NamedMatrix.__new__(NamedMatrix)
        result._matrix = matrix_copy
        result._row_index = IndexHash(all_rows)
        result._col_index = IndexHash(all_cols)
        
        if should_report:
            total_time = time.time() - start_time
            logger.info(f"[{total_time:.2f}s] Batch update completed in {total_time:.2f}s - Final matrix size: {result._matrix.shape}")
        
        return result
        
    def rowname_subset(self, rownames: List[Any]) -> 'NamedMatrix':
        """
        Create a subset of the matrix with only the specified rows.
        
        Args:
            rownames: List of row names to include
            
        Returns:
            A new NamedMatrix with only the specified rows
        """
        # Filter for rows that exist in the matrix
        valid_rows = [row for row in rownames if row in self._matrix.index]
        
        if not valid_rows:
            # Return an empty matrix with the same columns
            return NamedMatrix(
                pd.DataFrame(columns=self.colnames()),
                rownames=[],
                colnames=self.colnames()
            )
        
        # Create a subset of the matrix
        subset_df = self._matrix.loc[valid_rows]
        
        # Create a new NamedMatrix with the subset
        result = NamedMatrix.__new__(NamedMatrix)
        result._matrix = subset_df
        result._row_index = self._row_index.subset(valid_rows)
        result._col_index = self._col_index
        return result
    
    def colname_subset(self, colnames: List[Any]) -> 'NamedMatrix':
        """
        Create a subset of the matrix with only the specified columns.
        
        Args:
            colnames: List of column names to include
            
        Returns:
            A new NamedMatrix with only the specified columns
        """
        # Filter for columns that exist in the matrix
        valid_cols = [col for col in colnames if col in self._matrix.columns]
        
        if not valid_cols:
            # Return an empty matrix with the same rows
            return NamedMatrix(
                pd.DataFrame(index=self.rownames()),
                rownames=self.rownames(),
                colnames=[]
            )
        
        # Create a subset of the matrix
        subset_df = self._matrix[valid_cols]
        
        # Create a new NamedMatrix with the subset
        result = NamedMatrix.__new__(NamedMatrix)
        result._matrix = subset_df
        result._row_index = self._row_index
        result._col_index = self._col_index.subset(valid_cols)
        return result
    
    def get_row_by_name(self, row_name: Any) -> np.ndarray:
        """
        Get a row of the matrix by name.
        
        Args:
            row_name: The name of the row
            
        Returns:
            The row as a numpy array
        """
        if row_name not in self._matrix.index:
            raise KeyError(f"Row name '{row_name}' not found")
        return self._matrix.loc[row_name].values
    
    def get_col_by_name(self, col_name: Any) -> np.ndarray:
        """
        Get a column of the matrix by name.
        
        Args:
            col_name: The name of the column
            
        Returns:
            The column as a numpy array
        """
        if col_name not in self._matrix.columns:
            raise KeyError(f"Column name '{col_name}' not found")
        return self._matrix[col_name].values
    
    def zero_out_columns(self, colnames: List[Any]) -> 'NamedMatrix':
        """
        Set all values in the specified columns to zero.
        
        Args:
            colnames: List of column names to zero out
            
        Returns:
            A new NamedMatrix with zeroed columns
        """
        # Make a copy
        new_matrix = self._matrix.copy()
        
        # Zero out columns that exist
        valid_cols = [col for col in colnames if col in new_matrix.columns]
        for col in valid_cols:
            new_matrix[col] = 0
            
        # Create a new NamedMatrix with updated data
        result = NamedMatrix.__new__(NamedMatrix)
        result._matrix = new_matrix
        result._row_index = self._row_index
        result._col_index = self._col_index
        return result
    
    def inv_rowname_subset(self, rownames: List[Any]) -> 'NamedMatrix':
        """
        Create a subset excluding the specified rows.
        
        Args:
            rownames: List of row names to exclude
            
        Returns:
            A new NamedMatrix without the specified rows
        """
        exclude_set = set(rownames)
        include_rows = [row for row in self.rownames() if row not in exclude_set]
        return self.rowname_subset(include_rows)
    
    def __repr__(self) -> str:
        """
        String representation of the NamedMatrix.
        """
        return f"NamedMatrix(rows={len(self.rownames())}, cols={len(self.colnames())})"
    
    def __str__(self) -> str:
        """
        Human-readable string representation.
        """
        return (f"NamedMatrix with {len(self.rownames())} rows and "
                f"{len(self.colnames())} columns\n{self._matrix}")

    def memory_usage_mb(self) -> float:
        """
        Estimate the memory usage of the matrix in megabytes.
        
        Returns:
            Estimated memory usage in MB
        """
        return self._matrix.memory_usage(deep=True).sum() / (1024 * 1024)


# Utility functions

def create_named_matrix(matrix_data: Optional[Union[np.ndarray, List[List[Any]]]] = None,
                        rownames: Optional[List[Any]] = None,
                        colnames: Optional[List[Any]] = None) -> NamedMatrix:
    """
    Create a NamedMatrix from data.
    
    Args:
        matrix_data: Initial matrix data (numpy array or nested lists)
        rownames: List of row names
        colnames: List of column names
        
    Returns:
        A new NamedMatrix
    """
    if matrix_data is not None and not isinstance(matrix_data, np.ndarray):
        matrix_data = np.array(matrix_data)
    return NamedMatrix(matrix_data, rownames, colnames)