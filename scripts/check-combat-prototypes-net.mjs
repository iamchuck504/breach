import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import WebSocket from 'ws';
const wait=ms=>new Promise(r=>setTimeout(r,ms)),port=8857;
const server=spawn(process.execPath,['server/server.js'],{env:{...process.env,PORT:String(port),INTRO_TIME:'0',COUNTDOWN_TIME:'0',NODE_ENV:'test',ALLOW_TEST_TELEPORTS:'1',BREACH_EXPERIMENTAL_STUN:'1'},stdio:['ignore','pipe','pipe']});
let log='';server.stdout.on('data',d=>log+=d);server.stderr.on('data',d=>log+=d);
class Peer{
 async open(name){this.history=[];this.ws=new WebSocket(`ws://127.0.0.1:${port}`);this.ws.on('message',s=>this.history.push(JSON.parse(s)));await new Promise((r,j)=>{this.ws.once('open',r);this.ws.once('error',j);});this.send({t:'join',action:name==='PROTO-A'?'create':'join',name,v:0});this.id=(await this.next(m=>m.t==='welcome')).id;}
 send(m){this.ws.send(JSON.stringify(m));}
 async next(pred,ms=4000){for(let i=0;i<ms/20;i++){const m=this.history.find(pred);if(m)return m;await wait(20);}throw Error(`timeout ${this.history.map(m=>m.t).slice(-15)}\n${log}`);}
 clear(){this.history=[];}
 state(x,z,w='smg'){this.send({t:'s',x,z,y:0,yaw:0,st:'idle',aim:0,p:0,w,am:4,ar:0,sp:0});}
}
let a,b;
try{
 for(let i=0;i<60&&!log.includes('BREACH server');i++)await wait(50);
 a=new Peer();b=new Peer();await a.open('PROTO-A');await b.open('PROTO-B');
 a.send({t:'lobbyStart'});await a.next(m=>m.t==='start');
 const snap=await a.next(m=>m.t==='protoState'&&m.active),frag=snap.pickups.find(p=>p.kind==='frag'),stun=snap.pickups.find(p=>p.kind==='stun');
 assert.ok(frag&&stun);
 a.state(frag.x,frag.z);b.state(frag.x,frag.z);await wait(100);a.clear();b.clear();
 a.send({t:'protoClaim',id:frag.id,manual:false});await wait(100);assert.ok(!a.history.some(m=>m.t==='protoInventory'));
 a.send({t:'protoClaim',id:frag.id,manual:true});b.send({t:'protoClaim',id:frag.id,manual:true});
 const claim=await a.next(m=>m.t==='protoInventory'&&m.kind==='frag');assert.equal(claim.count,2);
 await wait(100);assert.equal(a.history.filter(m=>m.t==='protoInventory'&&m.kind==='frag').length,1);
 const grenadier=claim.id===a.id?a:b;
 grenadier.state(frag.x,frag.z,'frag');await wait(100);
 grenadier.send({t:'protoFire',kind:'frag',o:[frag.x,1,frag.z],d:[0,0,1]});
 const boom=await a.next(m=>m.t==='protoEvent'&&m.kind==='explosion');
 const remoteBoom=await b.next(m=>m.t==='protoEvent'&&m.kind==='explosion');assert.deepEqual(boom.p,remoteBoom.p);
 assert.ok(a.history.some(m=>m.t==='protoInventory'&&m.id===claim.id&&m.kind==='frag'&&m.count===1));
 a.state(stun.x,stun.z);await wait(100);a.send({t:'protoClaim',id:stun.id,manual:true});await a.next(m=>m.t==='protoInventory'&&m.kind==='stun'&&m.id===a.id);
 await wait(5100);
 a.state(3,-4,'stun');b.state(3,4);await wait(100);a.clear();b.clear();
 a.send({t:'protoFire',kind:'stun',o:[3,1.1,-4],d:[0,0,1]});
 await a.next(m=>m.t==='protoEvent'&&m.kind==='stun'&&m.target===b.id);
 await b.next(m=>m.t==='protoEvent'&&m.kind==='stun'&&m.target===b.id);
 b.state(10,10,'pistol');b.send({t:'fire',w:'pistol',o:[3,1.1,4],p:[3,1.1,-4],d:[]});
 const correction=await b.next(m=>m.t==='correction'&&m.reason==='stun');assert.equal(correction.x,3);assert.equal(correction.z,4);
 await wait(1550);a.clear();a.send({t:'protoFire',kind:'stun',o:[3,1.1,-4],d:[0,0,1]});await wait(500);
 assert.equal(a.history.filter(m=>m.t==='protoEvent'&&m.kind==='stun').length,0,'stun refreshed');
 a.clear();const active=await a.next(m=>m.t==='protoState'&&m.states.some(s=>s.id===b.id&&s.remaining>0));
 assert.ok(active.states.find(s=>s.id===b.id).remaining<1.6);
 await wait(1100);a.clear();const ended=await a.next(m=>m.t==='protoState');assert.equal(ended.states.find(s=>s.id===b.id)?.remaining,0);assert.ok(ended.states.find(s=>s.id===b.id)?.immune>0);
 a.send({t:'protoFire',kind:'stun',o:[3,1.1,-4],d:[0,0,1]});await wait(500);assert.ok(!a.history.some(m=>m.t==='protoEvent'&&m.kind==='stun'));
 await wait(2200);a.state(0,-4,'stun');b.state(0,4);await wait(100);a.clear();
 a.send({t:'protoFire',kind:'stun',o:[0,1.1,-4],d:[0,0,1]});await wait(600);
 assert.ok(!a.history.some(m=>m.t==='protoEvent'&&m.kind==='stun'),'electric projectile crossed pillar');
 console.log('Prototype multiplayer OK: competing/manual claims, grenade flight/fuse, authoritative stun, wall blocking, freeze, no refresh, immunity, both peers');
}finally{a?.ws?.close();b?.ws?.close();server.kill();}
