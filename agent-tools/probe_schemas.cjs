const { WebSocket } = require("ws");
const url = process.env.MCP_RELAY_URL;
const key = process.env.MCP_RELAY_KEY;
if (!url || !key) { console.error("MCP_RELAY_URL/KEY required"); process.exit(2); }
const want = new Set(["BuildProject","RunAllTests","RunSomeTests","RunProject","StopProject","GetConsoleOutput","XcodeListTestPlans","GetTestList"]);
const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${key}` } });
function send(o){ ws.send(JSON.stringify(o)); }
ws.on("open", () => { send({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2024-11-05",capabilities:{},clientInfo:{name:"hermes",version:"1.0"}}}); });
ws.on("message", (d) => {
  let j; try { j = JSON.parse(d.toString()); } catch(e){ return; }
  if (j.id === 1) {
    if (j.result) { send({jsonrpc:"2.0",method:"notifications/initialized"}); send({jsonrpc:"2.0",id:2,method:"tools/list",params:{}}); }
  } else if (j.id === 2) {
    const tools = (j.result && j.result.tools) || [];
    for (const t of tools) {
      if (want.has(t.name)) console.log(JSON.stringify({name:t.name, inputSchema:t.inputSchema}, null, 1));
    }
    ws.close(); setTimeout(()=>process.exit(0),300);
  }
});
ws.on("error",(e)=>{console.error("ERR "+e.message);process.exit(1);});
ws.on("close",(c)=>{ if(c!==1000) console.error("CLOSED "+c); });
setTimeout(()=>{console.error("GLOBAL TIMEOUT 120s");process.exit(3);},120000);
