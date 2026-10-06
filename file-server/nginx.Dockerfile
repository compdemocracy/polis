FROM docker.io/nginx:1.21.5-alpine

# Copy config as template
COPY nginx/nginx-ssl.site.default.conf /etc/nginx/conf.d/default.conf.template

# Rust API route templates, rendered by the entrypoint only when
# RUST_API_ROUTES is set.
COPY nginx/rust-api/ /etc/nginx/rust-api-templates/
RUN mkdir -p /etc/nginx/rust-api \
 && touch /etc/nginx/rust-api/upstreams.conf /etc/nginx/rust-api/locations.conf

# Copy entrypoint script
COPY nginx/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# We only use these in testing.
COPY nginx/certs/snakeoil.cert.pem /etc/nginx/certs/snakeoil.cert.pem
COPY nginx/certs/snakeoil.key.pem  /etc/nginx/certs/snakeoil.key.pem

EXPOSE 80
EXPOSE 443

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
