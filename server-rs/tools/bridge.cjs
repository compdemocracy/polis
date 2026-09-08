'use strict';
// Docker's sealed internal network does not publish ports on this host. A local
// stdio bridge enters ONLY our own driver container; it adds no network/egress.
const net=require('node:net'),cp=require('node:child_process');
const [project,pg,http,control,dynamo]=process.argv.slice(2);
if(!/^rpca2x-[a-z0-9]+$/.test(project))throw Error('isolated project required');
const ports=[pg,http,control,dynamo].map(Number);
if(new Set(ports).size!==4||ports.some(p=>p<55720||p>55739))throw Error('isolated ports required');
const container=project+'-driver-1';
const label=cp.execFileSync('docker',['inspect',container,'--format','{{index .Config.Labels "com.docker.compose.project"}}'],{encoding:'utf8'}).trim();
if(label!==project)throw Error('container owner mismatch');
const children=new Set(),servers=[];
for(const [port,host,target] of [[pg,'postgres',5432],[http,'server',5000],[control,'server',5001],[dynamo,'dynamodb',8000]]){
 const server=net.createServer(socket=>{
  const script="const net=require('node:net');const s=net.connect(Number(process.argv[2]),process.argv[1]);process.stdin.pipe(s);s.pipe(process.stdout);s.on('error',()=>process.exit(1));s.on('close',()=>process.exit());";
  const child=cp.spawn('docker',['exec','-i',container,'node','-e',script,host,String(target)],{stdio:['pipe','pipe','ignore']});children.add(child);
  socket.pipe(child.stdin);child.stdout.pipe(socket);child.stdin.on('error',()=>socket.destroy());
  child.on('exit',()=>{children.delete(child);socket.destroy();});socket.on('error',()=>{});socket.on('close',()=>child.kill());
 });server.listen(Number(port),'127.0.0.1');servers.push(server);
}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{for(const child of children)child.kill();for(const server of servers)server.close();process.exit();});
