FROM public.ecr.aws/lambda/python:3.10

# Install system dependencies
RUN yum update -y && yum install -y \
    gcc \
    g++ \
    make \
    git \
    && yum clean all

# Copy requirements and install dependencies  
# Note: Uses requirements.txt instead of pyproject.toml for Lambda deployment simplicity
# The pyproject.toml is only for local development/IDE support
COPY requirements.txt ${LAMBDA_TASK_ROOT}/

# Install dependencies (including evoc from requirements.txt)
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . ${LAMBDA_TASK_ROOT}/

# Set environment variables
ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=${LAMBDA_TASK_ROOT}
ENV LOG_LEVEL=INFO
ENV MODEL_CACHE_DIR=/tmp/model_cache

# Create model cache directory
RUN mkdir -p ${MODEL_CACHE_DIR} && chmod 777 ${MODEL_CACHE_DIR}

# Set the Lambda handler
CMD ["polismath_commentgraph.lambda_handler.lambda_handler"]