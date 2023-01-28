# Polis Client Participation

This is the front-end code that participants see. The site needs to be served through the `file-server` and the `server` before it will render correctly as data payloads are injected into the HTML as it is served.

## Dependencies

* node `>= 16`
* npm `>= 8`

## Setup

```sh
npm install
cp polis.config.template.js polis.config.js
npm run build:prod
```

From here go to `file-server` and run `make` to copy the built files across.

You can run `npm run build:dev` to get an unminified version which makes for easier in-browser debugging.

## Troubleshooting

If you get an error that looks something like `Error: watch /home/csmall/code/polisClientParticipation/js ENOSPC` trying to run, this may be because your system has too many watches active. If you see this, try running `echo fs.inotify.max_user_watches=524288 | sudo tee -a /etc/sysctl.conf && sudo sysctl -p` to increase the number of available watches on your system.
