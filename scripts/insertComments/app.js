/*
  node app.js <zinvite(the conversation id in URL)>
  comments.txt format for each comment:

  Name, empty line if anonymous
  Picture, empty line if not available
  Comment(Chinese)
  Comment(English)
  empty line
 */

const fs = require('fs');
const { Client } = require('pg');

console.log(process.argv);

async function main(err, data) {
  let lines = data.toString().split('\n');
	let step = 0;
	let comment = {};
	for (l in lines) {
	  let line = lines[l];
	  switch (step) {
  	  case 0:
	      comment.name = line;
	      break;
	    case 1:
	      comment.picture = line;
				if (line.length == 0) comment.picture == null;
	      break;
	    case 2:
	      comment.chineseComment = line;
	      break;
	    case 3:
	      comment.englishComment = line;
	      break;
	    case 4:
	      if (line.length > 0) {
	        console.log("Error! 5th line is not empty, format maybe incorrect.");
	      }
	      await insertToDB(comment);
	      step = -1;
	      comment = {};
	      break;
	  }
	  step++;
	};
}

async function insertToDB(comment) {
  const client = new Client();
  await client.connect();
	// Insert new user
  let res = await client.query('INSERT INTO users (hname, is_owner) VALUES ($1, $2) RETURNING uid;', [comment.name, 'f']);
  let uid = res.rows[0].uid;
	// Insert picture
	await client.query("INSERT INTO join_users (uid, nickname, picture) VALUES ($1, $2, $3)", [uid, comment.name, comment.picture]);
  // Get zid
	let zinvite = process.argv[2];
	if (zinvite.length === 0) {
		console.log('zinvite is not set!');
	}
	res = await client.query("SELECT zid FROM zinvites WHERE zinvite=$1", [zinvite]);
	let zid = res.rows[0].zid;
  // Get pid
  res = await client.query("INSERT INTO participants (zid, uid, created) VALUES ($1, $2, default) RETURNING pid;", [zid, uid]);
	let pid = res.rows[0].pid;
	// Insert Chinese comment
	res = await client.query("INSERT INTO comments (pid, zid, txt, velocity, active, mod, uid, tweet_id, quote_src_url, anon, is_seed, created, tid, lang, lang_confidence) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, default, null, $12, $13) ON CONFLICT DO NOTHING RETURNING tid;", [pid, zid, comment.chineseComment, 1, true, 0, uid, null, '', false, false, 'zh-tw', 1]);
	if (res.rowCount === 0) {
	  await client.end();
		return;
	}
  let tid = res.rows[0].tid;
  // Insert comment English translation
	await client.query("INSERT INTO comment_translations ( zid, tid, src, txt, lang) VALUES ($1, $2, -1, $3, $4) ON CONFLICT DO NOTHING;", [zid, tid, comment.englishComment, 'en']);
	await client.end();
	console.log(`Insert comment from ${comment.name} done.`);
}

fs.readFile('comments.txt', main);
