// ════════════════════════════════════════════════════════════════════════════
// CONFIG
// ════════════════════════════════════════════════════════════════════════════
const SUPABASE_URL = "https://gxedxuctwlkjllmayxaa.supabase.co";
const SUPABASE_KEY = "sb_publishable_UlAN1ifdqpTj9pDIwFU0vg_S7AIU5Sg";
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const CASINO_URL = "https://www.bet-300.pw/";

// Enlace variable por oficina: ?pc=<n> resuelve la oficina REAL desde la tabla
// 'oficinas' (sincronizada con Chunior). Acepta el número de Chunior (chunior_pt_id)
// o el pc_codigo directo. NADA hardcodeado: si renombrás la oficina en Chunior,
// la landing se sincroniza sola y las cargas + el chat usan el mismo pc_codigo real.
const _pcParam = (new URLSearchParams(window.location.search).get('pc') || "").trim();
let PC = null;        // pc_codigo real — se resuelve al cargar desde la tabla 'oficinas'
let OFICINA = null;   // { pc_codigo, nombre, chunior_pt_id }

async function resolverOficina(){
  if(!_pcParam) return null;
  let q = sb.from('oficinas').select('pc_codigo,nombre,chunior_pt_id,activa');
  q = /^\d+$/.test(_pcParam) ? q.eq('chunior_pt_id', _pcParam) : q.eq('pc_codigo', _pcParam.toUpperCase());
  const { data } = await q.limit(1);
  if(data && data.length){ OFICINA = data[0]; PC = data[0].pc_codigo; }
  return OFICINA;
}

let usuario = null;
let chatId = null;
let chatMsgs = [];
let imgBase64 = '', imgNombre = '';
let chatPolling = null;
let billeteraActiva = null;
let tabActual = 'cargar';

