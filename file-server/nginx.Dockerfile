FROM nginx:1.19.1-alpine

COPY nginx/nginx.site.default.conf /etc/nginx/conf.d/default.conf

# We only use these in testing.
COPY nginx/certs/snakeoil.crt      /etc/nginx/certs/snakeoil.crt
COPY nginx/certs/snakeoil.key      /etc/nginx/certs/snakeoil.key

EXPOSE 80
