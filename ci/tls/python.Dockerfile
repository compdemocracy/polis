ARG BASE
FROM ${BASE}
COPY delphi/requirements.lock /tmp/requirements.lock
RUN python -m pip install --no-cache-dir \
      $(grep -E '^(certifi|requests|httpx|botocore|boto3)==' /tmp/requirements.lock) \
 && rm /tmp/requirements.lock
