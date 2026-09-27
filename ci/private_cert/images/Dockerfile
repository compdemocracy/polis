# The separately reviewed ARM64 runtime must already contain /usr/bin/python3,
# /opt/venv/bin/python, the locked numerical/JVM tools and offline
# dependency closures appropriate to this role. No dependency install at build
# or runtime. Build from the source-only context produced by stage.py.
ARG RUNTIME_IMAGE
FROM ${RUNTIME_IMAGE}
ARG RECIPE_SHA256
ARG IMAGE_ROLE
LABEL org.polis.private.recipe=${RECIPE_SHA256}
LABEL org.polis.private.role=${IMAGE_ROLE}
USER 0:0
WORKDIR /opt/polis-private-image
COPY --chown=0:0 --chmod=0444 recipe.json launcher.py ./
COPY --chown=0:0 payload/ ./payload/
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONNOUSERSITE=1 PYTHONUNBUFFERED=1
ENV HOME=/tmp UV_OFFLINE=1 PIP_NO_INDEX=1
USER 65534:65534
ENTRYPOINT ["/usr/bin/python3", "/opt/polis-private-image/launcher.py"]
CMD []
