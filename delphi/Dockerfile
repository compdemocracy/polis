# ---- Stage 1: Builder ----
  FROM python:3.12-slim AS builder

  # Define a build argument to signal if running in GitHub Actions
  ARG IS_GITHUB_ACTION=false
  ARG AWS_REGION

  ENV PYTHONDONTWRITEBYTECODE=1
  ENV PYTHONUNBUFFERED=1

  RUN apt-get update && \
      apt-get install -y --no-install-recommends \
          git \
          build-essential \
          cmake \
          gcc \
          g++ \
          gfortran \
          libopenblas-dev \
          curl \
      && apt-get clean && \
      rm -rf /var/lib/apt/lists/*

  WORKDIR /app

  # ===== OPTIMIZATION: Install dependencies FIRST (cached layer) =====
  # Copy only dependency files first - this layer is cached unless dependencies change
  COPY pyproject.toml requirements.lock ./

  # Conditionally install PyTorch CPU versions if IS_GITHUB_ACTION is true
  RUN --mount=type=cache,target=/root/.cache/pip \
      if [ "$IS_GITHUB_ACTION" = "true" ]; then \
              echo "IS_GITHUB_ACTION is true. Installing PyTorch CPU versions..."; \
              pip install \
                  --index-url https://download.pytorch.org/whl/cpu \
                  torch==2.8.0+cpu \
                  torchvision==0.23.0+cpu \
                  torchaudio==2.8.0+cpu; \
          else \
              echo "IS_GITHUB_ACTION is false or not set. Skipping explicit PyTorch CPU-specific installation."; \
              echo "PyTorch (if required) will be installed from requirements.lock."; \
          fi

  # Install dependencies from lock file (cached layer - reused unless requirements.lock changes)
  # BuildKit cache mount keeps pip cache between builds for faster rebuilds
  RUN --mount=type=cache,target=/root/.cache/pip \
      if [ "$IS_GITHUB_ACTION" = "true" ]; then \
              echo "IS_GITHUB_ACTION is true. Skipping requirements.lock (already installed CPU deps)."; \
          else \
              echo "IS_GITHUB_ACTION is false. Installing from requirements.lock..."; \
              pip install -r requirements.lock; \
          fi

  # ===== OPTIMIZATION: Copy source code LAST (busts cache on code changes) =====
  # Copy source code - this layer rebuilds when code changes but reuses dependency layers above
  COPY polismath/ ./polismath/
  COPY umap_narrative/ ./umap_narrative/
  COPY scripts/ ./scripts/
  COPY *.py ./

  # Install the project package (without dependencies - they're already installed)
  # This registers entry points and installs the package in development mode
  RUN --mount=type=cache,target=/root/.cache/pip \
      pip install --no-deps .

  RUN echo "--- PyTorch Check (after pyproject.toml installation) ---" && \
      pip show torch torchvision torchaudio && \
      python -c "import torch; print(f'Torch version: {torch.__version__}'); print(f'CUDA available: {torch.cuda.is_available()}')" && \
      echo "--- Looking for NVIDIA/CUDA libs ---" && \
      (ls -lhR /usr/local/lib/python3.12/site-packages/nvidia || echo "NVIDIA directory not found.") && \
      (ls -lhR /usr/local/lib/python3.12/site-packages/torch/lib/*cuda* || echo "No CUDA libs in torch/lib.")

  # ---- Stage 2: Final ----
  FROM python:3.12-slim AS final

  ENV PYTHONDONTWRITEBYTECODE=1
  ENV PYTHONUNBUFFERED=1
  ENV AWS_REGION=${AWS_REGION:-us-east-1}

  RUN apt-get update && \
      apt-get install -y --no-install-recommends \
          curl \
      && apt-get clean && \
      rm -rf /var/lib/apt/lists/*

  WORKDIR /app

  # Copy installed packages from builder stage
  COPY --from=builder /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
  COPY --from=builder /usr/local/bin /usr/local/bin

  # Copy source code from builder stage (already built into the package)
  COPY --from=builder /app/polismath/ ./polismath/
  COPY --from=builder /app/scripts/ ./scripts/
  COPY --from=builder /app/umap_narrative/ ./umap_narrative/
  COPY --from=builder /app/*.py ./

  RUN mkdir -p data
  EXPOSE 8080
  # PYTHONPATH not needed since packages are properly installed via pip

  # Make scripts executable
  RUN chmod +x run_delphi.py scripts/setup_ollama.sh

  CMD ["bash", "-c", "\
    echo 'Ensuring DynamoDB tables are set up (runs in all environments)...'; \
    python create_dynamodb_tables.py --region ${AWS_REGION} && \
    echo 'DynamoDB table setup script finished.'; \
    \
    if [ -n \"${DYNAMODB_ENDPOINT}\" ]; then \
      echo 'DYNAMODB_ENDPOINT is set, assuming local/dev environment. Running additional local setup scripts...'; \
      echo 'Setting up MinIO bucket...' && python setup_minio.py && \
      echo 'Setting up Ollama model (local script)...' && ./scripts/setup_ollama.sh && \
      echo 'Starting job poller without ddtrace...' && \
      python scripts/job_poller.py --interval=2; \
    else \
      echo 'DYNAMODB_ENDPOINT is not set, assuming production-like environment. Skipping local setup scripts.'; \
      if [ \"${AWS_REGION}\" = \"us-east-1\" ]; then \
        echo 'Starting job poller WITH ddtrace in us-east-1...' && \
        ddtrace-run python scripts/job_poller.py --interval=2 --region ${AWS_REGION}; \
      else \
        echo 'Starting job poller WITHOUT ddtrace in other regions...' && \
        python scripts/job_poller.py --interval=2 --region ${AWS_REGION}; \
      fi; \
    fi \
  "]