/**
 * Admin dashboard single-page app (vanilla JS, no external assets).
 * Served from GET /admin.
 */

const STYLE = `
:root{
  --bg:#0b0e0a; --bg2:#11150f; --panel:#151a12; --panel2:#1b2116;
  --ink:#d8e0c8; --dim:#8b957d; --faint:#5c6353;
  --acid:#c8f542; --amber:#f5b842; --red:#ff6b5e; --cyan:#5ee6d6;
  --line:#262d1e; --line2:#333c26;
  --mono:ui-monospace,"SF Mono","JetBrains Mono","Fira Code",Consolas,monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{
  background:
    radial-gradient(1200px 500px at 80% -10%, rgba(200,245,66,.06), transparent 60%),
    radial-gradient(900px 400px at -10% 110%, rgba(94,230,214,.05), transparent 55%),
    var(--bg);
  color:var(--ink); font-family:var(--mono); font-size:13px; line-height:1.5;
  display:flex;
}
a{color:var(--acid); text-decoration:none}
button{
  font-family:inherit; font-size:11px; letter-spacing:.08em; text-transform:uppercase;
  background:var(--panel2); color:var(--ink); border:1px solid var(--line2);
  padding:8px 14px; cursor:pointer; transition:background .15s,border-color .15s,transform .05s;
}
button:hover{background:#232b1a; border-color:var(--acid)}
button:active{transform:translateY(1px)}
button.primary{background:var(--acid); color:#0b0e0a; border-color:var(--acid); font-weight:700}
button.primary:hover{background:#d9ff7a}
button.danger{color:var(--red); border-color:#4a2420}
button.danger:hover{background:#2a1512; border-color:var(--red)}
input,select{
  font-family:inherit; font-size:13px; background:#0e120b; color:var(--ink);
  border:1px solid var(--line2); padding:9px 10px; width:100%; outline:none;
}
input:focus,select:focus{border-color:var(--acid)}
input[type=checkbox]{width:auto; accent-color:var(--acid)}
label{display:block; font-size:10px; letter-spacing:.12em; text-transform:uppercase; color:var(--dim); margin:12px 0 5px}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-thumb{background:var(--line2)}
::-webkit-scrollbar-track{background:transparent}

/* Login */
.login-wrap{min-height:100vh;width:100%;display:flex;align-items:center;justify-content:center;padding:24px}
.login-card{width:380px;background:var(--panel);border:1px solid var(--line);padding:36px 32px;position:relative}
.login-card:before{content:"";position:absolute;inset:-1px;border:1px solid var(--line2);pointer-events:none}
.login-card h1{font-size:20px;letter-spacing:.06em;color:var(--acid);margin-bottom:6px}
.login-card .sub{color:var(--dim);font-size:11px;margin-bottom:22px}
.login-card .err{color:var(--red);font-size:11px;min-height:16px;margin-top:12px}

/* Shell */
.side{width:210px;flex:0 0 210px;background:var(--bg2);border-right:1px solid var(--line);padding:20px 12px;display:flex;flex-direction:column;min-height:100vh}
.side .brand{font-size:15px;letter-spacing:.12em;color:var(--acid);text-transform:uppercase;margin-bottom:2px}
.side .brand small{display:block;color:var(--faint);font-size:10px;letter-spacing:.2em;text-transform:uppercase;margin-bottom:22px}
.nav{display:flex;flex-direction:column;gap:4px}
.nav button{text-align:left;background:none;border:none;color:var(--dim);padding:9px 10px;border-left:2px solid transparent}
.nav button:hover{color:var(--ink);background:#14190f}
.nav button.active{color:var(--acid);border-left-color:var(--acid);background:#14190f}
.side .foot{margin-top:auto;color:var(--faint);font-size:10px}
.side .foot button{width:100%;margin-top:10px}

.main{flex:1;padding:26px 30px 60px;min-width:0}
.topbar{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:22px}
.topbar h2{font-size:17px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink)}
.topbar .status{color:var(--faint);font-size:11px}
.topbar .status b{color:var(--acid);font-weight:400}

.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:26px}
.card{background:var(--panel);border:1px solid var(--line);padding:16px}
.card .k{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);margin-bottom:8px}
.card .v{font-size:24px;color:var(--ink);font-weight:700}
.card .v.warn{color:var(--amber)}
.card .v.bad{color:var(--red)}
.card .v.good{color:var(--acid)}
.card .s{font-size:10px;color:var(--faint);margin-top:6px}

.panel{background:var(--panel);border:1px solid var(--line);margin-bottom:20px}
.panel>header{display:flex;align-items:center;justify-content:space-between;padding:13px 16px;border-bottom:1px solid var(--line)}
.panel>header h3{font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--amber)}
.panel>header .hint{font-size:10px;color:var(--faint)}
.panel .body{padding:14px 16px;overflow-x:auto}

table{width:100%;border-collapse:collapse;font-size:12px}
th{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);text-align:left;padding:8px 10px;border-bottom:1px solid var(--line2);white-space:nowrap}
td{padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:none}
td .mono{font-size:11px;color:var(--dim)}
.pill{display:inline-block;font-size:10px;padding:2px 8px;border:1px solid var(--line2);border-radius:2px;letter-spacing:.05em}
.pill.ok{color:var(--acid);border-color:#3c4a1c}
.pill.warn{color:var(--amber);border-color:#4a3a16}
.pill.bad{color:var(--red);border-color:#4a2420}
.td-actions{white-space:nowrap}
.td-actions button{margin-left:6px;padding:5px 9px;font-size:10px}

.row{display:flex;gap:12px;flex-wrap:wrap}
.col{flex:1;min-width:240px}
.hidden{display:none !important}
pre.raw{background:#0e120b;border:1px solid var(--line);padding:14px;font-size:11px;overflow:auto;max-height:60vh;white-space:pre-wrap;word-break:break-all}
.toast{position:fixed;bottom:22px;right:22px;background:var(--panel2);border:1px solid var(--line2);padding:12px 16px;font-size:12px;z-index:50;opacity:0;transform:translateY(8px);transition:all .2s;max-width:420px}
.toast.show{opacity:1;transform:none}
.toast.ok{border-color:#3c4a1c;color:var(--acid)}
.toast.err{border-color:#4a2420;color:var(--red)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media(max-width:900px){.side{display:none}.grid2{grid-template-columns:1fr}}
`;

