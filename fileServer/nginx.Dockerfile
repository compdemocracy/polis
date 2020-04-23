FROM nginx:1.14

WORKDIR /usr/share/nginx/html

COPY --from=polis-admin:latest /app/dist/ ./
COPY --from=polis-participation:latest /app/dist/ ./

COPY nginx.conf /etc/nginx/nginx.conf
COPY nginx.site.default.conf /etc/nginx/conf.d/default.conf
