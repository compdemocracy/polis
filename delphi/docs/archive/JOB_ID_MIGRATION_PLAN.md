# Migration Plan: From Conversation ID to Job ID

## Executive Summary

This document outlines the comprehensive plan to migrate the Delphi system from using conversation ID (zid) as the primary key for results to using job ID. This change will allow multiple processing jobs on the same conversation to coexist without overwriting previous results.

## Current System Architecture

The current system uses the conversation ID (zid) as the primary key for storing and retrieving results:

1. **Data Storage**: 
   - DynamoDB tables use `conversation_id` or `zid` as the hash key
   - Results for new jobs overwrite previous results for the same conversation
   - Naming patterns like `zid_tick` and `zid_tick_gid` are used to uniquely identify data

2. **Processing Pipeline**:
   - Run by `job_poller.py` which sets `DELPHI_JOB_ID` but it's only used for S3 visualization output paths
   - Core data processing in `run_math_pipeline.py` and `run_pipeline.py` relies only on conversation ID
   - Visualizations in `700_datamapplot_for_layer.py` use job ID only for S3 output

3. **API and Client Interaction**:
   - API endpoints in `server/src/routes/delphi/` reference only conversation ID
   - No way for clients to request specific job results

## Proposed System Architecture

The new system will use job ID as the primary key for storing and retrieving results:

1. **Data Storage**:
   - Modify DynamoDB tables to use composite keys with `job_id` and `conversation_id`
   - Create new global secondary indexes for querying by conversation ID
   - Migrate to patterns like `job_id_zid_tick` for unique identification

2. **Processing Pipeline**:
   - Update all pipeline components to use job ID for data storage and retrieval
   - Modify environment variable passing to ensure job ID is available throughout
   - Update visualization components to organize by job ID first, then conversation ID

3. **API and Client Interaction**:
   - Update API endpoints to require job ID or fall back to latest job for a conversation
   - Add new endpoints to list all jobs for a conversation

## Migration Plan

### Phase 1: Assessment and Planning (1-2 weeks)

1. **Database Schema Design**
   - Design new DynamoDB table schemas with job ID
   - Define migration strategy for existing data
   - Document required changes to all tables

2. **Code Analysis**
   - Identify all code locations that need modification
   - Create comprehensive testing plan
   - Define rollback procedures

### Phase 2: Core Infrastructure Updates (2-3 weeks)

1. **Update DynamoDB Tables and Storage Classes**
   - Create new tables or update existing table schemas
   - Modify `DynamoDBStorage` class in `/polismath_commentgraph/utils/storage.py`
   - Add backward compatibility layer

2. **Update Job Poller and Job Queue**
   - Enhance `job_poller.py` to pass job ID to all pipeline components
   - Update job status tracking to include results storage locations
   - Implement job history tracking

### Phase 3: Processing Pipeline Updates (2-3 weeks)

1. **Update Math Pipeline**
   - Modify `run_math_pipeline.py` to use job ID as primary key
   - Update result storage methods
   - Add compatibility for legacy data access

2. **Update UMAP Narrative Pipeline**
   - Modify `run_pipeline.py` to use job ID
   - Update all data storage operations
   - Update report generation to include job ID

3. **Update Visualization Components**
   - Modify `700_datamapplot_for_layer.py` to use job ID for data retrieval
   - Update visualization storage paths
   - Implement multiple job visualization comparison

### Phase 4: API and Client Integration (1-2 weeks)

1. **Update Server API Endpoints**
   - Modify `/routes/delphi/*.ts` files to accept job ID
   - Implement default job ID resolution (latest job)
   - Add endpoints to list jobs by conversation

2. **Client Integration**
   - Update client components to handle job IDs
   - Implement job selection UI components
   - Add job history view

### Phase 5: Testing and Deployment (2-3 weeks)

1. **Testing**
   - Develop comprehensive test suite
   - Test with actual conversation data
   - Verify backward compatibility
   - Load testing and performance validation

2. **Deployment Strategy**
   - Staged rollout with monitoring
   - Database migration procedures
   - Rollback procedures

## Detailed Implementation Tasks

### 1. Database Schema Updates

#### Current Schema Issues
The current DynamoDB tables use `conversation_id` or `zid` as the primary key, which means new jobs overwrite previous results.

