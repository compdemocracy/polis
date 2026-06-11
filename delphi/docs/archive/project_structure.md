# Python Conversion Project Structure

This document outlines the proposed project structure for the Python conversion of the Pol.is math codebase.

## Directory Structure

```
polismath/
├── config/                   # Configuration files
├── components/               # System components
│   ├── database.py           # Database connection and operations
│   ├── config.py             # Configuration management
│   ├── logger.py             # Logging setup
│   └── server.py             # API server
├── math/                     # Core mathematical algorithms
│   ├── named_matrix.py       # NamedMatrix implementation
│   ├── pca.py                # PCA implementation
│   ├── clusters.py           # Clustering implementation
│   ├── repness.py            # Representativeness calculations
│   ├── stats.py              # Statistical functions
│   └── corr.py               # Correlation calculations
├── conversation/
│   ├── manager.py            # Conversation manager (conv_man equivalent)
│   ├── processor.py          # Core conversation processing
│   └── exports.py            # Export functionality
├── utils/
│   ├── matrix_utils.py       # Matrix manipulation utilities
│   └── helpers.py            # General utility functions
├── poller.py                 # Database polling implementation
├── runner.py                 # Entry point and execution control
└── system.py                 # System integration
```

## Key Modules



### Mathematical Algorithms

**`pca.py`**
- Implements the custom PCA algorithm
- Includes sparsity-aware projection
- Uses numpy/scipy for efficient matrix operations

**`clusters.py`**
- Custom K-means implementation
- Silhouette coefficient calculation
- Group formation algorithms

**`repness.py`**
- Representative comment identification
- Statistical tests for representativeness
- Group-based analysis

### System Components

**`manager.py`**
- Manages conversation state
- Coordinates math operations
- Handles incremental updates

**`poller.py`**
- Polls database for new votes and moderation actions
- Schedules computation

**`database.py`**
- Database connection management
- Query functionality
- Result persistence

## Dependencies

- **numpy**: Core numerical operations
- **scipy**: Scientific computing and statistics
- **pandas**: Data manipulation and DataFrame implementation
- **scikit-learn**: Machine learning algorithms (potentially)
- **asyncio**: Asynchronous I/O
- **psycopg2**: PostgreSQL connection
- **pytest**: Testing framework

## Development Phases

1. **Core Data Structures**: Implement NamedMatrix
2. **Basic Math Operations**: Implement core statistical functions
3. **Advanced Algorithms**: Implement PCA, clustering, and representativeness
4. **System Integration**: Implement conversation manager and state handling
5. **API and Database**: Implement database connectivity and API endpoints
6. **Testing and Validation**: Comprehensive testing against Clojure implementation
7. **Optimization**: Performance tuning and optimization