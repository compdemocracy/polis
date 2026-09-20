ARG RUNTIME_IMAGE
FROM ${RUNTIME_IMAGE}
COPY requirements.lock /tmp/requirements.lock
RUN python3.12 -m ensurepip && python3.12 -m pip install --require-hashes -r /tmp/requirements.lock && rm /tmp/requirements.lock