#### New Schema Design
The new design will use composite keys that include both job ID and conversation ID:

```typescript
// Example for PCA Results Table
{
  KeySchema: [
    { AttributeName: 'job_id', KeyType: 'HASH' },       // Primary partition key
    { AttributeName: 'zid', KeyType: 'RANGE' }          // Primary sort key
  ],
  GlobalSecondaryIndexes: [
    {
      IndexName: 'ConversationIndex',
      KeySchema: [
        { AttributeName: 'zid', KeyType: 'HASH' },      // For querying by zid
        { AttributeName: 'timestamp', KeyType: 'RANGE' }
      ],
      Projection: { ProjectionType: 'ALL' }
    }
  ]
}
```

This approach allows:
- Storing multiple job results for the same conversation
- Efficient querying by either job ID or conversation ID
- Compatibility with existing code through GSIs

#### Tables Requiring Updates

1. **Core Math Tables**:
   - `Delphi_PCAConversationConfig`
   - `Delphi_PCAResults`
   - `Delphi_KMeansClusters`
   - `Delphi_CommentRouting`
   - `Delphi_RepresentativeComments`
   - `Delphi_PCAParticipantProjections`

2. **UMAP/Topic Tables**:
   - `Delphi_UMAPConversationConfig`
   - `Delphi_CommentEmbeddings`
   - `Delphi_CommentHierarchicalClusterAssignments`
   - `Delphi_CommentClustersStructureKeywords`
   - `Delphi_UMAPGraph`
   - `Delphi_CommentClustersFeatures`
   - `Delphi_CommentClustersLLMTopicNames`

3. **Report Tables**:
   - `Delphi_NarrativeReports`

### 2. Code Updates

#### DynamoDB Storage Class
The `DynamoDBStorage` class in `/polismath_commentgraph/utils/storage.py` needs significant updates:

1. **Constructor and Table Schema Definitions**:
   ```python
   def initialize(self):
       # Update table definitions to use job_id as primary key
       table_schemas = {
           'pca_results': {
               'KeySchema': [
                   {'AttributeName': 'job_id', 'KeyType': 'HASH'},
                   {'AttributeName': 'zid', 'KeyType': 'RANGE'}
               ],
               # Add GSIs for querying by zid
           }
           # More table definitions...
       }
   ```

2. **Write Methods**:
   ```python
   def write_pca_results(self, job_id, zid, results):
       """Write PCA results for a specific job and conversation."""
       self.tables['pca_results'].put_item(
           Item={
               'job_id': job_id,
               'zid': zid,
               'timestamp': int(time.time()),
               'results': results
           }
       )
   ```

3. **Read Methods**:
   ```python
   def read_pca_results(self, job_id, zid):
       """Read PCA results for a specific job and conversation."""
       response = self.tables['pca_results'].get_item(
           Key={
               'job_id': job_id,
               'zid': zid
           }
       )
       return response.get('Item')
   
   def read_latest_results_for_conversation(self, zid):
       """Legacy method to get latest results for a conversation."""
       response = self.tables['pca_results'].query(
           IndexName='ConversationIndex',
           KeyConditionExpression='zid = :zid',
           ExpressionAttributeValues={':zid': zid},
           Limit=1,
           ScanIndexForward=False  # Descending order by timestamp
       )
       items = response.get('Items', [])
       return items[0] if items else None
   ```

#### Job Poller Updates
The `job_poller.py` script needs to be enhanced:

```python
def process_job(self, job):
    """Process a job using run_delphi.sh."""
    job_id = job['job_id']
    zid = job['conversation_id']
    
    # Add job ID to environment
    env = os.environ.copy()
    env['DELPHI_JOB_ID'] = job_id
    env['DELPHI_ZID'] = zid
    
    # Build command for run_delphi.sh with job ID
    cmd = ['./run_delphi.sh', f'--zid={zid}', f'--job-id={job_id}']
    
    # Rest of method...
```

#### Core Pipeline Updates
The `run_delphi.sh` script needs to be updated to accept and pass the job ID:

