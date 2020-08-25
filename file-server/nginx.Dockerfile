FROM nginx:1.19.2-alpine

COPY file-server/nginx/nginx-ssl.site.default.conf /etc/nginx/conf.d/default.conf

# We only use these in testing.
COPY file-server/nginx/certs/snakeoil.cert.pem /etc/nginx/certs/snakeoil.cert.pem
COPY file-server/nginx/certs/snakeoil.key.pem  /etc/nginx/certs/snakeoil.key.pem

EXPOSE 80
EXPOSE 443
