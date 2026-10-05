import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));
test('CLI forwards HTTP and reconnects, then exits when its tunnel is replaced', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'endport-cli-'));
  let child;
  const origin = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ path: req.url })); });
  const gateway = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    res.setHeader('content-type','application/json');
    if (req.url === '/api/cli/init') res.end(JSON.stringify({ credential:'private-owner-token', endpoint:{id:'endpoint-test',slug:payload.name} }));
    else {
      assert.equal(req.headers.authorization, 'Bearer private-owner-token');
      if (req.url === '/api/cli/connect') res.end(JSON.stringify({ endpoint:{id:'endpoint-test'},publicUrl:'https://test.endport.io',logsUrl:'https://workspace.endport.io' }));
      else res.end(JSON.stringify({ code:'TEST123456',logsUrl:'https://workspace.endport.io' }));
    }
  });
  const wss = new WebSocketServer({server:gateway});
  try {
    origin.listen(0,'127.0.0.1'); gateway.listen(0,'127.0.0.1');
    await Promise.all([once(origin,'listening'),once(gateway,'listening')]);
    let connections = 0;
    const completed = new Promise((resolve,reject) => {
      wss.on('connection', (ws, req) => {
        try { assert.equal(req.headers.authorization,'Bearer private-owner-token'); } catch (error) { reject(error); }
        connections++;
        ws.send(JSON.stringify({type:'ready',id:'endpoint-test'}));
        if (connections === 1) {
          let data = '';
          ws.on('message', raw => {
            const message = JSON.parse(raw);
            if (message.type === 'response-chunk') data += Buffer.from(message.data,'base64').toString();
            if (message.type === 'response-end') {
              try { assert.deepEqual(JSON.parse(data),{path:'/hello?test=1'}); assert.ok(message.originMs >= 0); ws.close(1012); } catch (error) { reject(error); }
            }
          });
          ws.send(JSON.stringify({type:'request',id:'request-1',method:'GET',path:'/hello?test=1',headers:{},body:''}));
        } else { ws.close(4001,'Replaced'); resolve(); }
      });
    });
    child = spawn(process.execPath,[cli,String(origin.address().port),'--name','test-app','--server',`http://127.0.0.1:${gateway.address().port}`],{cwd:directory,env:{...process.env,ENDPORT_NO_BROWSER:'1',ENDPORT_CONFIG_FILE:path.join(directory,'private','config.json')},stdio:['ignore','pipe','pipe']});
    let stderr = ''; child.stderr.on('data', data => stderr += data);
    const exited = once(child,'exit');
    await completed;
    const [code] = await exited;
    assert.equal(code,1); assert.match(stderr,/replaced/); assert.equal(connections,2);
  } finally {
    child?.kill('SIGTERM');
    for (const ws of wss.clients) ws.terminate();
    wss.close(); origin.close(); gateway.close();
    await rm(directory,{recursive:true,force:true});
  }
});
