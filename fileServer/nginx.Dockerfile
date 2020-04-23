FROM nginx:1.14

COPY nginx.conf /etc/nginx/nginx.conf
COPY nginx.site.default.conf /etc/nginx/conf.d/default.conf
