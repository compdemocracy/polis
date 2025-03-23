
# SSL

**Important:** The Docker Compose infrastructure described in the main README uses an insecure, self-signed SSL certificate, which is pre-generated and stored publicly in the source code.
This HTTPS implementation is thus **ONLY suitable for testing.**
Frequently, SSL support is something provided at the hosting layer, and we encourage you to pursue this option when possible.

Nevertheless, we would like to find a way to streamline this part of the process as much as possible.
There's been [some progress](https://github.com/compdemocracy/polis/issues/289) to that end, and we encourage you to help push it forward if you're able!

## Details

For testing some functionality, some external services must interact with the Polis app via HTTPS.

To modify these settings, edit `file-server/nginx/nginx-ssl.site.default.conf` before building the `nginx-proxy` docker container:

```
edit file-server/nginx/nginx-ssl.site.default.conf
docker compose up --detach --build --no-deps nginx-proxy
```

