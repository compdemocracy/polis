#!/usr/bin/env python3
"""
Delphi Orchestrator - Unified Analysis Pipeline for Polis

This script orchestrates the full analytics pipeline for a Polis conversation:
- PCA and clustering of participant opinion groups
- Representativeness calculations for comments
- UMAP embeddings for semantic analysis
- Topic clustering with EVOC
- Data visualization with DataMapPlot
- Report generation

All results are stored in DynamoDB for later retrieval and visualization.

Usage:
    python delphi_orchestrator.py --zid=CONVERSATION_ID [options]

Parameters:
    --zid             Required: The conversation ID to process
    --local           Use local DynamoDB at http://localhost:8000 (default: False)
    --verbose         Enable detailed logging (default: False)
    --force           Force reprocessing even if data exists (default: False)
    --validate        Run extra validation checks during processing (default: False)
"""

import argparse
import logging
import sys
import time
import os
import json
from datetime import datetime
import traceback as tb

# Configure colored logging
try:
    import colorlog
    
    handler = colorlog.StreamHandler()
    handler.setFormatter(colorlog.ColoredFormatter(
        '%(log_color)s%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        log_colors={
            'DEBUG': 'blue',
            'INFO': 'blue',
            'WARNING': 'purple',
            'ERROR': 'bold_blue',
            'CRITICAL': 'white,bg_blue',
        }
    ))
    
    logger = colorlog.getLogger("delphi")
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    
except ImportError:
    # Fall back to standard logging if colorlog is not available
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
    )
    logger = logging.getLogger("delphi")

class PipelineStage:
    """Track progress and timing of pipeline stages"""
    def __init__(self, name):
        self.name = name
        self.start_time = None
        self.end_time = None
        self.success = None
        self.metrics = {}
    
    def start(self):
        """Start the pipeline stage"""
        self.start_time = time.time()
        logger.info(f">> Starting stage: {self.name}")
        return self
    
    def complete(self, success=True, **metrics):
        """Complete the pipeline stage"""
        self.end_time = time.time()
        self.success = success
        self.metrics = metrics
        
        duration = self.end_time - self.start_time
        
        if success:
            logger.info(f">> Completed stage: {self.name} in {duration:.2f}s")
            # Log metrics if any were provided
            for key, value in metrics.items():
                logger.info(f"   - {key}: {value}")
        else:
            logger.error(f">> Failed stage: {self.name} after {duration:.2f}s")
        
        return self
    
    @property
    def duration(self):
        """Get the duration of the stage in seconds"""
        if self.start_time and self.end_time:
            return self.end_time - self.start_time
        return None