```bash
# Extract job ID from arguments
JOB_ID=""
for arg in "$@"; do
  case $arg in
    --job-id=*)
      JOB_ID="${arg#*=}"
      ;;
    # Other cases...
  esac
done

# Use job ID in pipeline commands
python /app/polismath/run_math_pipeline.py --zid=${ZID} --job-id=${JOB_ID} ${MAX_VOTES_ARG} ${BATCH_SIZE_ARG}

# Run the UMAP narrative pipeline
python /app/umap_narrative/run_pipeline.py --zid=${ZID} --job-id=${JOB_ID} --use-ollama ${VERBOSE}
```

#### Visualization Updates
The visualization scripts need updated data loading logic:

```python
def load_conversation_data_from_dynamo(job_id, zid, layer_id, dynamo_storage):
    """Load data for a specific job, conversation, and layer."""
    # Query by job_id and zid
    return dynamo_storage.load_visualization_data(job_id, zid, layer_id)
```

#### API Endpoint Updates
The server API endpoints need to be updated to handle job IDs:

```typescript
// In topics.ts
export function handle_GET_delphi(req: Request, res: Response) {
  const report_id = req.query.report_id as string;
  const job_id = req.query.job_id as string;
  
  // Get conversation ID from report ID
  getZidFromReport(report_id)
    .then(zid => {
      if (!zid) {
        return res.json({
          status: "error",
          message: "Could not find conversation for report_id",
          report_id: report_id
        });
      }
      
      const conversation_id = zid.toString();
      
      // If job_id is provided, use it directly
      if (job_id) {
        return fetchTopicsForJob(job_id, conversation_id);
      }
      
      // Otherwise, get the latest job for this conversation
      return getLatestJobForConversation(conversation_id)
        .then(latestJob => {
          if (!latestJob) {
            return res.json({
              status: "error",
              message: "No jobs found for this conversation",
              report_id: report_id,
              conversation_id: conversation_id
            });
          }
          
          return fetchTopicsForJob(latestJob.job_id, conversation_id);
        });
    });
}
```

### 3. Data Migration Strategy

Migrating existing data will follow these steps:

1. **Database Schema Updates**:
   - Create new tables with the new schema
   - Keep old tables temporarily

2. **Data Migration Script**:
   - Create a migration script that:
     - Identifies all unique conversations
     - Creates a "legacy" job ID for each
     - Copies data to new tables with the legacy job ID
   - Run the script after schema updates

3. **Dual Writes During Transition**:
   - Implement a period of dual writes to both old and new tables
   - Validate consistency between old and new data
   - Add fallback to old tables if new table reads fail

4. **Validation and Cutover**:
   - Validate all migrated data
   - Update all code to use new tables
   - Remove fallback to old tables
   - Archive old tables for backup

## Timeline and Resource Requirements

The migration can be completed in 8-10 weeks with the following resources:

1. **Development Resources**:
   - 2 backend developers with Python and DynamoDB experience
   - 1 frontend developer for client changes
   - 1 DevOps engineer for deployment and monitoring

2. **Testing Resources**:
   - Test environment with production-like data
   - CI/CD pipeline for automated testing
   - Monitoring systems for tracking performance

3. **Timeline**:
   - Week 1-2: Assessment and planning
   - Week 3-5: Core infrastructure updates
   - Week 6-8: Processing pipeline updates
   - Week 9-10: Testing, validation, and deployment

## Risks and Mitigation

1. **Data Loss Risk**:
   - **Mitigation**: Keep old tables until migration is fully validated
   - **Mitigation**: Implement backup and restore procedures

2. **Performance Degradation**:
   - **Mitigation**: Benchmark and optimize query patterns
   - **Mitigation**: Monitor performance during rollout

3. **Backward Compatibility**:
   - **Mitigation**: Maintain compatibility layer for legacy code
   - **Mitigation**: Phase out legacy access patterns gradually

4. **Complex Migration**:
   - **Mitigation**: Break work into smaller, testable units
   - **Mitigation**: Create detailed checklists for each step

## Conclusion

Migrating from conversation ID to job ID as the primary key will significantly improve the Delphi system's ability to handle multiple processing jobs on the same conversation. This change will eliminate the current limitation where new jobs overwrite previous results, enabling better version control, experimentation, and analysis across different processing configurations.

The migration requires careful planning and execution, but the benefits justify the effort. The proposed architecture provides a robust foundation for future enhancements to the Delphi system.