FROM alpine

WORKDIR /app

# Copy to temporary location in container at buildtime.
COPY ./shared /config

# Clean and copy over to shared named volume at runtime.
CMD rm -r /app/config/* && cp -r /config/* /app/config
