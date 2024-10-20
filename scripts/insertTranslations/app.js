/*
  node app.js <zinvite(the conversation id in URL)> [start_tid]
  comments.txt format for each comment:

  Name, empty line if anonymous
  Picture, empty line if not available
  Comment(Chinese)
  Comment(English)
  empty line
 */

const fs = require('fs');
const { Client } = require('pg');

async function main(err, data) {
  let lines = data.toString().split('\n');
	let tid = 0;
	if (process.argv[3]) tid = parseInt(process.argv[3]);
	let lang = 'en';
  if (process.argv[4]) lang = process.argv[4];
	let comment = {};
	for (l in lines) {
	  let line = lines[l].trim();
		if (line.length == 0) continue;
	  insertToDB(tid, line, lang);
		tid++;
	};
}

async function insertToDB(tid, translate, lang) {
  const client = new Client();
  await client.connect();
	// Get zid
	let zinvite = process.argv[2];
	if (zinvite.length === 0) {
		console.log('zinvite is not set!');
	}
	res = await client.query("SELECT zid FROM zinvites WHERE zinvite=$1", [zinvite]);
	let zid = res.rows[0].zid;
  // Insert translation
	await client.query("INSERT INTO comment_translations ( zid, tid, src, txt, lang) VALUES ($1, $2, -1, $3, $4) ON CONFLICT DO NOTHING;", [zid, tid, translate, lang]);
	await client.end();
	console.log(`Insert ${lang} translation ${translate} into tid ${tid} done.`);
}

fs.readFile('comments.txt', main);
