# after login

cd polis
sudo docker-compose ps # current docker status
sudo docker-compose up --build -d # rebuild what is necessary, start apps and detach
sudo docker-compose down # stop apps

# docker-compose reads docker-compose.yml file from current directory

# for testing:
cd e2e
npm run e2e:headless


sudo reboot # reboot whole GCP server

