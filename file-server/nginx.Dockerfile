FROM docker.io/nginx:1.21.5-alpine

# Mozilla's October 2026 eMudhra advisory includes the Sectigo cross-sign path.
RUN apk add --no-cache ca-certificates \
 && sed -i -e 's|^mozilla/emSign_ECC_Root_CA_-_G3.crt|!&|' \
           -e 's|^mozilla/Comodo_AAA_Services_root.crt|!&|' /etc/ca-certificates.conf \
 && update-ca-certificates

# njs ships in this nginx image. It formats the local 404 body without an
# upstream request; no application runtime or extra package is needed.
RUN sed -i '1i load_module /usr/lib/nginx/modules/ngx_http_js_module.so;' /etc/nginx/nginx.conf
COPY nginx/edge-errors.js /etc/nginx/edge-errors.js
COPY nginx/static-proxy.conf.template /etc/nginx/static-proxy.conf.template
COPY nginx/node-proxy.conf.template /etc/nginx/node-proxy.conf.template

# Copy config as template
COPY nginx/nginx-ssl.site.default.conf /etc/nginx/conf.d/default.conf.template

# Rust API route templates, rendered by the entrypoint only when
# RUST_API_ROUTES is set.
COPY nginx/rust-api/ /etc/nginx/rust-api-templates/
RUN mkdir -p /var/lib/polis-routing \
 && ln -s /var/lib/polis-routing/current /etc/nginx/rust-api
COPY nginx/render-rust-api.sh /usr/local/bin/render-rust-api
COPY nginx/rust-routes.sh /usr/local/bin/polis-rust-routes
RUN chmod +x /usr/local/bin/render-rust-api /usr/local/bin/polis-rust-routes

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
