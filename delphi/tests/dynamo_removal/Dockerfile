# CI builds DELPHI_BASE from delphi/Dockerfile. Build boxes may reuse an existing
# dependency image; all candidate Python sources and the freshly built daemon
# are copied below, so old installed application sources cannot win imports.
ARG DELPHI_BASE=polis-dynamo-deps:local
FROM ${DELPHI_BASE}
COPY delphi/ /app/
COPY --from=queue-binary polis-jobs /usr/local/bin/polis-jobs
RUN python -m pip install --no-cache-dir pytest==8.3.5 pytest-cov==6.0.0
ENV PYTHONPATH=/app:/app/scripts PYTHONDONTWRITEBYTECODE=1
ENV DELPHI_EMBED_MODEL_PATH=/opt/polis/embedding/all-MiniLM-L6-v2
RUN if [ ! -f "$DELPHI_EMBED_MODEL_PATH/config.json" ]; then \
      python -c 'from sentence_transformers import SentenceTransformer; import os; SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2").save(os.environ["DELPHI_EMBED_MODEL_PATH"])'; \
    fi
ENTRYPOINT []
CMD ["polis-jobs"]
