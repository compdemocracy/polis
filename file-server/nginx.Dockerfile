FROM nginx:1.19.2-alpine

COPY nginx.site.default.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
