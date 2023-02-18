

function deleteFacebookUserRecord(o: { uid?: any }) {
  if (!isPolisDev(o.uid)) {
    // limit to test accounts for now
    return Promise.reject("polis_err_not_implemented");
  }
  return pgQueryP("delete from facebook_users where uid = ($1);", [o.uid]);
}

function createFacebookUserRecord(
  o: { uid?: any } & {
    // uid provided later
    fb_user_id: any;
    fb_public_profile: any;
    fb_login_status: any;
    fb_access_token: any;
    fb_granted_scopes: any;
    fb_friends_response: any;
    response: any;
  }
) {
  winston.log("info", "createFacebookUserRecord");
  winston.log("info", "createFacebookUserRecord", JSON.stringify(o));
  winston.log("info", o);
  winston.log("info", "end createFacebookUserRecord");
  const profileInfo = o.fb_public_profile;
  winston.log("info", "createFacebookUserRecord profileInfo");
  winston.log("info", profileInfo);
  winston.log("info", "end createFacebookUserRecord profileInfo");
  // Create facebook user record
  return pgQueryP(
    "insert into facebook_users (uid, fb_user_id, fb_name, fb_link, fb_public_profile, fb_login_status, fb_access_token, fb_granted_scopes, fb_location_id, location, fb_friends_response, response) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12);",
    [
      o.uid,
      o.fb_user_id,
      profileInfo.name,
      profileInfo.link,
      JSON.stringify(o.fb_public_profile),
      o.fb_login_status,
      o.fb_access_token,
      o.fb_granted_scopes,
      profileInfo.locationInfo && profileInfo.locationInfo.id,
      profileInfo.locationInfo && profileInfo.locationInfo.name,
      o.fb_friends_response || "",
      o.response,
    ]
  );
}

function updateFacebookUserRecord(
  o: { uid?: any } & {
    // uid provided later
    fb_user_id: any;
    fb_public_profile: any;
    fb_login_status: any;
    fb_access_token: any;
    fb_granted_scopes: any;
    fb_friends_response: any;
    response: any;
  }
) {
  const profileInfo = o.fb_public_profile;
  const fb_public_profile_string = JSON.stringify(o.fb_public_profile);
  // Create facebook user record
  return pgQueryP(
    "update facebook_users set modified=now_as_millis(), fb_user_id=($2), fb_name=($3), fb_link=($4), fb_public_profile=($5), fb_login_status=($6), fb_access_token=($7), fb_granted_scopes=($8), fb_location_id=($9), location=($10), fb_friends_response=($11), response=($12) where uid = ($1);",
    [
      o.uid,
      o.fb_user_id,
      profileInfo.name,
      profileInfo.link,
      fb_public_profile_string,
      o.fb_login_status,
      o.fb_access_token,
      o.fb_granted_scopes,
      profileInfo.locationInfo && profileInfo.locationInfo.id,
      profileInfo.locationInfo && profileInfo.locationInfo.name,
      o.fb_friends_response || "",
      o.response,
    ]
  );
}

function addFacebookFriends(uid?: any, fb_friends_response?: any[]) {
  const fbFriendIds = (fb_friends_response || [])
    .map(function (friend: { id: string }) {
      return friend.id + "";
    })
    .filter(function (id: string) {
      // NOTE: would just store facebook IDs as numbers, but they're too big for JS numbers.
      const hasNonNumericalCharacters = /[^0-9]/.test(id);
      if (hasNonNumericalCharacters) {
        emailBadProblemTime(
          "found facebook ID with non-numerical characters " + id
        );
      }
      return !hasNonNumericalCharacters;
    })
    .map(function (id: string) {
      return "'" + id + "'"; // wrap in quotes to force pg to treat them as strings
    });
  if (!fbFriendIds.length) {
    return Promise.resolve();
  } else {
    // add friends to the table
    // TODO periodically remove duplicates from the table, and pray for postgres upsert to arrive soon.
    return pgQueryP(
      "insert into facebook_friends (uid, friend) select ($1), uid from facebook_users where fb_user_id in (" +
        fbFriendIds.join(",") +
        ");",
      [uid]
    );
  }
}