FROM nginx:1.14

WORKDIR /usr/share/nginx/html

COPY --from=polis-admin:latest ./dist/ ./
COPY --from=polis-participation:latest ./dist/ ./

COPY nginx.conf /etc/nginx/nginx.conf
COPY nginx.site.default.conf /etc/nginx/conf.d/default.conf
