FROM nginx:1.19.1-alpine

COPY file-server/nginx.site.default.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
