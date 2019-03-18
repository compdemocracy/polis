const request = require('request');
const config = require('../accessConfig');

function signIn(req, res) {
  let url = config.get('JOIN_SERVER');
  let apiKey = config.get('JOIN_API_KEY');
  requireToken(req, res, url, apiKey)
    .then(token => {
      return getUserInfo(req, res, url, apiKey, token)
    })
    .then(user => {
      // TODO: Extract signin or create user from from server.js and call them
      res.send(user);
      // createJoinUser(req, res, user);
    })
    .catch(error => res.send(error));
}

function requireToken(req, res, url, apiKey) {
  return new Promise((resolve, reject) => {
    if ('code' in req.query && !!req.query.code) {
      let code = req.query.code;
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
            let data = JSON.parse(body);
            let token = data.result.accessToken;
            resolve(token);
          } else {
            console.log('Join get token error: ' + response.statusCode);
            console.log(error);
            reject(error);
          }
        });
    } else {
      console.log('Error: No code in join signin request.');
      reject('No code in request.');
    }
  });
}

function getUserInfo(req, res, url, apiKey, token) {
  return new Promise((resolve, reject) => {
    request({
        url: `${url}/portal/api/user/info`,
        headers: {
          'x-api-key': apiKey,
          'Authorization': `Bearer ${token}`
        }
      },
      (error, response, body) => {
        if (!error && response.statusCode === 200) {
          let data = JSON.parse(body);
          let user = {
            uid: data.result.userUid,
            nickname: data.result.name,
            isValid: data.result.isValid,
            picture: data.result.picture,
            email: data.result.email
          };
          resolve(user);
        } else {
          console.log('Get user info error: ' + response.statusCode);
          console.log(error);
          reject(`Error ${response.statusCode}\n${token}`);
        }
      }
    );
  });
}

module.exports = {
  signIn
};