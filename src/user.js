const pg = require('./db/pg-query');
const MPromise = require('./utils/metered').MPromise;
const Config = require('./polis-config');

function getUserInfoForUid(uid, callback) {
  pg.query_readOnly("SELECT email, hname from users where uid = $1", [uid], function(err, results) {
    if (err) {
      return callback(err);
    }
    if (!results.rows || !results.rows.length) {
      return callback(null);
    }
    callback(null, results.rows[0]);
  });
}

function getUserInfoForUid2(uid) {
  return new MPromise("getUserInfoForUid2", function(resolve, reject) {
    pg.query_readOnly("SELECT * from users where uid = $1", [uid], function(err, results) {
      if (err) {
        return reject(err);
      }
      if (!results.rows || !results.rows.length) {
        return reject(null);
      }
      let o = results.rows[0];
      resolve(o);
    });
  });
}

function addLtiUserIfNeeded(uid, lti_user_id, tool_consumer_instance_guid, lti_user_image) {
  lti_user_image = lti_user_image || null;
  return pg.queryP("select * from lti_users where lti_user_id = ($1) and tool_consumer_instance_guid = ($2);", [lti_user_id, tool_consumer_instance_guid]).then(function(rows) {
    if (!rows || !rows.length) {
      return pg.queryP("insert into lti_users (uid, lti_user_id, tool_consumer_instance_guid, lti_user_image) values ($1, $2, $3, $4);", [uid, lti_user_id, tool_consumer_instance_guid, lti_user_image]);
    }
  });
}

function addLtiContextMembership(uid, lti_context_id, tool_consumer_instance_guid) {
  return pg.queryP("select * from lti_context_memberships where uid = $1 and lti_context_id = $2 and tool_consumer_instance_guid = $3;", [uid, lti_context_id, tool_consumer_instance_guid]).then(function(rows) {
    if (!rows || !rows.length) {
      return pg.queryP("insert into lti_context_memberships (uid, lti_context_id, tool_consumer_instance_guid) values ($1, $2, $3);", [uid, lti_context_id, tool_consumer_instance_guid]);
    }
  });
}

function renderLtiLinkageSuccessPage(req, res, o) {
  res.set({
    'Content-Type': 'text/html',
  });
  let html = "" +
    "<!DOCTYPE html><html lang='en'>" +
    '<head>' +
    '<meta name="viewport" content="width=device-width, initial-scale=1;">' +
    '</head>' +
    "<body style='max-width:320px'>" +
    "<p>You are signed in as polis user " + o.email + "</p>" +
    // "<p><a href='https://pol.is/user/logout'>Change pol.is users</a></p>" +
    // "<p><a href='https://preprod.pol.is/inbox/context="+ o.context_id +"'>inbox</a></p>" +
    // "<p><a href='https://preprod.pol.is/2demo' target='_blank'>2demo</a></p>" +
    // "<p><a href='https://preprod.pol.is/conversation/create/context="+ o.context_id +"'>create</a></p>" +

    // form for sign out
    '<p><form role="form" class="FormVertical" action="' + Config.get('SERVICE_URL') + '/api/v3/auth/deregister" method="POST">' +
    '<input type="hidden" name="showPage" value="canvas_assignment_deregister">' +
    '<button type="submit" class="Btn Btn-primary">Change pol.is users</button>' +
    '</form></p>' +

    // "<p style='background-color: yellow;'>" +
    //     JSON.stringify(req.body)+
    //     (o.user_image ? "<img src='"+o.user_image+"'></img>" : "") +
    // "</p>"+
    "</body></html>";
  res.status(200).send(html);
}

module.exports = {
  getUserInfoForUid,
  getUserInfoForUid2,
  addLtiUserIfNeeded,
  addLtiContextMembership,
  renderLtiLinkageSuccessPage
};