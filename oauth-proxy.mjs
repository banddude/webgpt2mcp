import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { URL, URLSearchParams } from 'node:url';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 17843);
const BASE = (process.env.PUBLIC_BASE || 'https://chatgpt-mcp.officeadmin.io').replace(/\/$/, '');
const RESOURCE = `${BASE}/mcp`;
const UPSTREAM = process.env.UPSTREAM || 'http://127.0.0.1:17842/mcp';
const STORE_FILE = process.env.OAUTH_STORE || new URL('./oauth-store.json', import.meta.url).pathname;
const ADMIN_FILE = process.env.ADMIN_TOKEN_FILE || new URL('./oauth-admin-token', import.meta.url).pathname;
const adminToken = fs.readFileSync(ADMIN_FILE, 'utf8').trim();
const allowedRedirectHosts = new Set(['claude.ai','claude.com','chatgpt.com','chat.openai.com','platform.openai.com','openai.com']);

let store = {client:{},pending:{},code:{},token:{},refresh:{}};
try { store = {...store, ...JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'))}; } catch {}
function save(){ const tmp=STORE_FILE+'.tmp'; fs.writeFileSync(tmp, JSON.stringify(store), {mode:0o600}); fs.renameSync(tmp, STORE_FILE); }
function now(){ return Math.floor(Date.now()/1000); }
function rand(n=32){ return crypto.randomBytes(n).toString('base64url'); }
function put(kind,id,data,ttl=null){ store[kind] ||= {}; store[kind][id]={data, expires_at:ttl?now()+ttl:null}; save(); }
function get(kind,id){ const r=store[kind]?.[id]; if(!r)return null; if(r.expires_at && r.expires_at < now()){ delete store[kind][id]; save(); return null; } return r.data; }
function del(kind,id){ if(store[kind]?.[id]){ delete store[kind][id]; save(); } }
function json(res,status,obj,headers={}){ const b=Buffer.from(JSON.stringify(obj)); res.writeHead(status, {'content-type':'application/json','content-length':b.length,...headers}); res.end(b); }
function html(res,status,text,headers={}){ const b=Buffer.from(text); res.writeHead(status, {'content-type':'text/html; charset=utf-8','content-length':b.length,...headers}); res.end(b); }
async function body(req){ const chunks=[]; for await (const c of req) chunks.push(c); return Buffer.concat(chunks); }
function form(buf){ return Object.fromEntries(new URLSearchParams(buf.toString())); }
function redirectAllowed(uri){ try { const u=new URL(uri); return (u.protocol==='https:' && allowedRedirectHosts.has(u.hostname.toLowerCase())) || (u.protocol==='http:' && ['127.0.0.1','localhost','::1'].includes(u.hostname)); } catch { return false; } }
function esc(s){ return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function metadata(){ return {issuer:BASE,authorization_endpoint:`${BASE}/oauth/authorize`,token_endpoint:`${BASE}/oauth/token`,registration_endpoint:`${BASE}/oauth/register`,response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],token_endpoint_auth_methods_supported:['none'],code_challenge_methods_supported:['S256'],scopes_supported:['chatgpt']}; }
function protectedResource(){ return {resource:RESOURCE,authorization_servers:[BASE],scopes_supported:['chatgpt'],bearer_methods_supported:['header']}; }
function pkce(v){ return crypto.createHash('sha256').update(v,'ascii').digest('base64url'); }
function tokenResponse(client_id, refresh_token=null, scope='chatgpt'){ const access=rand(48), refresh=refresh_token||rand(48); put('token',access,{client_id,scope,resource:RESOURCE}); put('refresh',refresh,{client_id,scope,resource:RESOURCE}); return {access_token:access,token_type:'Bearer',refresh_token:refresh,scope}; }

async function proxy(req,res){
  const auth=(req.headers.authorization||'').match(/^Bearer\s+(.+)$/i);
  if(!auth || !get('token',auth[1])) return json(res,401,{error:'unauthorized'},{'www-authenticate':`Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource"`});
  const data = ['GET','HEAD'].includes(req.method) ? undefined : await body(req);
  const headers={...req.headers}; delete headers.host; delete headers['content-length']; delete headers.connection; delete headers.authorization;
  let upstream;
  try { upstream=await fetch(UPSTREAM,{method:req.method,headers,body:data?.length?data:undefined,duplex:data?.length?'half':undefined,signal:AbortSignal.timeout(180000)}); }
  catch(e){ return json(res,502,{error:'upstream_unavailable',message:String(e.message||e)}); }
  const out={}; for(const [k,v] of upstream.headers){ if(!['connection','keep-alive','transfer-encoding','content-length'].includes(k.toLowerCase())) out[k]=v; }
  res.writeHead(upstream.status,out);
  if(upstream.body) Readable.fromWeb(upstream.body).pipe(res); else res.end();
}

const server=http.createServer(async(req,res)=>{
  try {
    const u=new URL(req.url,BASE), p=u.pathname;
    if(p==='/healthz') return json(res,200,{ok:true,server:'chatgpt-mcp-oauth-proxy',upstream:UPSTREAM});
    if((p==='/.well-known/oauth-protected-resource'||p==='/.well-known/oauth-protected-resource/mcp') && req.method==='GET') return json(res,200,protectedResource(),{'cache-control':'public, max-age=300'});
    if(p==='/.well-known/oauth-authorization-server' && req.method==='GET') return json(res,200,metadata(),{'cache-control':'public, max-age=300'});
    if(p==='/oauth/register' && req.method==='POST'){
      let b; try { b=JSON.parse((await body(req)).toString()); } catch { return json(res,400,{error:'invalid_client_metadata'}); }
      const redirects=b.redirect_uris||[]; if(!Array.isArray(redirects)||!redirects.length||!redirects.every(x=>typeof x==='string'&&redirectAllowed(x))) return json(res,400,{error:'invalid_redirect_uri'});
      const client_id=rand(32); const rec={client_id,client_name:String(b.client_name||'MCP client').slice(0,200),redirect_uris:redirects,grant_types:b.grant_types||['authorization_code','refresh_token'],response_types:b.response_types||['code'],token_endpoint_auth_method:'none'}; put('client',client_id,rec); return json(res,201,{...b,...rec,client_id_issued_at:now()});
    }
    if(p==='/oauth/authorize' && req.method==='GET'){
      const q=Object.fromEntries(u.searchParams); if(q.response_type!=='code')return json(res,400,{error:'unsupported_response_type'}); const c=get('client',q.client_id||''); if(!c)return json(res,400,{error:'unauthorized_client'}); if(!c.redirect_uris.includes(q.redirect_uri)||!redirectAllowed(q.redirect_uri))return json(res,400,{error:'invalid_request'}); if(!q.code_challenge||(q.code_challenge_method||'S256')!=='S256')return json(res,400,{error:'invalid_request'});
      const request_id=rand(32), scope=(!q.scope||q.scope==='*')?'chatgpt':q.scope; put('pending',request_id,{client_id:q.client_id,redirect_uri:q.redirect_uri,state:q.state,code_challenge:q.code_challenge,scope},600);
      return html(res,200,`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>Authorize ChatGPT MCP</title><body style="font-family:-apple-system,sans-serif;max-width:560px;margin:48px auto;padding:0 20px"><h2>Authorize ChatGPT MCP</h2><p><strong>${esc(c.client_name)}</strong> is requesting access to Mike's Oracle-hosted ChatGPT conversation tools.</p><form method=post><input type=hidden name=request_id value="${esc(request_id)}"><input type=password name=approval_token autocomplete=off style="width:100%;padding:10px" required><button type=submit style="margin-top:12px;padding:10px 16px">Authorize</button></form></body>`);
    }
    if(p==='/oauth/authorize' && req.method==='POST'){
      const f=form(await body(req)), pending=get('pending',f.request_id||''); if(!pending)return json(res,400,{error:'invalid_request'}); const a=Buffer.from(f.approval_token||''), b=Buffer.from(adminToken); if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return html(res,403,'Authorization denied.'); del('pending',f.request_id); const code=rand(48); put('code',code,pending,300); const r=new URL(pending.redirect_uri); r.searchParams.set('code',code); r.searchParams.set('iss',BASE); if(pending.state)r.searchParams.set('state',pending.state); res.writeHead(302,{location:r.toString()}); return res.end();
    }
    if(p==='/oauth/token' && req.method==='POST'){
      const f=form(await body(req)), client_id=f.client_id||''; if(!client_id||!get('client',client_id))return json(res,401,{error:'invalid_client'});
      if(f.grant_type==='authorization_code'){ const d=get('code',f.code||''); if(!d||d.client_id!==client_id||f.redirect_uri!==d.redirect_uri||!f.code_verifier||pkce(f.code_verifier)!==d.code_challenge)return json(res,400,{error:'invalid_grant'}); del('code',f.code); return json(res,200,tokenResponse(client_id,null,d.scope||'chatgpt')); }
      if(f.grant_type==='refresh_token'){ const d=get('refresh',f.refresh_token||''); if(!d||d.client_id!==client_id)return json(res,400,{error:'invalid_grant'}); return json(res,200,tokenResponse(client_id,f.refresh_token,d.scope||'chatgpt')); }
      return json(res,400,{error:'unsupported_grant_type'});
    }
    if(p==='/mcp') return proxy(req,res);
    return json(res,404,{error:'not_found'});
  } catch(e){ console.error(e); if(!res.headersSent)json(res,500,{error:'internal_error'}); else res.end(); }
});
server.listen(PORT,HOST,()=>console.log(`chatgpt MCP OAuth proxy listening on http://${HOST}:${PORT}, public ${BASE}`));