// ── Helpers ──────────────────────────────────────────────────────────────────
function show(id){ document.getElementById(id)?.classList.remove('hidden') }
function hide(id){ document.getElementById(id)?.classList.add('hidden') }
function val(id){ return document.getElementById(id)?.value?.trim() || '' }
function setVal(id,v){ const el=document.getElementById(id); if(el) el.value=v??'' }
function setHtml(id,h){ const el=document.getElementById(id); if(el) el.innerHTML=h }
function msg(id, html, type='info'){ setHtml(id, html ? `<div class="alert alert-${type}" style="margin-top:12px;margin-bottom:0">${html}</div>` : '') }
function escHtml(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') }
function nmonto(n){ return '$'+Number(n||0).toLocaleString('es-AR') }
function formatTs(ts){ if(!ts) return ''; return new Date(ts).toLocaleString('es-AR',{timeZone:'America/Argentina/Buenos_Aires',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).replace(',',' ·'); }
function comprimirImagen(file, cb){
  const img=new Image(), reader=new FileReader();
  reader.onload=()=>{ img.onload=()=>{
    const max=560; let w=img.width,h=img.height;
    if(w>h&&w>max){h=Math.round(h*max/w);w=max} else if(h>=w&&h>max){w=Math.round(w*max/h);h=max}
    const c=document.createElement('canvas'); c.width=w; c.height=h;
    c.getContext('2d').drawImage(img,0,0,w,h);
    cb(c.toDataURL('image/jpeg',.55));
  }; img.src=reader.result; };
  reader.readAsDataURL(file);
}
function toast(m){
  const t=document.createElement('div'); t.textContent=m;
  Object.assign(t.style,{position:'fixed',bottom:'90px',left:'50%',transform:'translateX(-50%)',
    background:'#238636',color:'#fff',padding:'10px 20px',borderRadius:'12px',fontWeight:'700',
    fontSize:'14px',zIndex:'10005',boxShadow:'0 4px 20px rgba(0,0,0,.4)'});
  document.body.appendChild(t); setTimeout(()=>t.remove(),2200);
}
function copiar(texto,btn,label){
  navigator.clipboard?.writeText(texto).then(()=>{ toast((label||'Copiado')+' ✓'); if(btn){const o=btn.textContent;btn.textContent='✓ Copiado';setTimeout(()=>btn.textContent=o,2000);} }).catch(()=>{});
}

// ════════════════════════════════════════════════════════════════════════════
// PANEL (abrir / cerrar / tabs)
// ════════════════════════════════════════════════════════════════════════════
function abrirPanel(){
  document.getElementById('opBubble').style.display='none';
  show('backdrop'); show('panel');
  document.getElementById('fab').style.display='none';
  if(usuario){ irTab(tabActual); }
}
function cerrarPanel(){
  hide('backdrop'); hide('panel');
  document.getElementById('fab').style.display='flex';
}
function irTab(t){
  tabActual = t;
  ['cargar','retirar','chat'].forEach(x=>{
    document.getElementById('tab'+x.charAt(0).toUpperCase()+x.slice(1))?.classList.add('hidden');
    document.getElementById('nav'+x.charAt(0).toUpperCase()+x.slice(1))?.classList.remove('active');
  });
  document.getElementById('tab'+t.charAt(0).toUpperCase()+t.slice(1))?.classList.remove('hidden');
  document.getElementById('nav'+t.charAt(0).toUpperCase()+t.slice(1))?.classList.add('active');
  // Título del header según tab
  const titulos = { cargar:['💸 Cargar fichas','Transferí y enviá tu solicitud'], retirar:['🏧 Retirar','Cobrá tus ganancias'], chat:['💬 Chat con soporte','Te respondemos al instante'] };
  if(titulos[t]){ setHtml('panelTitle',titulos[t][0]); setHtml('panelSub',titulos[t][1]); }
  if(t==='chat'){ document.getElementById('chatBadge')?.classList.add('hidden'); scrollChat(); }
  if(t==='retirar') cargarSeccionRetiro();
  if(t==='cargar') cargarMisSolicitudes();
}

// ════════════════════════════════════════════════════════════════════════════
// SESIÓN (login manual — sin verificación automática)
// ════════════════════════════════════════════════════════════════════════════
window.addEventListener('load', async ()=>{
  await resolverOficina();
  // Log SOLO para el operador (consola del navegador, nunca visible para el jugador):
  if(PC) console.log('[NODO] pc=' + _pcParam + ' ->', PC);
  else console.warn('[NODO] link sin oficina valida: pc=' + _pcParam);
  const saved = localStorage.getItem('nodo_usuario_casino');
  if(PC && saved){
    try{
      usuario = JSON.parse(saved);
      const { data } = await sb.from('usuarios').select('*').eq('usuario', usuario.usuario).single();
      if(data){ usuario = data; localStorage.setItem('nodo_usuario_casino', JSON.stringify(data)); }
      entrarApp();
    }catch(e){ localStorage.removeItem('nodo_usuario_casino'); }
  }
});

async function identificar(){
  if(!PC){ msg('loginMsg','Este link no tiene una oficina válida. Pedí a tu operador el link correcto.','err'); return; }
  const u = val('inUsuario').toLowerCase().replace(/\s+/g,'');
  if(!u || u.length < 3){ msg('loginMsg','El usuario debe tener al menos 3 caracteres.','err'); return; }
  msg('loginMsg','<span class="spinner"></span>Buscando...','info');

  const { data, error } = await sb.from('usuarios').select('*').eq('usuario', u).single();
  if(error && error.code !== 'PGRST116'){ msg('loginMsg','Error al conectar. Probá de nuevo.','err'); return; }

  if(data){
    // Existe → entra directo (login manual, sin verificación)
    usuario = data;
    localStorage.setItem('nodo_usuario_casino', JSON.stringify(usuario));
    msg('loginMsg','');
    entrarApp();
  } else {
    // Nuevo → pedir nombre + teléfono
    hide('viewLogin'); setVal('regUsuario', u); show('viewRegistro');
    msg('loginMsg','');
  }
}

async function registrar(){
  const nombre = val('regNombre');
  const telefono = val('regTelefono').replace(/\D/g,'');
  const usuarioReg = val('regUsuario').toLowerCase();
  if(!nombre){ msg('regMsg','Ingresá tu nombre.','err'); return; }
  if(!telefono || telefono.length < 8){ msg('regMsg','Ingresá un teléfono válido.','err'); return; }

  const btn = document.getElementById('btnReg');
  btn.disabled = true; btn.textContent = 'Creando...';
  msg('regMsg','');

  // Login manual: creamos el usuario directo (sin verificación contra el casino).
  // El operador en NODO valida si el alias existe al momento de procesar la carga.
  const { data, error } = await sb.from('usuarios')
    .upsert({ usuario: usuarioReg, nombre, telefono, pc_codigo: PC, verificado: true }, { onConflict:'usuario' })
    .select().single();

  btn.disabled = false; btn.textContent = 'Crear y entrar';
  if(error){ msg('regMsg','Error al crear la cuenta. Probá de nuevo.','err'); return; }

  usuario = data;
  localStorage.setItem('nodo_usuario_casino', JSON.stringify(usuario));
  hide('viewRegistro');
  entrarApp();
}

function volverLogin(){ hide('viewRegistro'); show('viewLogin'); }

function entrarApp(){
  abrirPanel();
  hide('viewLogin'); hide('viewRegistro'); show('viewApp');
  show('appTabs');
  cargarBilletera();
  obtenerOCrearChat().then(()=>{ cargarMensajes(false); });
  cargarMisSolicitudes();
  irTab('cargar');
  clearInterval(chatPolling);
  chatPolling = setInterval(()=>{ cargarMensajes(true); cargarMisSolicitudes(); cargarBilletera(); }, 4000);
}

function cerrarSesion(){
  clearInterval(chatPolling);
  localStorage.removeItem('nodo_usuario_casino');
  usuario = null; chatId = null; chatMsgs = [];
  hide('viewApp'); hide('appTabs');
  setVal('inUsuario','');
  show('viewLogin');
  setHtml('panelTitle','💰 Tu cuenta'); setHtml('panelSub','Cargá o retirá sin salir del juego');
}

// ════════════════════════════════════════════════════════════════════════════
// ESTADO DE LA CARGA (en proceso / aprobada / form normal)
// ════════════════════════════════════════════════════════════════════════════
let _nuevaCargaForzada = false, _nuevaCargaTimer = null;

function estadoSolicitud(estado){
  const e = String(estado||'').toUpperCase();
  if(['PENDIENTE','NUEVA','EN_REVISION','APROBADA_MANUAL','APROBADA_MANUAL_OK'].includes(e)) return {esPendiente:true};
  if(['APROBADA','ACREDITADA','PAGADA'].includes(e)) return {esAprobada:true};
  if(['RECHAZADA','CANCELADA','ERROR'].includes(e)) return {esRechazada:true};
  return {};
}

async function cargarMisSolicitudes(){
  if(!usuario?.usuario) return;
  const { data } = await sb.from('solicitudes').select('*')
    .eq('usuario', usuario.usuario).eq('pc_codigo', PC).eq('tipo','CARGA')
    .order('created_at',{ascending:false}).limit(3);

  const statusCard = document.getElementById('cargaStatusCard');
  const formCard   = document.getElementById('cargaFormCard');
  if(!statusCard || !formCard) return;

  if(!data || !data.length){ statusCard.classList.add('hidden'); formCard.classList.remove('hidden'); return; }

  const ultima = data[0];
  const est = estadoSolicitud(ultima.estado);

  if(est.esPendiente){
    statusCard.innerHTML = `<div class="status-box" style="background:linear-gradient(135deg,#3d2d00,#6e4e00)">
      <div style="font-size:30px;margin-bottom:8px">⏳</div>
      <div style="font-weight:900;font-size:17px;margin-bottom:6px">Tu carga está en proceso</div>
      <div style="font-size:13px;opacity:.85">Procesando <b>${nmonto(ultima.monto)}</b>.<br>Te avisamos por el chat cuando esté lista.</div>
    </div>
    <div class="alert alert-warn" style="text-align:center">No envíes otra carga mientras esta está pendiente.</div>`;
    statusCard.classList.remove('hidden'); formCard.classList.add('hidden');
  } else if(est.esAprobada && !_nuevaCargaForzada){
    statusCard.innerHTML = `<div class="status-box" style="background:linear-gradient(135deg,#0a3d1a,#238636)">
      <div style="font-size:34px;margin-bottom:8px">🎉</div>
      <div style="font-weight:900;font-size:17px;margin-bottom:6px">¡Carga acreditada!</div>
      <div style="font-size:13px;opacity:.9;margin-bottom:16px"><b>${nmonto(ultima.monto)}</b> ya están en tu cuenta.</div>
      <button class="btn btn-green" style="margin-top:0" onclick="cerrarPanel()">🎮 Volver a jugar</button>
    </div>
    <button class="btn btn-ghost" onclick="nuevaCarga()">+ Hacer otra carga</button>`;
    statusCard.classList.remove('hidden'); formCard.classList.add('hidden');
  } else if(est.esRechazada && !_nuevaCargaForzada){
    statusCard.innerHTML = `<div class="status-box" style="background:linear-gradient(135deg,#3d1d1c,#6e3531)">
      <div style="font-size:32px;margin-bottom:8px">❌</div>
      <div style="font-weight:900;font-size:17px;margin-bottom:6px">Carga rechazada</div>
      <div style="font-size:13px;opacity:.9;margin-bottom:6px">Tu carga de <b>${nmonto(ultima.monto)}</b> no se pudo acreditar.</div>
      ${ultima.notas?`<div style="font-size:12px;opacity:.85;margin-bottom:6px">Motivo: ${escHtml(ultima.notas)}</div>`:''}
      <div style="font-size:12px;opacity:.85">Revisá el 💬 chat para más detalles.</div>
    </div>
    <button class="btn btn-green" onclick="nuevaCarga()">Intentar otra carga</button>`;
    statusCard.classList.remove('hidden'); formCard.classList.add('hidden');
  } else {
    statusCard.classList.add('hidden'); formCard.classList.remove('hidden');
  }
}

function nuevaCarga(){
  _nuevaCargaForzada = true;
  clearTimeout(_nuevaCargaTimer);
  _nuevaCargaTimer = setTimeout(()=>{ _nuevaCargaForzada=false; }, 35000);
  document.getElementById('cargaStatusCard').classList.add('hidden');
  document.getElementById('cargaFormCard').classList.remove('hidden');
  setVal('cargaMonto',''); msg('cargaMsg','');
}

// ════════════════════════════════════════════════════════════════════════════
// BILLETERA (muestra el CBU para transferir)
// ════════════════════════════════════════════════════════════════════════════
async function cargarBilletera(){
  const { data } = await sb.from('billeteras').select('*')
    .eq('pc_codigo', PC).eq('activa', true).order('seleccionada_manual',{ascending:false}).limit(1);
  const nueva = (data && data.length) ? data[0] : null;

  // No re-renderizar (evita parpadeo) en el polling si la billetera activa no cambió
  if(nueva && billeteraActiva && nueva.id===billeteraActiva.id && (nueva.cbu_alias||'')===(billeteraActiva.cbu_alias||'')){ return; }
  billeteraActiva = nueva;

  if(!billeteraActiva){ setHtml('cargaBilletera','<div class="alert alert-warn">Sin billetera activa en este momento. Escribinos por el chat.</div>'); return; }

  const b = billeteraActiva;
  const aliasRaw = (b.cbu_alias||'').trim();
  const aliasEsCBU = /^\d{15,}$/.test(aliasRaw);
  // CBU: del campo cbu_cvu; si está vacío y cbu_alias es numérico, ese es el CBU (retrocompatible)
  const cbu = (b.cbu_cvu||'').trim() || (aliasEsCBU ? aliasRaw : '');
  // Alias: cbu_alias cuando NO es un CBU numérico ni repite el CBU
  const alias = (aliasRaw && !aliasEsCBU && aliasRaw!==cbu) ? aliasRaw : '';
  const hayDatos = cbu || alias;

  const recuadro = (valor,label)=>{
    const s = valor.replace(/'/g,"\\'");
    return `<div style="font-size:11px;color:var(--muted);margin:8px 0 4px">${label}</div>
      <div onclick="copiar('${s}',this,'${label}')" title="Tocá para copiar"
        style="cursor:pointer;background:#0d1117;border:1px solid var(--line);border-radius:10px;padding:13px">
        <span style="font-size:17px;font-weight:800;word-break:break-all;letter-spacing:.3px">${escHtml(valor)}</span>
      </div>
      <div style="font-size:12px;color:#3fb950;text-align:center;margin:5px 0 2px;font-weight:700">👆 Tocá para copiar el ${label.toLowerCase()}</div>`;
  };

  const minimo = b.monto_minimo ? `<div style="color:#d29922;font-size:13px;margin-top:10px;font-weight:700;text-align:center">⚠ Monto mínimo: ${nmonto(b.monto_minimo)}</div>` : '';

  setHtml('cargaBilletera', `
    <div style="background:var(--card2);border:1px solid var(--line);border-radius:14px;padding:14px">
      <div style="font-size:12px;color:var(--muted);font-weight:700;margin-bottom:6px">💳 Transferí a estos datos</div>
      ${b.titular ? `<div style="font-size:16px;font-weight:800">${escHtml(b.titular)}</div>`:''}
      ${b.banco ? `<div style="font-size:13px;color:var(--muted)">${escHtml(b.banco)}</div>`:''}
      ${cbu ? recuadro(cbu,'CBU / CVU') : ''}
      ${alias ? recuadro(alias,'Alias') : ''}
      ${(cbu&&alias) ? `<div style="font-size:11px;color:var(--muted);text-align:center;margin-top:4px">Transferí con el que prefieras</div>`:''}
      ${!hayDatos ? '<div class="alert alert-warn" style="margin:8px 0 0">Esta billetera todavía no tiene datos cargados. Pedí el CBU por el chat.</div>':''}
      ${minimo}
    </div>`);
  if(b.monto_minimo){ setHtml('cargaMontoHint','Monto mínimo: '+nmonto(b.monto_minimo)); }
}

// ════════════════════════════════════════════════════════════════════════════
// CARGA
// ════════════════════════════════════════════════════════════════════════════
async function enviarSolicitudCarga(){
  const monto = Number(document.getElementById('cargaMonto')?.value || 0);
  const minimo = billeteraActiva?.monto_minimo || 0;
  if(!monto || monto <= 0){ msg('cargaMsg','Ingresá el monto a cargar.','err'); return; }
  if(minimo && monto < minimo){ msg('cargaMsg','El monto mínimo es '+nmonto(minimo)+'.','err'); return; }

  const { data: enCola } = await sb.from('solicitudes').select('id')
    .eq('usuario', usuario.usuario).eq('pc_codigo', PC).eq('tipo','CARGA')
    .in('estado',['PENDIENTE','NUEVA','EN_REVISION','APROBADA_MANUAL','APROBADA_MANUAL_OK']).limit(1);
  if(enCola && enCola.length){ msg('cargaMsg','⏳ Ya tenés una carga en proceso.','warn'); return; }

  msg('cargaMsg','<span class="spinner"></span>Enviando...','info');
  const { error } = await sb.from('solicitudes').insert({
    tipo:'CARGA', usuario:usuario.usuario, nombre_completo:usuario.nombre, telefono:usuario.telefono,
    pc_codigo:PC, monto, estado:'PENDIENTE',
    billetera_nombre: billeteraActiva?.nombre_visible || '', billetera_id: billeteraActiva?.id || null
  });
  if(error){ msg('cargaMsg','Error al enviar. Probá de nuevo.','err'); return; }

  setVal('cargaMonto','');
  cargarMisSolicitudes();
}

// ════════════════════════════════════════════════════════════════════════════
// RETIRO
// ════════════════════════════════════════════════════════════════════════════
async function cargarSeccionRetiro(){
  hide('retiroDatosSetup'); hide('retiroFormCard'); hide('retiroStatusCard');
  const datosCompletos = usuario.dni && usuario.nombre_transferencia && usuario.cbu_alias;
  if(!datosCompletos){ show('retiroDatosSetup'); return; }

  const { data: pendiente } = await sb.from('solicitudes').select('id,estado,monto,created_at')
    .eq('usuario', usuario.usuario).eq('pc_codigo', PC).eq('tipo','RETIRO')
    .in('estado',['PENDIENTE','NUEVA','EN_REVISION']).limit(1);

  if(pendiente && pendiente.length){
    const p = pendiente[0];
    setHtml('retiroStatusCard', `<div class="status-box" style="background:linear-gradient(135deg,#3d2d00,#6e4e00)">
      <div style="font-size:30px;margin-bottom:8px">⏳</div>
      <div style="font-weight:900;font-size:17px;margin-bottom:6px">Retiro en proceso</div>
      <div style="font-size:13px;opacity:.85">Procesando <b>${nmonto(p.monto)}</b>.<br>Te avisamos cuando se transfiera.</div>
    </div><div class="alert alert-warn" style="text-align:center">No envíes otro retiro mientras este está pendiente.</div>`);
    show('retiroStatusCard'); return;
  }

  setHtml('retiroDatosResumen', `<div style="background:var(--card2);border:1px solid var(--line);border-radius:12px;padding:12px;font-size:13px">
    <div style="display:flex;justify-content:space-between;margin-bottom:6px"><span style="color:var(--muted)">DNI</span><b>${escHtml(usuario.dni)}</b></div>
    <div style="display:flex;justify-content:space-between;margin-bottom:6px"><span style="color:var(--muted)">Titular</span><b style="text-align:right;max-width:60%">${escHtml(usuario.nombre_transferencia)}</b></div>
    <div style="display:flex;justify-content:space-between"><span style="color:var(--muted)">CBU/Alias</span><b style="text-align:right;max-width:60%;word-break:break-all">${escHtml(usuario.cbu_alias)}</b></div>
  </div>`);
  show('retiroFormCard'); msg('retiroFormMsg','');
}

function editarDatosRetiro(){
  setVal('setupDni', usuario.dni||''); setVal('setupNombreTransf', usuario.nombre_transferencia||''); setVal('setupCbuAlias', usuario.cbu_alias||'');
  hide('retiroFormCard'); hide('retiroStatusCard'); show('retiroDatosSetup');
}

async function guardarDatosRetiro(){
  const dni = val('setupDni'), nombreTransf = val('setupNombreTransf'), cbuAlias = val('setupCbuAlias');
  if(!dni){ msg('setupRetiroMsg','Ingresá tu DNI.','err'); return; }
  if(!nombreTransf){ msg('setupRetiroMsg','Ingresá el nombre en transferencia.','err'); return; }
  if(!cbuAlias){ msg('setupRetiroMsg','Ingresá tu CBU/CVU/alias.','err'); return; }
  msg('setupRetiroMsg','<span class="spinner"></span>Guardando...','info');

  const { data, error } = await sb.from('usuarios').update({
    dni, nombre_transferencia:nombreTransf, cbu_alias:cbuAlias, updated_at:new Date().toISOString()
  }).eq('id', usuario.id).select().single();
  if(error){ msg('setupRetiroMsg','Error al guardar.','err'); return; }
  usuario = data; localStorage.setItem('nodo_usuario_casino', JSON.stringify(usuario));
  cargarSeccionRetiro();
}

async function enviarSolicitudRetiro(){
  const monto = Number(document.getElementById('retiroMonto')?.value || 0);
  if(!monto || monto <= 0){ msg('retiroFormMsg','Ingresá el monto a retirar.','err'); return; }

  msg('retiroFormMsg','<span class="spinner"></span>Verificando...','info');
  const hace24h = new Date(Date.now() - 24*60*60*1000).toISOString();
  const { data: ultimoRetiro } = await sb.from('solicitudes').select('id,created_at')
    .eq('usuario', usuario.usuario).eq('tipo','RETIRO')
    .in('estado',['PAGADA','APROBADA','ACREDITADA']).gte('created_at', hace24h)
    .order('created_at',{ascending:false}).limit(1);
  if(ultimoRetiro && ultimoRetiro.length){
    const hace = Date.now() - new Date(ultimoRetiro[0].created_at).getTime();
    const horas = Math.ceil((24*60*60*1000 - hace)/(60*60*1000));
    msg('retiroFormMsg','⛔ Ya retiraste en las últimas 24hs. Podés volver en '+horas+'hs.','err'); return;
  }
  const { data: enCola } = await sb.from('solicitudes').select('id')
    .eq('usuario', usuario.usuario).eq('pc_codigo', PC).eq('tipo','RETIRO')
    .in('estado',['PENDIENTE','NUEVA','EN_REVISION']).limit(1);
  if(enCola && enCola.length){ msg('retiroFormMsg','⏳ Ya tenés un retiro en proceso.','warn'); return; }

  msg('retiroFormMsg','<span class="spinner"></span>Enviando...','info');
  const { error } = await sb.from('solicitudes').insert({
    tipo:'RETIRO', usuario:usuario.usuario, nombre_completo:usuario.nombre, telefono:usuario.telefono,
    pc_codigo:PC, monto, estado:'PENDIENTE',
    billetera_nombre:`DNI: ${usuario.dni} · ${usuario.nombre_transferencia} · ${usuario.cbu_alias}`
  });
  if(error){ msg('retiroFormMsg','Error al enviar.','err'); return; }
  setVal('retiroMonto','');
  cargarSeccionRetiro();
}

// ════════════════════════════════════════════════════════════════════════════
// CHAT (con mensajes del operador / NODO)
// ════════════════════════════════════════════════════════════════════════════
async function obtenerOCrearChat(){
  const { data } = await sb.from('chats').select('*')
    .eq('usuario', usuario.usuario).eq('pc_codigo', PC).order('created_at',{ascending:false}).limit(1);
  if(data && data.length){ chatId = data[0].id; }
  else {
    const { data: nuevo } = await sb.from('chats').insert({
      usuario:usuario.usuario, nombre_completo:usuario.nombre, telefono:usuario.telefono, pc_codigo:PC, sin_leer:0
    }).select().single();
    chatId = nuevo?.id || null;
  }
}

async function cargarMensajes(silencioso=false){
  if(!chatId) return;
  const { data } = await sb.from('mensajes_chat').select('*').eq('chat_id', chatId).order('created_at',{ascending:true});
  if(!data) return;
  const prevLen = chatMsgs.length;
  chatMsgs = data;

  if(!silencioso || data.length !== prevLen){
    renderMensajes();
    if(silencioso && data.length > prevLen){
      const nuevos = data.slice(prevLen).filter(m => m.tipo_emisor === 'OPERADOR');
      const enChat = tabActual==='chat' && !document.getElementById('panel').classList.contains('hidden');
      if(enChat) scrollChat();
      else {
        const badge = document.getElementById('chatBadge');
        if(badge){ badge.classList.remove('hidden'); badge.textContent = data.length - prevLen; }
      }
      // Burbuja flotante con el último mensaje del operador (notificación de NODO)
      if(nuevos.length) mostrarOpBubble(nuevos[nuevos.length-1].mensaje || '');
    }
  }
  // Marcar leído si el chat está abierto
  const enChat = tabActual==='chat' && !document.getElementById('panel').classList.contains('hidden');
  if(enChat && chatId){
    await sb.from('mensajes_chat').update({leido:true}).eq('chat_id',chatId).eq('tipo_emisor','OPERADOR').eq('leido',false);
    await sb.from('chats').update({sin_leer:0}).eq('id',chatId);
  }
}

function renderBilleteraCard(texto){
  const lines = texto.split('\n');
  const nombre = (lines[0]||'').replace(/^💳\s*/,'').trim();
  let html = '<div class="bil-card"><div class="bil-nombre">💳 '+escHtml(nombre)+'</div>';
  let footer = '';
  lines.slice(1).forEach(function(line){
    line = line.trim(); if(!line) return;
    if(/^Alias:/i.test(line)){ const v=line.replace(/^Alias:\s*/i,'').trim();
      html += '<div class="bil-field"><span class="bil-label">Alias</span><span class="bil-val">'+escHtml(v)+'</span><button class="bil-copy" onclick="copiar(\''+escHtml(v)+'\',this,\'Alias\')">Copiar alias</button></div>';
    } else if(/^CBU\/CVU:/i.test(line)){ const v=line.replace(/^CBU\/CVU:\s*/i,'').trim();
      html += '<div class="bil-field"><span class="bil-label">CBU / CVU</span><span class="bil-val" style="font-size:13px">'+escHtml(v)+'</span><button class="bil-copy" onclick="copiar(\''+escHtml(v)+'\',this,\'CBU/CVU\')">Copiar CBU/CVU</button></div>';
    } else if(/^Titular:/i.test(line)){ const v=line.replace(/^Titular:\s*/i,'').trim();
      html += '<div class="bil-field"><span class="bil-label">Titular</span><span class="bil-val">'+escHtml(v)+'</span></div>';
    } else if(/^Banco:/i.test(line)){ const v=line.replace(/^Banco:\s*/i,'').trim();
      html += '<div style="margin:4px 0 6px;font-size:12px;color:#bbb">Banco: '+escHtml(v)+'</div>';
    } else if(line.length > 4){ footer = line; }
  });
  if(footer) html += '<div class="bil-footer">'+escHtml(footer)+'</div>';
  return html + '</div>';
}
function renderBubbleContent(m){
  if(m.tipo_emisor==='OPERADOR' && /^💳/.test(m.mensaje||'') && /CBU\/CVU:|Alias:/i.test(m.mensaje||'')) return renderBilleteraCard(m.mensaje);
  return escHtml(m.mensaje||'').replace(/\n/g,'<br>');
}
function renderMensajes(){
  if(!chatMsgs.length){ setHtml('chatBody','<div style="text-align:center;color:var(--muted);font-size:13px;padding:30px 0">Escribinos tu consulta. Te respondemos al instante.</div>'); return; }
  setHtml('chatBody', chatMsgs.map(m=>{
    const esUser = m.tipo_emisor === 'USUARIO';
    return `<div class="msg ${esUser?'user':'op'}"><div class="bubble">${renderBubbleContent(m)}${m.imagen_url?`<img src="${m.imagen_url}">`:''}</div><div class="msg-meta">${esUser?'Vos':'Soporte'} · ${formatTs(m.created_at)}</div></div>`;
  }).join(''));
  scrollChat();
}
function scrollChat(){ const b=document.getElementById('chatBody'); if(b) b.scrollTop=b.scrollHeight; }

async function enviarMensaje(){
  if(!chatId) return;
  const texto = val('chatInput').trim();
  if(!texto && !imgBase64) return;
  setVal('chatInput','');
  const { error } = await sb.from('mensajes_chat').insert({
    chat_id:chatId, mensaje:texto||'', imagen_url:imgBase64||null, tipo_emisor:'USUARIO',
    emisor:usuario.nombre, pc_codigo:PC, leido:false
  });
  if(!error){
    await sb.from('chats').update({
      ultimo_mensaje:texto||'[imagen]', fecha_ultimo:new Date().toISOString(),
      sin_leer:(chatMsgs.filter(m=>m.tipo_emisor==='USUARIO').length % 99)+1,
      nombre_completo:usuario.nombre, telefono:usuario.telefono
    }).eq('id', chatId);
  }
  quitarImagen();
  await cargarMensajes(false);
}

function tomarImagen(){ const f=document.getElementById('chatFile').files[0]; if(f) procesarImagen(f); }
function procesarImagen(file){
  if(!file.type.startsWith('image/')){ alert('Adjuntá una imagen válida.'); return; }
  comprimirImagen(file, b64=>{ imgBase64=b64; imgNombre=file.name;
    document.getElementById('chatPreviewImg').src=b64; show('chatPreviewWrap');
    document.getElementById('chatPreviewWrap').style.display='flex'; });
}
function quitarImagen(){ imgBase64=''; imgNombre=''; setVal('chatFile',''); document.getElementById('chatPreviewImg').src=''; hide('chatPreviewWrap'); }

document.addEventListener('paste', e=>{
  if(tabActual!=='chat') return;
  for(const item of (e.clipboardData?.items||[])){
    if(item.type?.startsWith('image/')){ const f=item.getAsFile(); if(f){ procesarImagen(f); e.preventDefault(); return; } }
  }
});
document.getElementById('chatInput')?.addEventListener('keydown', e=>{
  if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); enviarMensaje(); }
});

// Burbuja flotante (notificación del operador cuando el panel está cerrado)
let _opBubbleTimer = null;
function mostrarOpBubble(texto){
  // Si el panel está abierto, no hace falta la burbuja
  if(!document.getElementById('panel').classList.contains('hidden')) return;
  const b = document.getElementById('opBubble'), t = document.getElementById('opBubbleText');
  if(!b||!t) return;
  t.textContent = texto.length > 130 ? texto.slice(0,127)+'…' : texto;
  b.style.display = 'flex';
  clearTimeout(_opBubbleTimer);
  _opBubbleTimer = setTimeout(()=>{ b.style.display='none'; }, 9000);
}
