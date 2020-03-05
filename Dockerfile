FROM node:10.9.0

WORKDIR /app

COPY *.json ./

RUN npm install

COPY . .

EXPOSE ${port}

#CMD npm run docker

CMD ["node", "--max_old_space_size=400", "--gc_interval=100", "--harmony", "app.js" ]


