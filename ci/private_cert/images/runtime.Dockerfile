# Build only in the isolated builder. All inputs must be preloaded, reviewed
# Linux ARM64 digest references. This composes offline dependencies; no source,
# fixtures, host home, credentials, apt or pip is copied/resolved at runtime.
ARG NUMERICAL_IMAGE
ARG CLOJURE_IMAGE
ARG OS_IMAGE
FROM ${NUMERICAL_IMAGE} AS numerical
FROM ${CLOJURE_IMAGE} AS oracle
FROM ${OS_IMAGE}
COPY --from=numerical /usr/local/ /usr/local/
COPY --from=oracle /opt/java/openjdk/ /opt/java/openjdk/
COPY --from=oracle /root/.m2/repository/ /opt/m2/
COPY --from=oracle /app/.cpcache/ /opt/oracle-classpath/
COPY clojure-offline.py /usr/local/bin/clojure
RUN chmod 0555 /usr/local/bin/clojure && ln -sf /usr/local/bin/python3 /usr/bin/python3 && \
    mkdir -p /opt/venv/bin && ln -s /usr/local/bin/python3 /opt/venv/bin/python && \
    chmod -R a+rX /opt/m2 /opt/oracle-classpath
ENV JAVA_HOME=/opt/java/openjdk
ENV PATH=/opt/venv/bin:/opt/java/openjdk/bin:/usr/local/bin:/usr/bin:/bin