function loginScreen(): string {
  return `
<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QwenProxy · Admin</title><style>${STYLE}</style></head>
<body><div class="login-wrap"><div class="login-card">
  <h1>QwenProxy</h1><div class="sub">Console de administração</div>
  <label for="pw">Senha do admin</label>
  <input type="password" id="pw" autocomplete="current-password" autofocus>
  <div class="err" id="err"></div>
  <br>
  <button class="primary" id="go" style="width:100%">Entrar</button>
</div></div>
<script>
(function(){
  var pw=document.getElementById('pw'),err=document.getElementById('err');
  function login(){
    fetch('/admin/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw.value})})
      .then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j}})})
      .then(function(r){
        if(r.ok && r.j.ok){location.href='/admin'}
        else{err.textContent=(r.j&&r.j.error)||'Falha ao autenticar'}
      })
      .catch(function(e){err.textContent='Erro de rede: '+e.message});
  }
  pw.addEventListener('keydown',function(e){if(e.key==='Enter')login()});
  document.getElementById('go').addEventListener('click',login);
})();
</script></body></html>`;
}

function shellHtml(): string {
  return `
<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QwenProxy · Admin</title><style>${STYLE}</style></head>
<body>
<aside class="side">
  <div class="brand">QwenProxy<small>admin console</small></div>
  <nav class="nav" id="nav">
    <button data-view="overview" class="active">Visão geral</button>
    <button data-view="accounts">Contas</button>
    <button data-view="users">API Keys</button>
    <button data-view="settings">Configuração</button>
    <button data-view="metrics">Métricas</button>
  </nav>
  <div class="foot">v1.12.16 · <span id="uptime">–</span><br>
    <button id="logout">Sair</button></div>
</aside>
<main class="main">
  <div class="topbar">
    <h2 id="viewTitle">Visão geral</h2>
    <div class="status">status: <b id="apiStatus">–</b></div>
  </div>
  <div id="view"></div>
</main>
<div class="toast" id="toast"></div>
<script>
var VIEWS={overview:'Visão geral',accounts:'Contas',users:'API Keys',settings:'Configuração',metrics:'Métricas'};
var current='overview', timer=null, state={};

function el(html){var d=document.createElement('div');d.innerHTML=html.trim();return d.firstChild}
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function toast(msg,type){var t=document.getElementById('toast');t.textContent=msg;t.className='toast show '+(type||'');clearTimeout(t._h);t._h=setTimeout(function(){t.className='toast'},3000)}
function api(path,opts){opts=opts||{};opts.headers=Object.assign({'Content-Type':'application/json'},opts.headers);
  return fetch(path,opts).then(function(r){return r.text().then(function(t){var j=null;try{j=JSON.parse(t)}catch(e){}return {ok:r.ok,status:r.status,j:j,t:t}})}).then(function(r){
    if(!r.ok){toast((r.j&&r.j.error)||('HTTP '+r.status),'err');throw new Error((r.j&&r.j.error)||r.status)}
    return r.j;});
}
function fmtBytes(n){if(n==null)return'–';var u=['B','KB','MB','GB'];var i=0;while(n>=1024&&i<u.length-1){n/=1024;i++}return n.toFixed(n>=100||i===0?0:1)+' '+u[i]}
function fmtSec(s){if(s==null)return'–';if(s<60)return s+'s';if(s<3600)return Math.floor(s/60)+'m';if(s<86400)return Math.floor(s/3600)+'h';return Math.floor(s/86400)+'d'}

/* ---------- Login / logout ---------- */
document.getElementById('logout').addEventListener('click',function(){
  api('/admin/api/logout',{method:'POST'}).finally(function(){location.href='/admin'});
});
function checkSession(){return fetch('/admin/api/session').then(function(r){return r.json()}).then(function(j){
  if(!j.authenticated){location.href='/admin';return false}
  document.getElementById('apiStatus').textContent='online';return true;}).catch(function(){return false})}

/* ---------- Navigation ---------- */
document.getElementById('nav').addEventListener('click',function(e){
  var b=e.target.closest('button');if(!b)return;
  document.querySelectorAll('#nav button').forEach(function(x){x.classList.remove('active')});
  b.classList.add('active');current=b.dataset.view;load();
});
function load(){
  if(timer){clearInterval(timer);timer=null}
  document.getElementById('viewTitle').textContent=VIEWS[current]||'';
  var view=document.getElementById('view');
  view.innerHTML='<div class="panel"><div class="body">carregando…</div></div>';
  if(current==='overview')renderOverview(view);
  else if(current==='accounts')renderAccounts(view);
  else if(current==='users')renderUsers(view);
  else if(current==='settings')renderSettings(view);
  else if(current==='metrics')renderMetrics(view);
}

/* ---------- Overview ---------- */
function renderOverview(view){
  var refresh=function(){
    api('/admin/api/overview').then(function(o){
      state.o=o;
      var latAvg=o.latency&&o.latency.count?Math.round(o.latency.sum/o.latency.count):0;
      var memPct=Math.round(o.memory.heapUsed/o.memory.heapTotal*100);
      view.innerHTML=
      '<div class="cards">'+
        '<div class="card"><div class="k">Requisições</div><div class="v">'+o.requestsTotal+'</div><div class="s">'+fmtSec(o.uptime)+' de uptime</div></div>'+
        '<div class="card"><div class="k">Erros</div><div class="v '+(o.requestsErrors?'bad':'good')+'">'+o.requestsErrors+'</div><div class="s">'+(o.requestsSuccessRate==null?'–':o.requestsSuccessRate.toFixed(1)+'% de sucesso')+'</div></div>'+
        '<div class="card"><div class="k">Latência média</div><div class="v">'+latAvg+'ms</div><div class="s">amostras: '+(o.latency?o.latency.count:0)+'</div></div>'+
        '<div class="card"><div class="k">Streams ativos</div><div class="v">'+o.totalUserStreams+'</div><div class="s">métrica: '+o.activeStreamsMetric+'</div></div>'+
        '<div class="card"><div class="k">Sessões híbridas</div><div class="v">'+o.sessionCount+'</div><div class="s">persistidas em SQLite</div></div>'+
        '<div class="card"><div class="k">Memória</div><div class="v '+(memPct>85?'bad':memPct>70?'warn':'')+'">'+memPct+'%</div><div class="s">'+fmtBytes(o.memory.heapUsed)+' / '+fmtBytes(o.memory.heapTotal)+'</div></div>'+
      '</div>'+
      '<div class="grid2">'+
        '<div class="panel"><header><h3>Contas</h3><span class="hint">carga · cooldown</span></header><div class="body">'+accountsTable(o.accounts,o.inUseAccounts)+'</div></div>'+
        '<div class="panel"><header><h3>Usuários</h3><span class="hint">streams em curso</span></header><div class="body">'+usersStreamsTable(o.users)+'</div></div>'+
      '</div>'+
      '<div class="panel"><header><h3>Warm pool</h3><span class="hint">chats prontos por conta</span></header><div class="body">'+
        (Object.keys(o.warmPool).length?'<div class="row">'+Object.keys(o.warmPool).map(function(k){return '<div class="card" style="flex:0 0 auto"><div class="k">'+esc(k)+'</div><div class="v good">'+o.warmPool[k]+'</div></div>'}).join('')+'</div>':'<div style="color:var(--faint)">Sem chats aquecidos no momento</div>')+
      '</div></div>';
    }).catch(function(){});
  };
  refresh();timer=setInterval(refresh,10000);
}
function accountsTable(accounts,inUse){
  if(!accounts||!accounts.length)return '<div style="color:var(--faint)">Nenhuma conta configurada</div>';
  return '<table><thead><tr><th>E-mail</th><th>Carga</th><th>Cooldown</th><th>Estado</th></tr></thead><tbody>'+
    accounts.map(function(a){
      var cd=a.cooldown>0?('<span class="pill warn">'+fmtSec(a.cooldown/1000)+'</span>') : '<span class="pill ok">ok</span>';
      var st=inUse.indexOf(a.id)>-1?'<span class="pill warn">em uso</span>':'<span class="pill ok">livre</span>';
      return '<tr><td>'+esc(a.email)+'<div class="mono">'+esc(a.id)+'</div></td>'+
        '<td>'+a.activeLoad+'</td><td>'+cd+'</td><td>'+st+'</td></tr>';
    }).join('')+'</tbody></table>';
}
function usersStreamsTable(users){
  if(!users||!users.length)return '<div style="color:var(--faint)">Sem usuários de API</div>';
  return '<table><thead><tr><th>Usuário</th><th>Streams</th></tr></thead><tbody>'+
    users.map(function(u){return '<tr><td>'+esc(u.email||u.id)+'</td><td>'+u.streams+'</td></tr>'}).join('')+
    '</tbody></table>';
}

/* ---------- Accounts ---------- */
function renderAccounts(view){
  var refresh=function(){api('/admin/api/accounts').then(function(d){
    state.accounts=d;
    view.innerHTML=
    '<div class="panel"><header><h3>Contas Qwen</h3><span class="hint">'+d.accounts.length+' configurada(s)</span></header><div class="body">'+
    '<table><thead><tr><th>E-mail</th><th>ID</th><th>Carga</th><th>Cooldown</th><th>Em uso</th><th></th></tr></thead><tbody>'+
    d.accounts.map(function(a){
      var cd=a.cooldown>0?('<span class="pill warn">'+fmtSec(a.cooldown/1000)+'</span>'+(a.cooldownReason?' <span class="pill bad">'+esc(a.cooldownReason)+'</span>':'')):'<span class="pill ok">ok</span>';
      return '<tr><td>'+esc(a.email)+'</td><td class="mono">'+esc(a.id)+'</td><td>'+a.activeLoad+'</td><td>'+cd+'</td>'+
        '<td>'+(d.inUse.indexOf(a.id)>-1?'<span class="pill warn">sim</span>':'<span class="pill ok">não</span>')+'</td>'+
        '<td class="td-actions">'+
          '<button data-act="cd" data-id="'+esc(a.id)+'">limpar cooldown</button>'+
          '<button data-act="ref" data-id="'+esc(a.id)+'">refresh headers</button>'+
          '<button class="danger" data-act="del" data-id="'+esc(a.id)+'">remover</button>'+
        '</td></tr>';
    }).join('')+'</tbody></table></div></div>'+
    '<div class="panel"><header><h3>Adicionar conta</h3></header><div class="body"><div class="row">'+
      '<div class="col"><label>E-mail</label><input id="acc-email" placeholder="email@qwen.example"></div>'+
      '<div class="col"><label>Senha</label><input id="acc-pass" type="password" placeholder="senha da conta"></div>'+
      '<div class="col" style="flex:0 0 160px;align-self:flex-end"><button class="primary" style="width:100%" id="acc-add">Adicionar</button></div>'+
    '</div></div></div>';
    view.querySelectorAll('button[data-act]').forEach(function(b){
      b.addEventListener('click',function(){
        var act=b.dataset.act,id=b.dataset.id;
        if(act==='del'){if(!confirm('Remover conta '+id+'?'))return;api('/admin/api/accounts/'+id,{method:'DELETE'}).then(refresh);}
        else if(act==='cd'){api('/admin/api/accounts/'+id+'/clear-cooldown',{method:'POST'}).then(refresh);}
        else if(act==='ref'){toast('Atualizando headers…');api('/admin/api/accounts/'+id+'/refresh',{method:'POST'}).then(function(){toast('Headers atualizados','ok');refresh()});}
      });
    });
    var addBtn=view.querySelector('#acc-add');
    addBtn.addEventListener('click',function(){
      api('/admin/api/accounts',{method:'POST',body:JSON.stringify({email:view.querySelector('#acc-email').value,password:view.querySelector('#acc-pass').value})})
        .then(function(){toast('Conta adicionada','ok');refresh();});
    });
  });};
  refresh();
}

/* ---------- Users / API keys ---------- */
function renderUsers(view){
  var refresh=function(){api('/admin/api/users').then(function(list){
    state.users=list;
    view.innerHTML=
    '<div class="panel"><header><h3>API Keys de usuários</h3><span class="hint">'+list.length+' chave(s)</span></header><div class="body">'+
    '<table><thead><tr><th>Usuário</th><th>API Key</th><th>RPM</th><th>Concorrência</th><th>Streams</th><th></th></tr></thead><tbody>'+
    list.map(function(u){
      return '<tr><td>'+esc(u.email||u.id)+'</td><td class="mono">'+esc(u.apiKey)+'</td>'+
        '<td>'+u.rateLimitRpm+'</td><td>'+u.maxConcurrency+'</td><td>'+u.activeStreams+'</td>'+
        '<td class="td-actions">'+
          '<button data-act="edit" data-id="'+esc(u.id)+'" data-key="'+esc(u.apiKey)+'" data-email="'+esc(u.email||'')+'" data-rpm="'+u.rateLimitRpm+'" data-conc="'+u.maxConcurrency+'">editar</button>'+
          '<button data-act="reg" data-id="'+esc(u.id)+'" data-key="'+esc(u.apiKey)+'">regenerar</button>'+
          '<button class="danger" data-act="del" data-id="'+esc(u.id)+'">remover</button>'+
        '</td></tr>';
    }).join('')+'</tbody></table></div></div>'+
    '<div class="panel"><header><h3>Novo usuário</h3></header><div class="body"><div class="row">'+
      '<div class="col"><label>Rótulo / e-mail</label><input id="u-email" placeholder="usuario1"></div>'+
      '<div class="col"><label>API Key (deixe vazio para gerar)</label><input id="u-key"></div>'+
      '<div class="col"><label>RPM</label><input id="u-rpm" type="number" value="'+configRpm()+'"></div>'+
      '<div class="col"><label>Concorrência</label><input id="u-conc" type="number" value="'+configConc()+'"></div>'+
      '<div class="col" style="flex:0 0 130px;align-self:flex-end"><button class="primary" style="width:100%" id="u-add">Criar</button></div>'+
    '</div></div></div>';
    view.querySelectorAll('button[data-act]').forEach(function(b){
      b.addEventListener('click',function(){
        var act=b.dataset.act,id=b.dataset.id;
        if(act==='del'){if(!confirm('Remover usuário '+id+'?'))return;api('/admin/api/users/'+id,{method:'DELETE'}).then(refresh);}
        else if(act==='reg'){
          var key='sk-'+Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2);
          api('/admin/api/users/'+id,{method:'PUT',body:JSON.stringify({apiKey:key})}).then(function(){toast('Nova key: '+key+' — copie antes de fechar','ok');refresh()});
        }
        else if(act==='edit'){
          var email=prompt('Rótulo / e-mail',b.dataset.email);
          var rpm=prompt('RPM',b.dataset.rpm);
          var conc=prompt('Concorrência',b.dataset.conc);
          if(email==null||rpm==null||conc==null)return;
          api('/admin/api/users/'+id,{method:'PUT',body:JSON.stringify({email:email,rateLimitRpm:Number(rpm),maxConcurrency:Number(conc)})}).then(function(){toast('Usuário atualizado','ok');refresh()});
        }
      });
    });
    view.querySelector('#u-add').addEventListener('click',function(){
      var key=view.querySelector('#u-key').value.trim();
      if(!key){key='sk-'+Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2)}
      api('/admin/api/users',{method:'POST',body:JSON.stringify({email:view.querySelector('#u-email').value.trim()||'user',apiKey:key,rateLimitRpm:Number(view.querySelector('#u-rpm').value)||0,maxConcurrency:Number(view.querySelector('#u-conc').value)||0})})
        .then(function(){toast('Key criada: '+key+' — copie antes de fechar','ok');refresh()});
    });
  });};
  function configRpm(){return (state.o&&state.o.userRateLimitRpm)||120}
  function configConc(){return (state.o&&state.o.userMaxConcurrency)||8}
  refresh();
}

/* ---------- Settings ---------- */
function renderSettings(view){
  api('/admin/api/settings').then(function(d){
    view.innerHTML=
    '<div class="panel"><header><h3>Configuração essencial</h3><span class="hint">.env · requer restart para aplicar</span></header><div class="body">'+
    '<form id="set-form"><div class="grid2">'+
    d.allowlist.map(function(k){
      var cur=d.settings[k]||defaults(k);
      var type=isBoolKey(k)?'checkbox':isIntKey(k)?'number':'text';
      var val=isBoolKey(k)?(cur==='true'?'checked':''):esc(cur||'');
      return '<div class="col"><label>'+esc(k)+'</label>'+
        (isBoolKey(k)?'<input type="checkbox" name="'+esc(k)+'" '+val+'><span style="margin-left:8px;color:var(--dim)">'+(cur==='true'?'true':'false')+'</span>'
          :'<input type="'+type+'" name="'+esc(k)+'" value="'+val+'">')+'</div>';
    }).join('')+
    '</div><div style="margin-top:16px;display:flex;gap:10px;align-items:center">'+
      '<button class="primary" type="submit">Salvar</button>'+
      '<span style="color:var(--faint);font-size:11px">Aplicar alterações em .env. O servidor precisa ser reiniciado.</span>'+
    '</div></form></div></div>'+
    '<div class="panel"><header><h3>Ações</h3></header><div class="body" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">'+
      '<button id="restart" class="danger">Reiniciar servidor</button>'+
      '<button id="dl-metrics">Baixar métricas (Prometheus)</button>'+
    '</div></div>';
    function isBoolKey(k){return ['HEADLESS','QWEN_GUEST_MODE_ONLY','SINGLE_ACCOUNT_MODE','SESSION_KEEPER_ENABLED','AUTH_REQUIRED','HYBRID_SESSIONS_ENABLED','HYBRID_SESSION_VERIFY'].indexOf(k)>-1}
    function isIntKey(k){return ['PORT','WARM_POOL_SIZE','WARM_POOL_LOW_WATER','WARM_POOL_TTL_MS','ACCOUNT_LANES','LARGE_PROMPT_THRESHOLD','HYBRID_SESSION_TTL_MS','USER_RATE_LIMIT_RPM','USER_MAX_CONCURRENCY'].indexOf(k)>-1}
    function defaults(k){
      var m={'PORT':'3000','HOST':'0.0.0.0','HEADLESS':'true','LOG_CONSOLE':'false','BROWSER':'chromium','QWEN_GUEST_MODE_ONLY':'false','SINGLE_ACCOUNT_MODE':'false','SESSION_KEEPER_ENABLED':'true','BACKGROUND_HEADER_REFRESH':'true','WARM_POOL_STARTUP':'true','HYBRID_SESSIONS_ENABLED':'true','HYBRID_SESSION_VERIFY':'true','QWEN_DIRECT_FETCH':'true','AUTH_REQUIRED':'false','WARM_POOL_SIZE':'3','WARM_POOL_LOW_WATER':'1','WARM_POOL_TTL_MS':'600000','ACCOUNT_LANES':'1','ACCOUNT_MAX_CONCURRENT_STREAMS':'2','ACCOUNT_STREAM_SLOT_WAIT_MS':'30000','HEADERS_TTL_MS':'1800000','LARGE_PROMPT_THRESHOLD':'524288','HYBRID_SESSION_TTL_MS':'86400000','USER_RATE_LIMIT_RPM':'120','USER_MAX_CONCURRENCY':'8'};
      return m[k]||'';
    }
    view.querySelector('#set-form').addEventListener('submit',function(e){
      e.preventDefault();
      var patch={};
      d.allowlist.forEach(function(k){
        var f=view.querySelector('[name="'+k+'"]');
        if(!f)return;
        if(f.type==='checkbox')patch[k]=f.checked?'true':'false';
        else if(f.value.trim()!=='')patch[k]=f.value.trim();
      });
      api('/admin/api/settings',{method:'POST',body:JSON.stringify(patch)}).then(function(r){toast('Salvo. Reinicie o servidor para aplicar.','ok')});
    });
    view.querySelector('#restart').addEventListener('click',function(){
      if(!confirm('Reiniciar o servidor agora?'))return;
      fetch('/admin/api/restart',{method:'POST'}).then(function(){toast('Reiniciando…','ok');setTimeout(function(){location.reload()},1500)});
    });
    view.querySelector('#dl-metrics').addEventListener('click',function(){
      fetch('/admin/api/metrics').then(function(r){return r.text()}).then(function(t){
        var a=document.createElement('a');a.href='data:text/plain;charset=utf-8,'+encodeURIComponent(t);a.download='metrics.txt';a.click();
      });
    });
  });
}

/* ---------- Metrics ---------- */
function renderMetrics(view){
  var refresh=function(){fetch('/admin/api/metrics').then(function(r){return r.text()}).then(function(t){
    view.innerHTML='<div class="panel"><header><h3>Métricas (Prometheus)</h3><span class="hint">atualizado '+new Date().toLocaleTimeString()+'</span></header><div class="body"><pre class="raw">'+esc(t)+'</pre></div></div>'+
      '<div style="display:flex;gap:10px"><button class="primary" id="m-refresh">Atualizar</button></div>';
    view.querySelector('#m-refresh').addEventListener('click',refresh);
  });};
  refresh();timer=setInterval(refresh,15000);
}

/* ---------- Boot ---------- */
checkSession().then(function(ok){if(ok)load()});
</script></body></html>`;
}

export function renderDashboard(showLogin: boolean): string {
  return showLogin ? loginScreen() : shellHtml()
}