'use strict';
// Only the unchanged Node application listens; Rust calls its handler below HTTP.
const fs=require('node:fs');
const {app,appReady,db,seed,keys,CID,Z,U,issueParticipantJWT}=require('./record.cjs');
(async()=>{
 await appReady;await seed();
 const server=app.listen(59045,'127.0.0.1');
 await new Promise(r=>server.once('listening',r));
 fs.writeFileSync(process.argv[2],JSON.stringify({public_key:keys.publicKey,token:issueParticipantJWT('anonymous',CID,U+1,1)}),{mode:0o600});
 process.on('SIGTERM',async()=>{await new Promise(r=>server.close(r));await db.end();process.exit(0);});
 console.log('Node companion ready');
})().catch(e=>{console.error(e);process.exit(1)});