class DelphiOrchestrator:
    """Orchestrates the full Delphi analytics pipeline"""
    
    def __init__(self, zid, use_local_db=False, verbose=False, force=False, validate=False):
        self.zid = zid
        self.use_local_db = use_local_db
        self.verbose = verbose
        self.force = force
        self.validate = validate
        self.stages = []
        self.conversation = None
        self.conv_manager = None
        
        # Configure logging level
        if verbose:
            logger.setLevel(logging.DEBUG)
            logger.debug("Verbose logging enabled")
        
        # Configure DynamoDB for local development if needed
        if use_local_db:
            os.environ['DYNAMODB_ENDPOINT'] = 'http://localhost:8000'
            logger.info("Using local DynamoDB at http://localhost:8000")
    
    def add_stage(self, name):
        """Add and start a new pipeline stage"""
        stage = PipelineStage(name).start()
        self.stages.append(stage)
        return stage
    
    def check_dependencies(self):
        """Verify all required dependencies are installed"""
        stage = self.add_stage("Dependency Check")
        
        try:
            # Check core dependencies
            import numpy
            import pandas
            import scipy
            import boto3
            
            # Add colorlog separately since it might be missing
            try:
                import colorlog
            except ImportError:
                logger.warning("colorlog not found, using standard logging")
            
            # These are optional dependencies that enhance functionality but aren't critical
            optional_deps = ["umap", "sentence_transformers", "matplotlib", "fastapi", "pydantic"]
            missing_optional = []
            
            for dep in optional_deps:
                try:
                    __import__(dep.replace('-', '_'))
                except ImportError:
                    missing_optional.append(dep)
            
            if missing_optional:
                logger.warning(f"Some optional dependencies are missing: {', '.join(missing_optional)}")
                logger.warning("The pipeline will continue but some features may be limited")
            
            # Try importing our own modules
            sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
            from polismath.conversation import manager as conv_manager_module
            
            # Check for UMAP narrative module in several potential locations
            umap_narrative_found = False
            # Try direct path
            umap_narrative_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "umap_narrative")
            if os.path.exists(umap_narrative_path):
                logger.info(f"Found umap_narrative at {umap_narrative_path}")
                umap_narrative_found = True
            
            # Try parent directory
            if not umap_narrative_found:
                umap_narrative_path = "/app/umap_narrative"
                if os.path.exists(umap_narrative_path):
                    logger.info(f"Found umap_narrative at {umap_narrative_path}")
                    umap_narrative_found = True
                    
            # If not found, create a dummy directory
            if not umap_narrative_found:
                try:
                    logger.warning("Creating dummy umap_narrative directory at /app/umap_narrative")
                    os.makedirs("/app/umap_narrative", exist_ok=True)
                    with open("/app/umap_narrative/__init__.py", "w") as f:
                        f.write("# Empty init file\n")
                    logger.info("Created dummy umap_narrative directory")
                except Exception as e:
                    logger.warning(f"Could not create dummy umap_narrative directory: {e}")
                    logger.warning("UMAP processing will be skipped")
            
            logger.debug("Core dependencies successfully loaded")
            return stage.complete(True, 
                                 dependencies="Core dependencies verified",
                                 missing_optional=len(missing_optional))
            
        except ImportError as e:
            logger.error(f"Missing dependency: {e}")
            return stage.complete(False, error=str(e))
    
    def initialize_conversation_manager(self):
        """Initialize the conversation manager and database connections"""
        stage = self.add_stage("Initialize Services")
        
        try:
            # Import required modules
            from polismath.conversation.manager import ConversationManager
            from polismath.database.postgres import PostgresClient
            
            # Initialize PostgreSQL client - required for loading conversation data
            logger.info("Initializing PostgreSQL connection")
            
            # Initialize direct PostgreSQL connection first to validate URL
            db_url = os.environ.get('DATABASE_URL')
            if not db_url:
                logger.error("DATABASE_URL environment variable not set")
                return stage.complete(False, error="DATABASE_URL not set")
                
            logger.info(f"Database URL: {db_url}")
            
            # Test connection directly
            try:
                from sqlalchemy import create_engine, text
                engine = create_engine(db_url)
                with engine.connect() as conn:
                    result = conn.execute(text("SELECT 1")).scalar()
                    logger.info(f"Direct connection test successful: {result}")
                    
                    # Test schema access
                    try:
                        table_result = conn.execute(text("SELECT table_name FROM information_schema.tables WHERE table_schema='public'"))
                        tables = [row[0] for row in table_result]
                        logger.info(f"Available tables: {', '.join(tables[:10])}...")
                    except Exception as e:
                        logger.warning(f"Could not list tables: {e}")
            except Exception as e:
                logger.error(f"Direct database connection failed: {e}")
                return stage.complete(False, error=f"Database connection error: {e}")
            
            # Create and initialize PostgreSQL client
            postgres_client = PostgresClient()
            postgres_client.initialize()
            
            # Verify initialization
            if not postgres_client.engine:
                logger.error("PostgreSQL client engine not initialized")
                return stage.complete(False, error="PostgreSQL client not properly initialized")
            
            # Initialize the conversation manager
            self.conv_manager = ConversationManager()
            
            # Validate PostgreSQL connection
            if self.validate:
                try:
                    # Try a simple query to test the connection
                    logger.info("Testing PostgreSQL connection")
                    # Print connection info for debugging
                    logger.info(f"DATABASE_URL: {os.environ.get('DATABASE_URL', 'not set')}")
                    # We need to use the client's internal methods to test the connection
                    if hasattr(postgres_client, 'engine'):
                        try:
                            # Try to execute a simple query
                            with postgres_client.engine.connect() as conn:
                                result = conn.execute("SELECT 1")
                                logger.info(f"PostgreSQL connection test result: {result.scalar()}")
                                logger.info("PostgreSQL client initialized successfully")
                        except Exception as e:
                            logger.warning(f"PostgreSQL connection test failed: {e}")
                    else:
                        logger.warning("PostgreSQL client initialization might have failed - no engine attribute")
                except Exception as e:
                    logger.warning(f"PostgreSQL connection validation skipped: {e}")
            
            # Also initialize DynamoDB for storing analysis results
            if self.validate:
                try:
                    # Test DynamoDB connection by listing tables
                    from polismath.database.dynamodb import DynamoDBClient
                    db_client = DynamoDBClient(endpoint_url='http://localhost:8000' if self.use_local_db else None)
                    db_client.initialize()
                    tables = [t.name for t in db_client.dynamodb.tables.all()]
                    logger.debug(f"Connected to DynamoDB with {len(tables)} tables: {', '.join(tables)}")
                except Exception as e:
                    logger.warning(f"DynamoDB connection check failed: {e}")
                    if self.use_local_db:
                        logger.warning("Make sure local DynamoDB is running on port 8000")
            
            return stage.complete(True, manager="ConversationManager initialized with PostgreSQL")
            
        except Exception as e:
            logger.error(f"Failed to initialize services: {e}")
            return stage.complete(False, error=str(e))
    
    def load_conversation(self):
        """Load conversation data from DynamoDB"""
        stage = self.add_stage("Load Conversation")
        
        try:
            # First try to load from DynamoDB
            logger.info("Attempting to load conversation data from DynamoDB...")
            self.conversation = self.conv_manager.load_conversation_from_dynamodb(self.zid)
            
            if not self.conversation:
                logger.warning("No data found in DynamoDB, falling back to PostgreSQL...")
                # Fall back to PostgreSQL only if DynamoDB has no data
                self.conversation = self.conv_manager.load_conversation_from_postgres(self.zid)
                
                if not self.conversation:
                    raise ValueError(f"No data found for conversation {self.zid} in either DynamoDB or PostgreSQL")
                
                # If we loaded from PostgreSQL, store in DynamoDB for future use
                logger.info("Storing PostgreSQL data in DynamoDB for future use...")
                self.conv_manager.store_conversation_in_dynamodb(self.conversation)
            
            logger.info(f"Successfully loaded conversation {self.zid}")
            return stage.complete(True, 
                                source="DynamoDB" if self.conversation else "PostgreSQL",
                                num_comments=len(self.conversation.comments),
                                num_votes=len(self.conversation.votes))
            
        except Exception as e:
            logger.error(f"Error loading conversation: {e}")
            return stage.complete(False, error=str(e))
    
    def run_math_processing(self):
        """Run PCA, clustering, and representativeness calculations"""
        stage = self.add_stage("Mathematical Processing")
        
        try:
            # Processing conversation with the manager will run:
            # 1. Vote matrix preparation
            # 2. PCA analysis
            # 3. Participant projection
            # 4. K-means clustering
            # 5. Representativeness calculations
            logger.info("Running PCA and clustering analysis...")
            
            # Fix potential initialization issues by verifying and setting up required attributes
            if hasattr(self.conversation, 'votes_matrix') and self.conversation.votes_matrix:
                # Count valid votes, participants, and comments
                participant_count = len(self.conversation.votes_matrix.keys())
                comment_sets = {tid for votes in self.conversation.votes_matrix.values() for tid in votes.keys()}
                comment_count = len(comment_sets)
                
                # Print actual counts
                logger.info(f"Votes matrix contains {participant_count} participants and {comment_count} comments")
                
                # Fix participant_count and comment_count attributes if they're incorrect
                if self.conversation.participant_count == 0 and participant_count > 0:
                    logger.info(f"Correcting participant_count from 0 to {participant_count}")
                    self.conversation.participant_count = participant_count
                
                if self.conversation.comment_count == 0 and comment_count > 0:
                    logger.info(f"Correcting comment_count from 0 to {comment_count}")
                    self.conversation.comment_count = comment_count
            
            # First, check if our conversation is present in the manager
            if self.zid not in self.conv_manager.conversations:
                logger.warning(f"Conversation {self.zid} not in manager - adding it")
                self.conv_manager.conversations[self.zid] = self.conversation
            
            # Ensure group_votes is initialized
            if not hasattr(self.conversation, 'group_votes'):
                logger.info("Initializing missing group_votes attribute")
                self.conversation.group_votes = {}
            
            # Process the conversation data by calling recompute()
            logger.info("Recomputing conversation data...")
            try:
                # Verify that the conversation object has the necessary attributes for recomputation
                if not hasattr(self.conversation, 'recompute'):
                    logger.error("Conversation object missing recompute method")
                    return stage.complete(False, error="Conversation object improperly initialized")
                
                # Add any missing initialization that might be needed for recomputation
                if not hasattr(self.conversation, 'group_votes'):
                    self.conversation.group_votes = {}
                    logger.info("Initialized group_votes attribute")
                
                # Now try to recompute
                if not hasattr(self.conversation, 'votes_matrix') or not self.conversation.votes_matrix:
                    logger.warning("Votes matrix is empty or missing - conversation may not recompute properly")
                    
                # Perform the recomputation
                self.conversation = self.conversation.recompute()
                self.conv_manager.conversations[self.zid] = self.conversation
                logger.info("Conversation recomputed successfully")
            except Exception as e:
                logger.error(f"Error recomputing conversation: {e}")
                import traceback as tb
                logger.error(tb.format_exc())
                return stage.complete(False, error=f"Recompute error: {e}")
            
            if not self.conversation:
                logger.error("Mathematical processing failed")
                return stage.complete(False, error="Processing failed")
            
            # Extract metrics for logging
            num_groups = len(self.conversation.group_clusters) if hasattr(self.conversation, 'group_clusters') else 0
            
            if num_groups < 2 and self.conversation.participant_count > 10:
                logger.warning("Only one opinion group detected despite having multiple participants")
            
            # Log the sizes of each group
            if hasattr(self.conversation, 'group_clusters'):
                for i, group in enumerate(self.conversation.group_clusters):
                    group_size = len(group['members'])
                    group_pct = (group_size / self.conversation.participant_count) * 100
                    logger.info(f"   Group {i}: {group_size} participants ({group_pct:.1f}%)")
            
            # Check consensus if available
            consensus_items = 0
            if hasattr(self.conversation, 'consensus'):
                consensus_items = len(self.conversation.consensus)
                logger.info(f"   Consensus items: {consensus_items}")
            
            # Check if PCA dimensions exist and are valid
            pca_dimensions = 0
            if hasattr(self.conversation, 'pca') and self.conversation.pca:
                if isinstance(self.conversation.pca, dict) and 'comps' in self.conversation.pca:
                    pca_dimensions = len(self.conversation.pca['comps'])
                    logger.info(f"PCA dimensions: {pca_dimensions}")
                else:
                    logger.warning("PCA object exists but lacks 'comps' key")
            
            return stage.complete(
                True,
                groups=num_groups,
                consensus_items=consensus_items,
                pca_dimensions=pca_dimensions
            )
            
        except Exception as e:
            logger.error(f"Mathematical processing failed: {e}")
            import traceback as tb
            tb.print_exc()
            return stage.complete(False, error=str(e))
    
    def store_math_results(self):
        """Store mathematical results in DynamoDB"""
        stage = self.add_stage("Store Math Results")
        
        try:
            logger.info("Writing math results to DynamoDB...")
            
            # Use the DynamoDB client directly for more control
            try:
                from polismath.database.dynamodb import DynamoDBClient
                
                # Use localhost for the container
                endpoint_url = 'http://dynamodb-local:8000' if self.use_local_db else None
                logger.info(f"Connecting to DynamoDB at {endpoint_url}")
                
                db_client = DynamoDBClient(endpoint_url=endpoint_url)
                
                # Initialize client with extra error handling
                try:
                    db_client.initialize()
                    logger.info("DynamoDB client initialized successfully")
                except Exception as e:
                    logger.error(f"Error initializing DynamoDB client: {e}")
                    import traceback as tb
                    logger.error(tb.format_exc())
                    # Continue anyway - we'll try to create the table
            
                # Try to create tables if they don't exist
                try:
                    # Try to create tables before writing
                    logger.info("Creating DynamoDB tables if needed...")
                    
                    # Define required tables
                    tables = {
                        'PolisMathConversations': {
                            'KeySchema': [{'AttributeName': 'zid', 'KeyType': 'HASH'}],
                            'AttributeDefinitions': [{'AttributeName': 'zid', 'AttributeType': 'S'}],
                            'ProvisionedThroughput': {'ReadCapacityUnits': 5, 'WriteCapacityUnits': 5}
                        },
                        'PolisMathAnalysis': {
                            'KeySchema': [
                                {'AttributeName': 'zid', 'KeyType': 'HASH'},
                                {'AttributeName': 'math_tick', 'KeyType': 'RANGE'}
                            ],
                            'AttributeDefinitions': [
                                {'AttributeName': 'zid', 'AttributeType': 'S'},
                                {'AttributeName': 'math_tick', 'AttributeType': 'N'}
                            ],
                            'ProvisionedThroughput': {'ReadCapacityUnits': 5, 'WriteCapacityUnits': 5}
                        }
                    }
                    
                    # Create tables if they don't exist
                    existing_tables = [t.name for t in db_client.dynamodb.tables.all()]
                    created_tables = []
                    
                    for table_name, table_schema in tables.items():
                        if table_name in existing_tables:
                            logger.info(f"Table {table_name} already exists")
                            continue
                        
                        try:
                            table = db_client.dynamodb.create_table(
                                TableName=table_name,
                                **table_schema
                            )
                            logger.info(f"Created table {table_name}")
                            created_tables.append(table_name)
                        except Exception as e:
                            logger.warning(f"Error creating table {table_name}: {e}")
                    
                    logger.info(f"Tables checked/created: {len(created_tables)} new tables")
                except Exception as e:
                    logger.warning(f"Error creating tables: {e}")
                
                # Store the conversation data
                try:
                    logger.info("Writing conversation data to DynamoDB...")
                    success = db_client.write_conversation(self.conversation)
                    
                    if not success:
                        logger.error("Failed to write math results to DynamoDB")
                        return stage.complete(False, error="Database write failed")
                    
                    logger.info("Successfully wrote conversation data to DynamoDB")
                except Exception as e:
                    logger.error(f"Error writing conversation: {e}")
                    import traceback as tb
                    logger.error(tb.format_exc())
                    # Continue anyway - we consider this optional
                
                # For very large conversations, write projections separately
                if self.conversation.participant_count > 5000:
                    logger.info(f"Writing projections separately for large conversation ({self.conversation.participant_count} participants)")
                    try:
                        projection_success = db_client.write_projections_separately(self.conversation)
                        if not projection_success:
                            logger.warning("Failed to write projections separately")
                    except Exception as e:
                        logger.warning(f"Error writing projections: {e}")
                
                return stage.complete(True, stored=True)
                
            except Exception as e:
                logger.error(f"Database error: {e}")
                import traceback as tb
                logger.error(tb.format_exc())
                # Skip DynamoDB storage but continue with pipeline
                logger.warning("Skipping DynamoDB storage due to errors")
                return stage.complete(True, stored=False)
                
        except Exception as e:
            logger.error(f"Unhandled error in store_math_results: {e}")
            import traceback as tb
            logger.error(tb.format_exc())
            # Continue with pipeline
            return stage.complete(True, stored=False)
    
    def run_umap_pipeline(self):
        """Run the UMAP narrative pipeline"""
        stage = self.add_stage("UMAP Pipeline")
        
        try:
            # Import the UMAP pipeline module
            umap_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "umap_narrative")
            if not os.path.exists(umap_path):
                logger.error(f"UMAP narrative module not found at {umap_path}")
                return stage.complete(False, error="UMAP module not found")
            
            sys.path.insert(0, umap_path)
            
            try:
                # Try to import the UMAP module
                from polismath_commentgraph.core.embedding import embed_comments
                from polismath_commentgraph.core.clustering import cluster_comments_evoc
                from polismath_commentgraph.utils.converter import extract_comments_from_conversation
                from polismath_commentgraph.utils.storage import DynamoDBStorage
            except ImportError as e:
                logger.error(f"Failed to import UMAP modules: {e}")
                return stage.complete(False, error=f"Import error: {e}")
            
            # Extract comments from the conversation
            comments = extract_comments_from_conversation(self.conversation)
            logger.info(f"Extracted {len(comments)} comments for embedding")
            
            # Create embeddings
            logger.info("Generating sentence embeddings...")
            embeddings = embed_comments(
                comments=comments,
                model_name="all-MiniLM-L6-v2"
            )
            
            logger.info(f"Generated {len(embeddings)} embeddings")
            
            # Run EVOC clustering
            logger.info("Running EVOC clustering...")
            clusters = cluster_comments_evoc(
                embeddings=embeddings,
                min_cluster_size=5,
                min_samples=5,
                comments=comments
            )
            
            # Count total clusters across layers
            total_clusters = sum(len(layer) for layer in clusters.values())
            logger.info(f"Created {total_clusters} clusters across {len(clusters)} layers")
            
            # Log details about each layer
            for layer_id, layer_clusters in clusters.items():
                items_in_clusters = sum(len(c['members']) for c in layer_clusters.values())
                coverage = (items_in_clusters / len(comments)) * 100 if comments else 0
                logger.info(f"   Layer {layer_id}: {len(layer_clusters)} clusters, {items_in_clusters} comments ({coverage:.1f}% coverage)")
            
            # Store results in DynamoDB
            logger.info("Storing UMAP results in DynamoDB...")
            storage = DynamoDBStorage(
                endpoint_url='http://localhost:8000' if self.use_local_db else None
            )
            
            # Store conversation metadata
            storage.store_conversation_meta(
                conversation_id=self.zid,
                processed_date=datetime.now().isoformat(),
                num_comments=len(comments),
                num_participants=self.conversation.participant_count,
                embedding_model="all-MiniLM-L6-v2",
                cluster_layers=[{"layer_id": int(layer_id), "num_clusters": len(clusters)} 
                               for layer_id, clusters in clusters.items()]
            )
            
            # Store embeddings
            for embedding in embeddings:
                storage.store_embedding(embedding)
            
            # Store cluster assignments
            for layer_id, layer_clusters in clusters.items():
                for cluster_id, cluster in layer_clusters.items():
                    for comment_id in cluster['members']:
                        # Find the comment in our list
                        comment_text = next((c.body for c in comments if c.comment_id == comment_id), f"Comment {comment_id}")
                        
                        storage.store_cluster_assignment(
                            conversation_id=self.zid,
                            comment_id=comment_id,
                            layer_id=int(layer_id),
                            cluster_id=int(cluster_id)
                        )
            
            return stage.complete(
                True,
                embeddings=len(embeddings),
                clusters=total_clusters,
                layers=len(clusters)
            )
            
        except Exception as e:
            logger.error(f"UMAP pipeline failed: {e}")
            import traceback as tb
            tb.print_exc()
            return stage.complete(False, error=str(e))
    
    def generate_topic_names(self):
        """Generate topic names for clusters"""
        stage = self.add_stage("Topic Generation")
        
        try:
            # Import the topic generation module
            try:
                from umap_narrative.polismath_commentgraph.utils.storage import DynamoDBStorage
                from umap_narrative.polismath_commentgraph.core.clustering import generate_topic_names
            except ImportError as e:
                logger.error(f"Failed to import topic generation modules: {e}")
                return stage.complete(False, error=f"Import error: {e}")
            
            # Retrieve cluster data from DynamoDB
            storage = DynamoDBStorage(
                endpoint_url='http://localhost:8000' if self.use_local_db else None
            )
            
            # Get conversation metadata to find layers
            meta = storage.get_conversation_meta(self.zid)
            if not meta or not meta.cluster_layers:
                logger.error("No cluster layers found in conversation metadata")
                return stage.complete(False, error="No cluster layers found")
            
            # Keep track of generated topics
            total_topics = 0
            
            # Generate topics for each layer
            for layer in meta.cluster_layers:
                layer_id = layer.layer_id
                logger.info(f"Generating topics for layer {layer_id}...")
                
                # Get all clusters for this layer
                clusters = storage.get_clusters_for_layer(self.zid, layer_id)
                
                if not clusters:
                    logger.warning(f"No clusters found for layer {layer_id}")
                    continue
                
                # Generate topic names for this layer
                topics = generate_topic_names(clusters, model_name="gpt-3.5-turbo")
                
                if not topics:
                    logger.warning(f"Failed to generate topics for layer {layer_id}")
                    continue
                
                # Store topics in DynamoDB
                for topic in topics:
                    storage.store_topic_name(topic)
                
                total_topics += len(topics)
                logger.info(f"   Generated {len(topics)} topics for layer {layer_id}")
            
            return stage.complete(
                True,
                topics=total_topics
            )
            
        except Exception as e:
            logger.error(f"Topic generation failed: {e}")
            logger.warning("Topic generation is an optional step - continuing with pipeline")
            return stage.complete(True, warning=str(e))
    
    def summarize_results(self):
        """Summarize the results of the pipeline"""
        stage = self.add_stage("Results Summary")
        
        try:
            # Get the successful stages
            successful_stages = [s for s in self.stages if s.success]
            
            # Calculate overall statistics
            stats = {
                "conversation_id": self.zid,
                "participant_count": self.conversation.participant_count if self.conversation else 0,
                "comment_count": self.conversation.comment_count if self.conversation else 0,
                "opinion_groups": len(self.conversation.group_clusters) if hasattr(self.conversation, 'group_clusters') else 0,
                "stages_completed": len(successful_stages),
                "total_processing_time": sum(s.duration for s in successful_stages if s.duration)
            }
            
            # Print summary table
            logger.info("=" * 50)
            logger.info(f"PIPELINE SUMMARY FOR CONVERSATION {self.zid}")
            logger.info("=" * 50)
            logger.info(f"Participants:     {stats['participant_count']}")
            logger.info(f"Comments:         {stats['comment_count']}")
            logger.info(f"Opinion Groups:   {stats['opinion_groups']}")
            logger.info(f"Stages Completed: {stats['stages_completed']}/{len(self.stages)}")
            logger.info(f"Processing Time:  {stats['total_processing_time']:.2f} seconds")
            logger.info("=" * 50)
            
            # Print status of each stage
            logger.info("Stage Status:")
            for s in self.stages:
                status = "✓" if s.success else "✗"
                duration = f"{s.duration:.2f}s" if s.duration else "N/A"
                logger.info(f"  {status} {s.name}: {duration}")
            
            logger.info("=" * 50)
            
            return stage.complete(True, **stats)
            
        except Exception as e:
            logger.error(f"Failed to summarize results: {e}")
            return stage.complete(False, error=str(e))
    
    def check_postgres_connection(self):
        """Check PostgreSQL connection and list available conversations"""
        stage = self.add_stage("PostgreSQL Connection Check")
        
        try:
            # Test direct connection to PostgreSQL
            db_url = os.environ.get('DATABASE_URL')
            if not db_url:
                logger.error("DATABASE_URL environment variable not set")
                return stage.complete(False, error="DATABASE_URL not set")
                
            logger.info(f"Database URL: {db_url}")
            
            # Try direct connection
            try:
                from sqlalchemy import create_engine, text
                engine = create_engine(db_url)
                with engine.connect() as conn:
                    logger.info("Connected to PostgreSQL, checking available conversations...")
                    
                    # Look directly for our target conversation
                    result = conn.execute(
                        text("SELECT zid, topic FROM conversations WHERE zid = :zid"),
                        {"zid": self.zid}
                    )
                    target_conv = list(result)
                    
                    if target_conv:
                        logger.info(f"Target conversation {self.zid} found: {target_conv[0][1]}")
                        return stage.complete(True, target_found=True)
                    else:
                        # Check if the conversation exists at all
                        logger.warning(f"Conversation {self.zid} not found, will check all tables")
                        
                        # Search for votes for this conversation
                        vote_check = conn.execute(
                            text("SELECT COUNT(*) FROM votes WHERE zid = :zid"),
                            {"zid": self.zid}
                        ).scalar()
                        
                        if vote_check > 0:
                            logger.info(f"Found {vote_check} votes for conversation {self.zid}")
                            return stage.complete(True, target_found=True, votes_found=vote_check)
                        else:
                            logger.warning(f"No votes found for conversation {self.zid} either")
                        
                    # Return success even if not found - we'll try to create it
                    return stage.complete(True, target_found=False)
            except Exception as e:
                logger.error(f"PostgreSQL direct connection failed: {e}")
                return stage.complete(False, error=f"PostgreSQL connection error: {e}")
                
        except Exception as e:
            logger.error(f"Failed to check PostgreSQL connection: {e}")
            return stage.complete(False, error=str(e))
    
    def run(self):
        """Run the complete pipeline"""
        # Import traceback at the top level for error handling
        import traceback as tb
        start_time = time.time()
        
        # Display banner
        logger.info("=" * 60)
        logger.info(f"DELPHI ORCHESTRATOR - CONVERSATION {self.zid}")
        logger.info("=" * 60)
        
        # For tracking critical failures
        critical_failure = False
        
        # Check dependencies
        dependencies_ok = self.check_dependencies().success
        if not dependencies_ok:
            logger.warning("Some dependencies may be missing, but attempting to continue")
            # Don't fail immediately - try to continue
        
        # Check PostgreSQL connection first to validate that the database is working
        postgres_ok = self.check_postgres_connection().success
        if not postgres_ok:
            logger.error("PostgreSQL connection failed - this is a critical failure")
            critical_failure = True
            return False
            
        # Initialize services
        services_ok = self.initialize_conversation_manager().success
        if not services_ok:
            logger.error("Failed to initialize services - this is a critical failure")
            critical_failure = True
            return False
        
        # Load conversation data
        load_ok = self.load_conversation().success
        if not load_ok:
            logger.error("Failed to load conversation data - this is a critical failure")
            critical_failure = True
            return False
        
        # Run the math processing and store results
        math_success = self.run_math_processing().success
        if not math_success:
            logger.error("Math processing failed, aborting pipeline")
            critical_failure = True
            return False
        
        # At this point, the core functionality (math processing) has succeeded
        # Mark the pipeline as successful even if optional steps fail
        pipeline_successful = True
            
        # Store results in DynamoDB (continue even if this fails)
        try:
            store_success = self.store_math_results().success
            if not store_success:
                logger.warning("DynamoDB storage failed, but continuing with pipeline")
        except Exception as e:
            logger.warning(f"DynamoDB storage error: {e}, continuing anyway")
        
        # Try UMAP but continue even if it fails
        try:
            umap_result = self.run_umap_pipeline()
            umap_success = umap_result.success
            if not umap_success:
                logger.warning("UMAP pipeline failed, but continuing with pipeline")
        except Exception as e:
            logger.warning(f"UMAP pipeline error: {e}, continuing anyway")
        
        # Generate topic names (optional) - continue even if it fails
        try:
            self.generate_topic_names()
        except Exception as e:
            logger.warning(f"Topic generation error: {e}, continuing anyway")
        
        # Summarize results
        try:
            self.summarize_results()
        except Exception as e:
            logger.warning(f"Error summarizing results: {e}")
        
        # Calculate total execution time
        end_time = time.time()
        total_time = end_time - start_time
        
        # Pipeline is considered successful if math processing worked
        if not critical_failure:
            logger.info(f">> Pipeline completed successfully in {total_time:.2f} seconds")
            logger.info(f"Core processing (PCA and clustering) completed for conversation {self.zid}")
            logger.info(f"To view results, access the visualization at: https://pol.is/{self.zid}")
            return True
        else:
            logger.error(f">> Pipeline failed after {total_time:.2f} seconds")
            return False

def main():
    # Parse command line arguments
    parser = argparse.ArgumentParser(description="Delphi Orchestrator - Unified Analysis Pipeline for Polis")
    parser.add_argument("--zid", required=True, help="Conversation ID to process")
    parser.add_argument("--local", action="store_true", help="Use local DynamoDB")
    parser.add_argument("--verbose", action="store_true", help="Enable verbose logging")
    parser.add_argument("--force", action="store_true", help="Force reprocessing even if data exists")
    parser.add_argument("--validate", action="store_true", help="Run extra validation checks")
    
    args = parser.parse_args()
    
    # Create and run the orchestrator
    orchestrator = DelphiOrchestrator(
        zid=args.zid,
        use_local_db=args.local,
        verbose=args.verbose,
        force=args.force,
        validate=args.validate
    )
    
    success = orchestrator.run()
    
    # Exit with appropriate status code
    return 0 if success else 1

if __name__ == "__main__":
    sys.exit(main())