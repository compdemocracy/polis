# polis.engaged.ca.gov
Fork of pol.is for the Engaged Califiornia project. 


## Local set up

Instructions have only been tested on a Mac.

1. Make sure Docker is running
2. Go to Mac Settings. Search for  “Airplay receiver” is off
3. Make sure VPN (i.e. Jamf Trust) is off
4. (ODI staff) Make sure Privileges app is enabled
5. Run **First-time terminal commands**
6. Go to http://localhost:80/home
7. Click Sign in
8. Enter username/password admin@polis.test Te$tP@ssw0rd*


### First-time terminal commands

(1) Clone repo.
```bash
open -a terminal
gh repo clone cagov/polis.engaged.ca.gov
cd polis.engaged.ca.gov
open -a [yourIDE] .
```

(2) Copy .env file.

```bash
cp example.env .env
```

(3) Check if mkcert is installed
```bash
which mkcert
```
(4) If mkcert is not installed, install it
```bash
brew install mkcert
mkcert -install
# Important: After running mkcert -install, completely restart your browser to trust the certificates.
```
(5) Install self-signed certificates
```bash
mkdir -p ~/.simulacrum/certs
```
(6) Check for certificate
```bash
ls ~/.simulacrum/certs
# if localhost-key.pem localhost.pem and rootCA.pem are missing
```
(7) If no, certs, create self-signed certificates.

```bash
mkdir -p ~/.simulacrum/certs
cd ~/.simulacrum/certs
mkcert -cert-file localhost.pem -key-file localhost-key.pem localhost 127.0.0.1 ::1 oidc-simulator host.docker.internal
cp "$(mkcert -CAROOT)/rootCA.pem" ~/.simulacrum/certs/
```
(8) Generate JWT keys for participant authentication
```bash
make generate-jwt-keys
```
(9) Rebuild container completely
```bash
make start-FULL-REBUILD
```
