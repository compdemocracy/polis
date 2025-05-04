# Pol.is Math Architecture Overview

## System Overview

The Pol.is Math component is the computational backbone of the Pol.is conversation system, implemented in Clojure. It processes participant votes, performs clustering and dimensionality reduction to organize participants into opinion groups, and identifies representative comments.

## Core Components

### Conversation Manager (`conv_man.clj`)
- Central orchestration component
- Maintains conversation state
- Processes incoming votes and moderation actions
- Schedules computation updates

### Math Algorithms
- **PCA** (`pca.clj`): Dimensionality reduction for visualization
- **Clustering** (`clusters.clj`): K-means implementation for grouping participants
- **Representativeness** (`repness.clj`): Identifies representative comments for each group
- **Correlation** (`corr.clj`): Measures agreement between participants

### Data Management
- **Named Matrix** (`named_matrix.clj`): Core data structure for votes
- **Stats** (`stats.clj`): Statistical operations

### System Infrastructure
- **Poller** (`poller.clj`): Polls database for new data
- **Runner** (`runner.clj`): Execution entry points
- **Components** (in `components/`): Configuration, logging, database connection

## Data Flow

1. **Data Ingestion**: Poller retrieves new votes and moderation actions
2. **Conversation Updates**: Conv-man processes new data and updates conversations
3. **Computation**: PCA and clustering algorithms run on updated data
4. **Analysis**: Representativeness calculations identify key comments
5. **Persistence**: Results stored back to database

## Technical Implementation Details

### Functional Programming Patterns
- Immutable data structures
- Pure functions for mathematical operations
- State managed through explicit state transitions

### Concurrency Model
- Asynchronous processing via Clojure's concurrency primitives
- Queued computation to manage resource utilization

### Database Integration
- PostgreSQL for persistent storage
- Transactional updates

## Python Conversion Considerations

In converting to Python, key considerations include:
1. Equivalent data structures for efficient matrix operations (NumPy/SciPy)
2. Concurrency model (asyncio, multiprocessing)
3. Functional programming patterns vs more Pythonic approach
4. Performance optimization for computational bottlenecks
5. Testing strategy for validating equivalent behavior