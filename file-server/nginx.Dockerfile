FROM nginx:1.19.2-alpine

COPY nginx/nginx-https.site.default.conf /etc/nginx/conf.d/default.conf

# We only use these in testing.
COPY nginx/certs/snakeoil.cert.pem /etc/nginx/certs/snakeoil.cert.pem
COPY nginx/certs/snakeoil.key.pem  /etc/nginx/certs/snakeoil.key.pem

EXPOSE 80
