const request = require('request');
const config = require('./accessConfig');

function signIn(req, res) {
  if ('code' in req.params && !!req.params.code) {
    return function (req, res) {
      let code = req.params.code;
      let url = config.get('JOIN_SERVER');
      let apiKey = config.get('JOIN_API_KEY');
      if (!url) {
        console.log('Error: JOIN_SERVER is not set.');
        return null;
      }
      if (!apiKey) {
        console.log('Error: JOIN_API_KEY is not set.');
        return null;
      }
      request({
          url: `${url}/portal/api/user/token?code=${code}`,
          headers: {
            'x-api-key': apiKey
          }
        },
        (error, response, body) => {
          if (!error && response.statusCode === 200) {
            console.log(body);
            let data = JSON.parse(body);
            console.log('token:' + data.accessToken);
          } else {
            console.log('Join get token error: ' + response.statusCode);
            console.log(error);
          }
        });
    };
  } else {
    return null;
  }
}

module.exports = {
  signIn
};