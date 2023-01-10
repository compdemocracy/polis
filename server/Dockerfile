FROM docker.io/node:19.4.0-bullseye

WORKDIR /app

RUN apt-get update && apt-get install postgresql-14 python3-dev build-essential g++ git make python3
# don't know if there's equivalent of this for debian, but worth considering; I think the idea here was that
# these are only used for building, so can be dropped once the app is ready to run
#RUN apk add --no-cache --virtual .build \
  #g++ git make python3

COPY package*.json ./

# TODO get `npm ci` to work
RUN npm install

# again, consider switching back to this
#RUN apk del .build

# TODO This shouldn't be necessary; fix
#RUN chown -R 1000:1000 /root/.npm

# TODO This shouldn't be necessary; fix
#RUN chown -R 1000:1000 /root/.npm

COPY . .

RUN npm run build

EXPOSE 5000

CMD npm run serve