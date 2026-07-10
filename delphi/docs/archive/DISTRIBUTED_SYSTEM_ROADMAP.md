# Delphi Distributed System Roadmap

## Overview

This document outlines the roadmap for evolving Delphi from its current state as a manually-executed system to a fully distributed, scalable processing architecture that integrates seamlessly with the Polis platform.

## Current State

- **Execution Model**: Job queue system with manual submission and poller service
- **DynamoDB**: Single shared instance with robust job queue schema
- **Orchestration**: Poller service (job_poller.py) plus run_delphi.sh for execution
- **Integration**: CLI interface (delphi_cli.py) for job management
- **Scalability**: Improved, supports concurrent worker processes

## Target Architecture

- **Execution Model**: Event-driven, job-based processing system
- **DynamoDB**: Single shared instance with robust schema design
- **Orchestration**: Automated poller service that scales with instance resources
- **Integration**: Tight integration with main Polis platform through job queue
- **Scalability**: Horizontal scaling through multiple worker instances

## Action Items

### Phase 1: Infrastructure Consolidation ✅
- [x] Merge DynamoDB instances into a single shared resource
- [x] Update documentation to reflect new shared database approach
- [x] Ensure Docker networking allows proper communication between services
- [x] Fix Delphi container CMD to keep it running stably
- [x] Set up autoscaling EC2 infrastructure for different workload types

### Phase 2: Job Queue System ✅
- [x] Design comprehensive job table schema
  - [x] Support for various job types (PCA, UMAP, report generation)
  - [x] Rich metadata fields for tracking state, progress, and results
  - [x] Comprehensive logging capabilities
  - [x] Priority and scheduling mechanisms
- [x] Create the jobs table in DynamoDB
- [x] Implement strongly consistent read patterns for distributed safety
- [x] Implement optimistic locking for reliable status updates
- [x] Create a CLI tool for job submission and monitoring
- [ ] Add integration tests for table operations

### Phase 3: Worker Implementation ✅
- [x] Develop a Python poller service
  - [x] Configurable polling interval
  - [x] Graceful error handling
  - [x] Comprehensive logging
  - [x] Resource-aware scaling (based on EC2 instance size)
- [x] Integrate with run_delphi.sh for job execution
- [x] Implement job status updates with versioning
- [ ] Create monitoring endpoints for health/status checks

### Phase 4: Producer Integration
- [ ] Develop Node.js client for the job system
- [ ] Add API endpoints for job submission
- [ ] Create job templates for common processing needs
- [ ] Implement callback mechanisms for job completion
- [ ] Build admin interfaces for monitoring job queue

### Phase 5: Testing and Deployment ⏳
- [ ] Create comprehensive test suite for distributed operation
- [ ] Develop load testing scenarios
- [x] Setup staging environment with auto-scaling infrastructure
- [x] Document deployment procedures for auto-scaling instances
- [ ] Create runbooks for common operational tasks

## Implementation Notes

### Strongly Consistent Reads
For DynamoDB operations in a distributed system, we must use strongly consistent reads:

```python
# Example of strongly consistent read
response = table.get_item(
    Key={'job_id': 'job123'},
    ConsistentRead=True
)
```

This ensures we get the most up-to-date data, reflecting all prior successful write operations.

### Resource-Aware Scaling ✅
The system now adjusts its behavior based on the EC2 instance size:

```python
# Implementation in configure_instance.py
import os
import logging

# Resource settings for different instance types
INSTANCE_CONFIGS = {
    "small": {
        "max_workers": 3,
        "worker_memory": "2g",
        "container_memory": "8g",
        "container_cpus": 2,
        "description": "Cost-efficient t3.large instance"
    },
    "large": {
        "max_workers": 8,
        "worker_memory": "8g", 
        "container_memory": "32g",
        "container_cpus": 8,
        "description": "High-performance c6g.4xlarge ARM instance"
    },
    "default": {
        "max_workers": 2,
        "worker_memory": "1g",
        "container_memory": "4g", 
        "container_cpus": 1,
        "description": "Default configuration"
    }
}

# Detect instance type from file or environment variables
def detect_instance_type():
    # First check environment variable
    instance_type = os.environ.get('INSTANCE_SIZE')
    if instance_type in INSTANCE_CONFIGS:
        return instance_type
        
    # Then check instance_size.txt file (created by UserData script)
    if os.path.exists('/tmp/instance_size.txt'):
        with open('/tmp/instance_size.txt', 'r') as f:
            instance_type = f.read().strip()
            if instance_type in INSTANCE_CONFIGS:
                return instance_type
    
    # Fall back to default configuration
    return "default"
```

The AWS infrastructure includes two auto-scaling groups:
1. Small Instance ASG (t3.large): 2 instances by default, scales up to 5
2. Large Instance ASG (c6g.4xlarge): 1 ARM instance by default, scales up to 3

### Docker Integration

The Docker container should be configured to start the poller service automatically:

```dockerfile
# Example Dockerfile update
CMD ["python", "-m", "delphi.poller.service"]
```

## Next Steps

The immediate focus should be on:

1. **Node.js Integration** - Develop a helper for the server to enqueue jobs
2. **Production Hardening** - Create systemd service files for the poller
3. **Operational Tools** - Implement job archiving and cleanup mechanisms
4. **Monitoring** - Expand CloudWatch metrics for job processing

### Completed Infrastructure Work

- [x] **Auto-scaling Infrastructure** - Set up EC2 auto-scaling for different Delphi workloads
  - Created small instance (t3.large) auto-scaling group for regular workloads
  - Created large instance (c6g.4xlarge ARM) auto-scaling group for demanding jobs
  - Added CPU-based scaling triggers (60% target, alarms at 80%)
  - Set up CloudWatch monitoring and alarms for both instance types
  
- [x] **Resource Adaptation** - Implemented system that detects instance type and adjusts resource usage
  - Created helper script to detect instance size from metadata
  - Added environment variable configuration for worker threads and memory limits
  - Updated Docker Compose to respect resource constraints
  - Modified deployment scripts to configure the environment correctly

These steps have significantly advanced the journey from a manual execution model to a fully distributed, scalable system integrated with the main Polis application.