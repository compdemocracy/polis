const request = require('request');
const config = require('../accessConfig');

function signIn(req, res) {
  if ('code' in req.query && !!req.query.code) {
    let code = req.query.code;
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
          res.send(body);
        } else {
          console.log('Join get token error: ' + response.statusCode);
          console.log(error);
        }
      });
  } else {
    console.log('Error: No code in join signin request.');
    res.send('Error: No code in join signin request.');
  }
}

module.exports = {
  signIn
};