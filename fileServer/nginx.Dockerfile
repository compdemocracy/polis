FROM nginx:1.14

COPY nginx.site.default.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
