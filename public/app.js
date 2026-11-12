import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth, initializeAuth, inMemoryPersistence, onAuthStateChanged,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, collection, query, orderBy, limit, onSnapshot, getDoc, setDoc, addDoc, updateDoc, deleteDoc,
  writeBatch, runTransaction, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { firebaseConfig, DOMINIO_USUARIOS } from "./config.js";

/* ============ Firebase ============ */
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const fs = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});
let authSecundario = null; // usado só para o administrador criar contas sem sair da própria
function authSec() {
  if (!authSecundario) {
    const appSec = initializeApp(firebaseConfig, "secundario");
    authSecundario = initializeAuth(appSec, { persistence: inMemoryPersistence });
  }
  return authSecundario;
}

/* ============ utilidades ============ */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const brl = n => (Number(n) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const ms = v => (v && typeof v.toMillis === "function") ? v.toMillis() : (typeof v === "number" ? v : Date.now());
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } }
};
const STATUS = { novo: "Novo", preparo: "Em preparo", pronto: "Pronto", entregue: "Entregue", cancelado: "Cancelado" };
const PAPEIS = { admin: "Administrador", garcom: "Garçom", cozinha: "Cozinha" };
const MODOS_POR_PAPEL = { admin: ["garcom", "cozinha", "gestao"], garcom: ["garcom"], cozinha: ["cozinha"] };
const NOME_MODO = { garcom: "Garçom", cozinha: "Cozinha", gestao: "Gestão" };

function paraEmail(usuario) {
  const u = String(usuario || "").trim().toLowerCase();
  if (u.includes("@")) return u;
  const slug = u.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, ".").replace(/[^a-z0-9._-]/g, "");
  return slug ? `${slug}@${DOMINIO_USUARIOS}` : "";
}
function erroAuth(e) {
  const c = e && e.code;
  if (["auth/invalid-credential", "auth/user-not-found", "auth/wrong-password", "auth/invalid-email"].includes(c)) return "Usuário ou senha incorretos.";
  if (c === "auth/email-already-in-use") return "Já existe uma conta com esse usuário.";
  if (c === "auth/weak-password") return "A senha precisa ter pelo menos 6 caracteres.";
  if (c === "auth/too-many-requests") return "Muitas tentativas. Espere alguns minutos e tente de novo.";
  if (c === "auth/network-request-failed") return "Sem internet. Verifique a conexão.";
  if (c === "auth/operation-not-allowed") return "O login por e-mail e senha está desativado no console do Firebase.";
  return "Não foi possível entrar. Tente de novo.";
}
function erroFs(e) {
  const c = e && e.code;
  if (c === "permission-denied") return "Sem permissão para essa ação.";
  if (c === "unavailable") return "Sem conexão com o servidor. Verifique a internet.";
  if (c === "resource-exhausted") return "Limite do Firebase atingido. Tente mais tarde.";
  return "Não foi possível salvar. Tente de novo.";
}
let toastT;
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.add("hidden"), 3500);
}
async function salvar(fn) {
  try { await fn(); return true; }
  catch (e) { console.error(e); toast(erroFs(e)); return false; }
}
const minutos = ts => Math.max(0, Math.floor((Date.now() - ms(ts)) / 60000));
const hora = ts => new Date(ms(ts)).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

/* ============ estado ============ */
const S = {
  fase: "carregando",      // carregando | login | instalar | sem-acesso | app
  user: null, perfil: null, instalado: true,
  modo: ls.get("comanda.modo", "garcom"),
  tela: "mesas", mesa: null, mesaCarrinho: null,
  carrinho: {}, obsGeral: "", categoria: null,
  cardapio: [], pedidos: [], equipe: [],
  config: { nome: "", mesas: 20 },
  carregou: { cardapio: false, pedidos: false },
  online: navigator.onLine,
  som: false, flash: new Set(),
  editando: null, form: { nome: "", categoria: "", preco: "" },
  formEquipe: { nome: "", usuario: "", senha: "", papel: "garcom" },
  enviando: false, ocupado: false, erroLogin: "",
  campos: {}                // valores digitados nas telas de login e instalação
};
let unsubs = [];
function pararOuvintes() { unsubs.forEach(u => { try { u(); } catch (e) { } }); unsubs = []; }

/* ============ som ============ */
let audioCtx = null;
function beep(vezes) {
  if (!S.som || !audioCtx) return;
  for (let i = 0; i < (vezes || 2); i++) {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = "sine"; o.frequency.value = i % 2 ? 1175 : 880;
    const t = audioCtx.currentTime + i * 0.22;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.35, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    o.connect(g).connect(audioCtx.destination); o.start(t); o.stop(t + 0.21);
  }
}
function ligarSom() {
  try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); S.som = true; beep(1); }
  catch (e) { toast("Este navegador não permite tocar som."); }
}

/* ============ helpers de cardápio ============ */
function categorias() {
  const cats = [];
  S.cardapio.forEach(i => { const c = i.categoria || "Outros"; if (!cats.includes(c)) cats.push(c); });
  return cats.sort((a, b) => ordemCat(a) - ordemCat(b) || a.localeCompare(b, "pt-BR"));
}
function ordemCat(c) { const o = ["Entradas", "Pratos", "Lanches", "Porções", "Bebidas", "Sobremesas"]; const i = o.indexOf(c); return i < 0 ? 50 : i; }
function cardapioOrdenado() {
  const cats = categorias();
  return [...S.cardapio].sort((a, b) => cats.indexOf(a.categoria || "Outros") - cats.indexOf(b.categoria || "Outros") || String(a.nome).localeCompare(String(b.nome), "pt-BR"));
}
function itensCarrinho() {
  return Object.entries(S.carrinho).filter(([, v]) => v.qtd > 0).map(([id, v]) => {
    const it = S.cardapio.find(x => x.id === id); return it ? { id, it, qtd: v.qtd, obs: v.obs || "" } : null;
  }).filter(Boolean);
}
const modosPermitidos = () => MODOS_POR_PAPEL[S.perfil?.papel] || [];

/* ============ render ============ */
function render() {
  const a = document.activeElement, fid = a && a.id, s1 = a && a.selectionStart, s2 = a && a.selectionEnd;
  const emApp = S.fase === "app";
  if (emApp && !modosPermitidos().includes(S.modo)) S.modo = modosPermitidos()[0];
  document.body.classList.toggle("cozinha", emApp && S.modo === "cozinha");
  $("#brand-nome").textContent = S.config.nome || "Comanda";
  $("#dot").classList.toggle("on", S.online && S.carregou.pedidos);
  $("#dot").title = S.online ? "Conectado" : "Sem internet — os pedidos sincronizam quando a conexão voltar";
  $("#modes").innerHTML = emApp && modosPermitidos().length > 1
    ? modosPermitidos().map(m => `<button data-act="modo" data-v="${m}" aria-pressed="${m === S.modo}">${NOME_MODO[m]}</button>`).join("") : "";
  $("#modes").classList.toggle("hidden", !(emApp && modosPermitidos().length > 1));
  $("#user-chip").innerHTML = S.user ? `${esc(S.perfil?.nome || S.user.email)} · <button class="link" data-act="sair">Sair</button>` : "";
  $("#banner").innerHTML = (emApp && !S.online) ? `<div class="banner">Sem internet. Você pode continuar vendo os pedidos; as mudanças são enviadas quando a conexão voltar.</div>` : "";

  const main = $("#app"), dock = $("#dock");fi
  dock.innerHTML = "";
  if (S.fase === "carregando") main.innerHTML = `<div class="login"><p class="muted">Carregando…</p></div>`;
  else if (S.fase === "login") main.innerHTML = vLogin();
  else if (S.fase === "instalar") main.innerHTML = vInstalar();
  else if (S.fase === "sem-acesso") main.innerHTML = vSemAcesso();
  else if (S.modo === "cozinha") main.innerHTML = vCozinha();
  else if (S.modo === "gestao") main.innerHTML = vGestao();
  else { main.innerHTML = vGarcom(); dock.innerHTML = vDock(); }

  if (fid) { const el = document.getElementById(fid); if (el) { el.focus({ preventScroll: true }); try { if (s1 != null) el.setSelectionRange(s1, s2); } catch (e) { } } }
}

/* ============ LOGIN / INSTALAÇÃO ============ */
function vLogin() {
  return `<div class="login"><div class="card">
    <h1>${esc(S.config.nome || "Comanda")}</h1>
    <p class="muted small" style="margin-top:0">Entre com o usuário e a senha que o administrador criou para você.</p>
    <div class="field"><label for="l-usuario">Usuário</label><input class="input" id="l-usuario" value="${esc(S.campos["l-usuario"] || "")}" autocomplete="username" autocapitalize="none" placeholder="Ex.: ana"></div>
    <div class="field"><label for="l-senha">Senha</label><input class="input" id="l-senha" value="${esc(S.campos["l-senha"] || "")}" type="password" autocomplete="current-password"></div>
    <p class="erro" role="alert">${esc(S.erroLogin)}</p>
    <button class="btn primary block" data-act="entrar" ${S.ocupado ? "disabled" : ""}>${S.ocupado ? "Entrando…" : "Entrar"}</button>
    ${S.instalado ? "" : `<p class="small center" style="margin-bottom:0">Primeira vez usando o sistema? <button class="link" data-act="ir-instalar">Criar conta de administrador</button></p>`}
  </div></div>`;
}
function vInstalar() {
  const logado = !!S.user;
  return `<div class="login"><div class="card">
    <h1>Configurar o restaurante</h1>
    <p class="muted small" style="margin-top:0">Esta conta será a do administrador. Com ela você cadastra o cardápio e cria os acessos dos garçons e da cozinha.</p>
    ${logado ? `<p class="small">Conectado como <strong>${esc(S.user.email)}</strong>.</p>` : `
    <div class="field"><label for="i-usuario">Usuário ou e-mail</label><input class="input" id="i-usuario" value="${esc(S.campos["i-usuario"] || "")}" autocapitalize="none" autocomplete="username" placeholder="Ex.: gerente"></div>
    <div class="field"><label for="i-senha">Senha (mínimo 6 caracteres)</label><input class="input" id="i-senha" value="${esc(S.campos["i-senha"] || "")}" type="password" autocomplete="new-password"></div>`}
    <div class="field"><label for="i-nome">Seu nome</label><input class="input" id="i-nome" value="${esc(S.campos["i-nome"] || "")}" placeholder="Ex.: Carlos"></div>
    <div class="field"><label for="i-rest">Nome do restaurante</label><input class="input" id="i-rest" value="${esc(S.campos["i-rest"] || "")}" maxlength="60" placeholder="Ex.: Cantina do Carlos"></div>
    <p class="erro" role="alert">${esc(S.erroLogin)}</p>
    <button class="btn primary block" data-act="instalar" ${S.ocupado ? "disabled" : ""}>${S.ocupado ? "Configurando…" : "Criar e começar"}</button>
    ${logado ? "" : `<p class="small center" style="margin-bottom:0"><button class="link" data-act="ir-login">Já tenho conta</button></p>`}
  </div></div>`;
}
function vSemAcesso() {
  return `<div class="login"><div class="card">
    <h1>Sem acesso</h1>
    <p>A conta <strong>${esc(S.user?.email)}</strong> ainda não tem permissão neste restaurante.</p>
    <p class="muted small">Peça ao administrador para cadastrar você na aba Gestão.</p>
    <button class="btn block" data-act="sair">Sair</button>
  </div></div>`;
}
function lerCampos() { // garante valores preenchidos automaticamente pelo navegador
  document.querySelectorAll("#app input[id^='l-'], #app input[id^='i-']").forEach(el => { S.campos[el.id] = el.value; });
}
async function entrar() {
  lerCampos();
  const email = paraEmail(S.campos["l-usuario"]), senha = S.campos["l-senha"] || "";
  if (!email || !senha) { S.erroLogin = "Preencha usuário e senha."; render(); return; }
  S.ocupado = true; S.erroLogin = ""; render();
  try { await signInWithEmailAndPassword(auth, email, senha); }
  catch (e) { S.erroLogin = erroAuth(e); }
  S.ocupado = false; render();
}
async function instalar() {
  lerCampos();
  const nome = (S.campos["i-nome"] || "").trim(), rest = (S.campos["i-rest"] || "").trim();
  const email = paraEmail(S.campos["i-usuario"]), senha = S.campos["i-senha"] || "";
  if (!S.user && (!email || !senha)) { S.erroLogin = "Preencha usuário e senha."; render(); return; }
  if (!S.user && senha.length < 6) { S.erroLogin = "A senha precisa ter pelo menos 6 caracteres."; render(); return; }
  if (!nome) { S.erroLogin = "Escreva seu nome."; render(); return; }
  S.ocupado = true; S.instalando = true; S.erroLogin = ""; render();
  try {
    let user = S.user;
    if (!user) {
      user = (await createUserWithEmailAndPassword(auth, email, senha)).user;
    }
    const b = writeBatch(fs);
    b.set(doc(fs, "usuarios", user.uid), { nome, email: user.email, papel: "admin", criadoEm: serverTimestamp() });
    b.set(doc(fs, "config", "instalacao"), { criadoEm: serverTimestamp() });
    await b.commit();
    await setDoc(doc(fs, "config", "geral"), { nome: rest || "Meu restaurante", mesas: 20 });
    S.instalado = true;
    S.user = user;
    await carregarPerfil(user);
  } catch (e) {
    console.error("Erro na instalação:", e);
    const c = String(e.code || "");
    if (c === "local") S.erroLogin = e.msg;
    else if (c.startsWith("auth/")) S.erroLogin = erroAuth(e) + ` (código: ${c})`;
    else if (c === "permission-denied") {
      await verificarInstalacao();
      S.erroLogin = S.instalado
        ? "Este sistema já foi configurado por outra pessoa. Peça acesso ao administrador."
        : "O banco recusou a gravação. Publique as regras com: firebase deploy --only firestore:rules (código: permission-denied)";
    }
    else if (c === "not-found" || c === "failed-precondition") S.erroLogin = `O banco Firestore não foi encontrado. Crie o banco em Firestore Database no console do Firebase. (código: ${c})`;
    else if (c === "unavailable") S.erroLogin = "Sem conexão com o banco. Verifique a internet e se o Firestore foi criado. (código: unavailable)";
    else S.erroLogin = `Erro inesperado: ${c || e.message || e}`;
  }
  S.ocupado = false; S.instalando = false;
  if (auth.currentUser && S.fase !== "app") { const msg = S.erroLogin; S.user = auth.currentUser; await carregarPerfil(auth.currentUser); S.erroLogin = msg; }
  render();
}

/* ============ sessão ============ */
async function verificarInstalacao() {
  try { const s = await getDoc(doc(fs, "config", "instalacao")); S.instalado = s.exists(); }
  catch (e) { S.instalado = true; }
}
async function carregarPerfil(user) {
  pararOuvintes();
  let perfil = null;
  try { const s = await getDoc(doc(fs, "usuarios", user.uid)); perfil = s.exists() ? s.data() : null; } catch (e) { }
  S.perfil = perfil;
  if (!perfil) { await verificarInstalacao(); S.fase = S.instalado ? "sem-acesso" : "instalar"; render(); return; }
  S.fase = "app"; render(); iniciarOuvintes();
}
function iniciarOuvintes() {
  const falha = e => { console.error(e); if (e.code === "permission-denied") toast("Seu acesso foi alterado. Entre de novo."); };
  unsubs.push(onSnapshot(doc(fs, "usuarios", S.user.uid), s => {
    if (!s.exists()) { S.perfil = null; pararOuvintes(); S.fase = "sem-acesso"; render(); return; }
    S.perfil = s.data(); render();
  }, falha));
  unsubs.push(onSnapshot(collection(fs, "cardapio"), s => {
    S.cardapio = s.docs.map(d => ({ id: d.id, ...d.data() })); S.carregou.cardapio = true; render();
  }, falha));
  unsubs.push(onSnapshot(doc(fs, "config", "geral"), s => { if (s.exists()) S.config = { ...S.config, ...s.data() }; render(); }, falha));
  let primeira = true;
  unsubs.push(onSnapshot(query(collection(fs, "pedidos"), orderBy("criadoEm", "desc"), limit(400)), s => {
    const ch = s.docChanges();
    S.pedidos = s.docs.map(d => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }));
    if (!primeira) {
      const novos = ch.filter(c => c.type === "added" && !c.doc.metadata.hasPendingWrites && c.doc.data().status === "novo" && ms(c.doc.data({ serverTimestamps: "estimate" }).criadoEm) > Date.now() - 180000);
      if (novos.length && S.modo === "cozinha") {
        novos.forEach(c => S.flash.add(c.doc.id)); beep(3);
        setTimeout(() => novos.forEach(c => S.flash.delete(c.doc.id)), 4000);
      }
      const prontos = ch.filter(c => c.type === "modified" && !c.doc.metadata.hasPendingWrites && c.doc.data().status === "pronto" && c.doc.data().garcomUid === S.user.uid);
      if (prontos.length && S.modo === "garcom") {
        const p = prontos[0].doc.data(); toast(`Mesa ${p.mesa}: pedido #${p.numero} está pronto`); beep(2);
        try { navigator.vibrate && navigator.vibrate([200, 100, 200]); } catch (e) { }
      }
    }
    primeira = false; S.carregou.pedidos = true; render();
  }, falha));
  if (S.perfil.papel === "admin") {
    unsubs.push(onSnapshot(collection(fs, "usuarios"), s => {
      S.equipe = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => String(a.nome).localeCompare(String(b.nome), "pt-BR")); render();
    }, falha));
  }
}
onAuthStateChanged(auth, async user => {
  S.user = user;
  if (S.instalando) return; // a instalação cuida do próprio fluxo
  if (!user) {
    pararOuvintes(); S.perfil = null; S.pedidos = []; S.cardapio = []; S.equipe = [];
    S.carregou = { cardapio: false, pedidos: false };
    await verificarInstalacao();
    S.fase = S.fase === "instalar" && !S.instalado ? "instalar" : "login"; render(); return;
  }
  await carregarPerfil(user);
});
window.addEventListener("online", () => { S.online = true; render(); });
window.addEventListener("offline", () => { S.online = false; render(); });

/* ============ GARÇOM ============ */
function vGarcom() {
  if (S.tela === "pedido") return vMontar();
  if (S.tela === "revisar") return vRevisar();
  const uid = S.user.uid;
  const meus = S.pedidos.filter(p => p.garcomUid === uid);
  const prontos = meus.filter(p => p.status === "pronto").sort((a, b) => ms(a.atualizadoEm) - ms(b.atualizadoEm));
  const abertos = {};
  S.pedidos.forEach(p => {
    if (["novo", "preparo", "pronto"].includes(p.status)) {
      const m = abertos[p.mesa] || (abertos[p.mesa] = { n: 0, pronto: false }); m.n++; if (p.status === "pronto") m.pronto = true;
    }
  });
  const n = Math.max(1, Math.min(200, Number(S.config.mesas) || 20));
  let mesas = "";
  for (let i = 1; i <= n; i++) {
    const m = abertos[i];
    const cls = m ? (m.pronto ? "pronta" : "aberta") : "";
    const sub = m ? (m.pronto ? "Pronto!" : (m.n === 1 ? "1 pedido" : m.n + " pedidos")) : "Livre";
    mesas += `<button class="mesa ${cls}" data-act="mesa" data-v="${i}" aria-label="Mesa ${i}, ${sub}"><b>${i}</b><small>${sub}</small></button>`;
  }
  const recentes = meus.filter(p => p.status !== "cancelado").slice(0, 12);
  return `<div class="wrap">
    ${S.som ? "" : `<p class="small" style="margin:0 0 8px"><button class="link" data-act="som">Avisar com som quando um pedido ficar pronto</button></p>`}
    ${prontos.map(p => `<div class="aviso"><div><strong>Mesa ${esc(p.mesa)} — pedido #${esc(p.numero)} pronto</strong><span class="small">${esc(resumo(p))}</span></div><button class="btn ok" data-act="st" data-id="${esc(p.id)}" data-v="entregue">Entregue</button></div>`).join("")}
    <h2>Escolha a mesa</h2>
    <div class="mesas">${mesas}</div>
    <h2>Seus pedidos</h2>
    ${recentes.length ? `<div class="lista-pedidos">${recentes.map(linhaPedido).join("")}</div>` : `<p class="muted">Nenhum pedido ainda. Toque numa mesa para começar.</p>`}
  </div>`;
}
const resumo = p => (p.itens || []).map(i => `${i.qtd}× ${i.nome}`).join(", ");
function linhaPedido(p) {
  return `<div class="lp"><span class="n">#${esc(p.numero)}</span><div class="info"><div><strong>Mesa ${esc(p.mesa)}</strong> · ${hora(p.criadoEm)}</div><div class="muted small">${esc(resumo(p))}</div></div><span class="st ${esc(p.status)}">${STATUS[p.status] || esc(p.status)}</span></div>`;
}
function vMontar() {
  const cats = categorias();
  const topo = `<div class="bar-mesa"><button class="btn ghost" data-act="voltar-mesas">← Mesas</button><h2>Mesa ${S.mesa}</h2></div>`;
  if (!S.cardapio.length) {
    return `<div class="wrap">${topo}<div class="card"><p>O cardápio está vazio.</p><p class="muted small">O administrador cadastra os pratos na aba Gestão.</p></div></div>`;
  }
  if (!S.categoria || !cats.includes(S.categoria)) S.categoria = cats[0];
  const itens = cardapioOrdenado().filter(i => (i.categoria || "Outros") === S.categoria);
  const qCat = c => itensCarrinho().filter(x => (x.it.categoria || "Outros") === c).reduce((s, x) => s + x.qtd, 0);
  return `<div class="wrap">${topo}
    <div class="chips" role="toolbar" aria-label="Categorias">${cats.map(c => { const q = qCat(c); return `<button class="chip" data-act="cat" data-v="${esc(c)}" aria-pressed="${c === S.categoria}">${esc(c)}${q ? ` (${q})` : ""}</button>`; }).join("")}</div>
    <div class="itens">${itens.map(vItem).join("")}</div>
  </div>`;
}
function vItem(i) {
  const c = S.carrinho[i.id] || { qtd: 0, obs: "" };
  if (i.ativo === false) {
    return `<div class="item esgotado"><div class="row"><div class="nome"><strong>${esc(i.nome)}</strong><span>${brl(i.preco)}</span></div><span class="tag-esg">Esgotado</span></div></div>`;
  }
  return `<div class="item ${c.qtd ? "sel" : ""}">
    <div class="row"><div class="nome"><strong>${esc(i.nome)}</strong><span>${brl(i.preco)}</span></div>
      <div class="qty">${c.qtd ? `<button data-act="menos" data-id="${esc(i.id)}" aria-label="Tirar um ${esc(i.nome)}">−</button><output aria-live="polite">${c.qtd}</output>` : ""}<button class="mais" data-act="mais" data-id="${esc(i.id)}" aria-label="Adicionar ${esc(i.nome)}">+</button></div>
    </div>
    ${c.qtd ? `<div class="obs"><input class="input" id="obs-${esc(i.id)}" data-obs="${esc(i.id)}" value="${esc(c.obs)}" placeholder="Observação (ex.: sem cebola, ao ponto)" maxlength="120"></div>` : ""}
  </div>`;
}
function vRevisar() {
  const it = itensCarrinho(); const total = it.reduce((s, x) => s + x.qtd * (Number(x.it.preco) || 0), 0);
  return `<div class="wrap">
    <div class="bar-mesa"><button class="btn ghost" data-act="voltar-pedido">← Adicionar mais</button><h2>Mesa ${S.mesa}</h2></div>
    <div class="rev">${it.map(x => `<div class="r"><span class="q">${x.qtd}×</span><div class="d">${esc(x.it.nome)}${x.obs ? `<em>${esc(x.obs)}</em>` : ""}</div><span>${brl(x.qtd * (Number(x.it.preco) || 0))}</span></div>`).join("")}
      <div class="tot"><span>Total</span><span>${brl(total)}</span></div></div>
    <div class="field" style="margin-top:16px"><label for="obs-geral">Observação para a cozinha</label><textarea class="input" id="obs-geral" maxlength="240" placeholder="Ex.: servir entrada primeiro, cliente com pressa">${esc(S.obsGeral)}</textarea></div>
    <button class="btn ghost" data-act="descartar">Descartar pedido</button>
  </div>`;
}
function vDock() {
  if (S.tela === "mesas") return "";
  const it = itensCarrinho(); const qtd = it.reduce((s, x) => s + x.qtd, 0); const total = it.reduce((s, x) => s + x.qtd * (Number(x.it.preco) || 0), 0);
  if (S.tela === "pedido") {
    if (!qtd) return "";
    return `<div class="dock"><div class="in"><button class="btn primary" data-act="revisar"><span>Revisar pedido · ${qtd} ${qtd === 1 ? "item" : "itens"}</span><span>${brl(total)}</span></button></div></div>`;
  }
  return `<div class="dock"><div class="in"><button class="btn primary" data-act="enviar" ${S.enviando || !qtd ? "disabled" : ""}><span>${S.enviando ? "Enviando…" : "Enviar para a cozinha"}</span><span>${brl(total)}</span></button></div></div>`;
}
async function enviar() {
  const it = itensCarrinho(); if (!it.length || S.enviando) return;
  if (!S.online) { toast("Sem internet. Conecte-se para enviar o pedido."); return; }
  S.enviando = true; render();
  const base = {
    mesa: S.mesa, garcom: S.perfil.nome || S.user.email, garcomUid: S.user.uid, status: "novo",
    obs: S.obsGeral.trim(),
    itens: it.map(x => ({ nome: x.it.nome, categoria: x.it.categoria || "", qtd: x.qtd, obs: x.obs.trim(), preco: Number(x.it.preco) || 0 })),
    total: Math.round(it.reduce((s, x) => s + x.qtd * (Number(x.it.preco) || 0), 0) * 100) / 100
  };
  let numero = null;
  const ok = await salvar(async () => {
    numero = await runTransaction(fs, async tx => {
      const ref = doc(fs, "config", "contador"); const c = await tx.get(ref);
      const n = ((c.exists() && Number(c.data().ultimo)) || 0) + 1;
      tx.set(ref, { ultimo: n });
      tx.set(doc(collection(fs, "pedidos")), { ...base, numero: n, criadoEm: serverTimestamp(), atualizadoEm: serverTimestamp() });
      return n;
    });
  });
  S.enviando = false;
  if (ok) { toast(`Pedido #${numero} enviado para a cozinha`); S.carrinho = {}; S.obsGeral = ""; S.tela = "mesas"; S.mesa = null; S.mesaCarrinho = null; window.scrollTo(0, 0); }
  render();
}

/* ============ COZINHA ============ */
function vCozinha() {
  const ativos = S.pedidos.filter(p => ["novo", "preparo", "pronto"].includes(p.status));
  const col = st => ativos.filter(p => p.status === st).sort((a, b) => st === "pronto" ? ms(b.atualizadoEm) - ms(a.atualizadoEm) : ms(a.criadoEm) - ms(b.criadoEm));
  const novos = col("novo"), prep = col("preparo"), prontos = col("pronto").slice(0, 12);
  const coluna = (st, titulo, lista, vazio) => `<section class="col ${st}"><div class="col-h"><h3>${titulo}</h3><span class="c">${lista.length}</span></div>
    <div class="tickets">${lista.length ? lista.map(ticket).join("") : `<p class="vazio">${vazio}</p>`}</div></section>`;
  return `<div class="kbar"><span class="clock" id="relogio">${hora(Date.now())}</span>
      ${S.carregou.pedidos ? "" : "<span>Conectando…</span>"}
      <button class="btn ${S.som ? "on" : ""}" data-act="som">${S.som ? "Som ligado" : "Ligar som de aviso"}</button></div>
    <div class="board">
      ${coluna("novo", "Novos", novos, "Nenhum pedido esperando.")}
      ${coluna("preparo", "Em preparo", prep, "Nada no fogo agora.")}
      ${coluna("pronto", "Prontos", prontos, "Pedidos prontos aparecem aqui até o garçom entregar.")}
    </div>`;
}
function tempoCls(p) { if (p.status === "pronto") return ""; const m = minutos(p.criadoEm); return m >= 25 ? "atrasado" : m >= 12 ? "atencao" : ""; }
function ticket(p) {
  const id = esc(p.id);
  const acts = p.status === "novo"
    ? `<button class="btn go" data-act="st" data-id="${id}" data-v="preparo">Começar preparo</button><button class="btn mini" data-act="cancelar" data-id="${id}">Cancelar</button>`
    : p.status === "preparo"
      ? `<button class="btn pronto" data-act="st" data-id="${id}" data-v="pronto">Marcar pronto</button><button class="btn mini" data-act="st" data-id="${id}" data-v="novo">Voltar</button>`
      : `<button class="btn" data-act="st" data-id="${id}" data-v="entregue">Entregue</button><button class="btn mini" data-act="st" data-id="${id}" data-v="preparo">Voltar</button>`;
  return `<article class="ticket ${S.flash.has(p.id) ? "flash" : ""}" aria-label="Pedido ${esc(p.numero)}, mesa ${esc(p.mesa)}">
    <div class="t-top"><div class="t-mesa">Mesa ${esc(p.mesa)}<small>#${esc(p.numero)} · ${esc(p.garcom)} · ${hora(p.criadoEm)}</small></div>
      <div class="t-tempo ${tempoCls(p)}" data-t="${ms(p.criadoEm)}" data-st="${esc(p.status)}">${p.status === "pronto" ? "✓" : minutos(p.criadoEm) + " min"}<small>${p.status === "pronto" ? "pronto " + hora(p.atualizadoEm) : "esperando"}</small></div></div>
    <ul class="t-itens">${(p.itens || []).map(i => `<li><b>${esc(i.qtd)}×</b><div>${esc(i.nome)}${i.obs ? `<em>${esc(i.obs)}</em>` : ""}</div></li>`).join("")}</ul>
    ${p.obs ? `<div class="t-obs">${esc(p.obs)}</div>` : ""}
    <div class="t-acts">${acts}</div>
  </article>`;
}
setInterval(() => {
  if (S.fase !== "app" || S.modo !== "cozinha") return;
  const r = $("#relogio"); if (r) r.textContent = hora(Date.now());
  document.querySelectorAll(".t-tempo[data-t]").forEach(el => {
    if (el.dataset.st === "pronto") return;
    const m = minutos(Number(el.dataset.t));
    el.firstChild.nodeValue = m + " min";
    el.classList.toggle("atrasado", m >= 25); el.classList.toggle("atencao", m >= 12 && m < 25);
  });
}, 15000);

/* ============ GESTÃO ============ */
function vGestao() {
  const cats = categorias();
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const doDia = S.pedidos.filter(p => ms(p.criadoEm) >= hoje.getTime() && p.status !== "cancelado");
  const vendas = doDia.reduce((s, p) => s + (Number(p.total) || 0), 0);
  const finalizados = S.pedidos.filter(p => ["entregue", "cancelado"].includes(p.status)).length;
  const f = S.form, fe = S.formEquipe;
  const lista = cats.length ? cats.map(c => `<div class="cat-h">${esc(c)}</div><div class="itens">${cardapioOrdenado().filter(i => (i.categoria || "Outros") === c).map(i => `
      <div class="adm ${i.ativo === false ? "off" : ""}"><div class="nome"><strong>${esc(i.nome)}</strong><span class="muted small">${brl(i.preco)}</span></div>
        <button class="toggle ${i.ativo === false ? "off" : ""}" data-act="ativo" data-id="${esc(i.id)}">${i.ativo === false ? "Esgotado" : "Disponível"}</button>
        <button class="btn ghost" data-act="editar" data-id="${esc(i.id)}">Editar</button></div>`).join("")}</div>`).join("")
    : `<p class="muted">${S.carregou.cardapio ? "Nenhum prato cadastrado. Use o formulário acima para adicionar o primeiro." : "Carregando…"}</p>`;
  const equipe = S.equipe.map(u => `<div class="adm"><div class="nome"><strong>${esc(u.nome)}</strong><span class="muted small">${esc(u.usuario || u.email)}</span></div>
      ${u.id === S.user.uid ? `<span class="papel">${PAPEIS[u.papel] || esc(u.papel)} (você)</span>` : `
      <select class="input" style="width:auto;min-height:38px;padding:6px 8px" data-papel="${esc(u.id)}" aria-label="Função de ${esc(u.nome)}">
        ${Object.entries(PAPEIS).map(([k, v]) => `<option value="${k}" ${u.papel === k ? "selected" : ""}>${v}</option>`).join("")}
      </select><button class="btn ghost" data-act="remover-usuario" data-id="${esc(u.id)}" style="color:var(--accent)">Remover</button>`}</div>`).join("");
  return `<div class="wrap">
    <h2>Hoje</h2>
    <div class="stats"><div class="stat"><b>${doDia.length}</b><span class="muted small">pedidos</span></div><div class="stat"><b>${brl(vendas)}</b><span class="muted small">em pedidos</span></div></div>

    <h2>${S.editando ? "Editar prato" : "Adicionar prato"}</h2>
    <div class="card">
      <div class="field"><label for="f-nome">Nome</label><input class="input" id="f-nome" data-form="nome" value="${esc(f.nome)}" placeholder="Ex.: Picanha na chapa" maxlength="80"></div>
      <div class="grid2">
        <div class="field"><label for="f-cat">Categoria</label><input class="input" id="f-cat" data-form="categoria" value="${esc(f.categoria)}" list="cats" placeholder="Ex.: Pratos" maxlength="40"><datalist id="cats">${cats.map(c => `<option value="${esc(c)}">`).join("")}</datalist></div>
        <div class="field"><label for="f-preco">Preço (R$)</label><input class="input" id="f-preco" data-form="preco" value="${esc(f.preco)}" inputmode="decimal" placeholder="0,00"></div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn primary" data-act="salvar-item">${S.editando ? "Salvar alterações" : "Adicionar ao cardápio"}</button>
        ${S.editando ? `<button class="btn" data-act="cancelar-edicao">Cancelar</button><button class="btn ghost" data-act="remover-item" style="color:var(--accent)">Remover prato</button>` : ""}
      </div>
    </div>

    <h2>Cardápio</h2>
    <p class="muted small" style="margin-top:-4px">Toque em Disponível para marcar um prato como esgotado. Ele fica bloqueado no celular dos garçons na hora.</p>
    ${lista}

    <h2>Equipe</h2>
    <div class="itens">${equipe || `<p class="muted" style="padding:12px 14px;margin:0">Carregando…</p>`}</div>
    <div class="card" style="margin-top:12px">
      <p class="small" style="margin-top:0"><strong>Criar acesso</strong> — garçons entram só com o usuário e a senha; não precisam de e-mail.</p>
      <div class="grid2">
        <div class="field"><label for="e-nome">Nome</label><input class="input" id="e-nome" data-eq="nome" value="${esc(fe.nome)}" placeholder="Ex.: Ana"></div>
        <div class="field"><label for="e-usuario">Usuário</label><input class="input" id="e-usuario" data-eq="usuario" value="${esc(fe.usuario)}" autocapitalize="none" placeholder="Ex.: ana"></div>
        <div class="field"><label for="e-senha">Senha (mín. 6)</label><input class="input" id="e-senha" data-eq="senha" value="${esc(fe.senha)}" autocomplete="new-password"></div>
        <div class="field"><label for="e-papel">Função</label><select class="input" id="e-papel" data-eq="papel">${Object.entries(PAPEIS).map(([k, v]) => `<option value="${k}" ${fe.papel === k ? "selected" : ""}>${v}</option>`).join("")}</select></div>
      </div>
      <button class="btn primary" data-act="criar-usuario" ${S.ocupado ? "disabled" : ""}>${S.ocupado ? "Criando…" : "Criar acesso"}</button>
    </div>

    <h2>Restaurante</h2>
    <div class="card">
      <div class="grid2">
        <div class="field"><label for="c-nome">Nome do restaurante</label><input class="input" id="c-nome" value="${esc(S.config.nome || "")}" maxlength="60"></div>
        <div class="field"><label for="c-mesas">Número de mesas</label><input class="input" id="c-mesas" type="number" min="1" max="200" value="${esc(S.config.mesas || 20)}"></div>
      </div>
      <button class="btn" data-act="salvar-config">Salvar</button>
    </div>

    <h2>Limpeza</h2>
    <div class="card"><p class="small" style="margin-top:0">${finalizados} pedidos entregues ou cancelados guardados. Apague-os no fim do expediente para manter o sistema rápido e dentro da cota gratuita.</p>
      <button class="btn" data-act="limpar-pedidos" ${finalizados ? "" : "disabled"}>Apagar pedidos finalizados</button></div>
  </div>`;
}
function precoNum(v) {
  const n = Number(String(v).replace(/\s|R\$/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", "."));
  return isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}
async function salvarItem() {
  const nome = S.form.nome.trim(), categoria = S.form.categoria.trim() || "Outros", preco = precoNum(S.form.preco);
  if (!nome) { toast("Escreva o nome do prato."); $("#f-nome")?.focus(); return; }
  if (!(preco >= 0) || S.form.preco === "") { toast("Preço inválido. Use o formato 32,90."); $("#f-preco")?.focus(); return; }
  const id = S.editando;
  const ok = await salvar(async () => {
    if (id) await updateDoc(doc(fs, "cardapio", id), { nome, categoria, preco });
    else await addDoc(collection(fs, "cardapio"), { nome, categoria, preco, ativo: true });
  });
  if (ok) { toast(id ? "Prato atualizado" : "Prato adicionado"); S.form = { nome: "", categoria, preco: "" }; S.editando = null; render(); $("#f-nome")?.focus(); }
}
async function criarUsuario() {
  const fe = S.formEquipe; const nome = fe.nome.trim(); const email = paraEmail(fe.usuario);
  if (!nome || !email) { toast("Preencha nome e usuário."); return; }
  if ((fe.senha || "").length < 6) { toast("A senha precisa ter pelo menos 6 caracteres."); return; }
  S.ocupado = true; render();
  try {
    const cred = await createUserWithEmailAndPassword(authSec(), email, fe.senha);
    await setDoc(doc(fs, "usuarios", cred.user.uid), { nome, usuario: fe.usuario.trim().toLowerCase(), email, papel: fe.papel, criadoEm: serverTimestamp() });
    await signOut(authSec());
    toast(`Acesso criado para ${nome}. Usuário: ${fe.usuario.trim().toLowerCase()}`);
    S.formEquipe = { nome: "", usuario: "", senha: "", papel: fe.papel };
  } catch (e) {
    console.error(e);
    toast(String(e.code || "").startsWith("auth/") ? erroAuth(e) : erroFs(e));
  }
  S.ocupado = false; render();
}

/* ============ eventos ============ */
document.addEventListener("click", async ev => {
  const b = ev.target.closest("[data-act]"); if (!b) return;
  const act = b.dataset.act, id = b.dataset.id, v = b.dataset.v;
  switch (act) {
    case "entrar": entrar(); break;
    case "ir-instalar": S.fase = "instalar"; S.erroLogin = ""; render(); break;
    case "ir-login": S.fase = "login"; S.erroLogin = ""; render(); break;
    case "instalar": instalar(); break;
    case "sair": if (S.tela !== "mesas" && itensCarrinho().length && !confirm("Há um pedido não enviado. Sair mesmo assim?")) return; S.carrinho = {}; S.tela = "mesas"; await signOut(auth); break;
    case "modo": S.modo = v; ls.set("comanda.modo", v); render(); window.scrollTo(0, 0); break;
    case "mesa": S.mesa = Number(v); S.tela = "pedido"; if (S.mesaCarrinho !== S.mesa) { S.carrinho = {}; S.obsGeral = ""; } S.mesaCarrinho = S.mesa; render(); window.scrollTo(0, 0); break;
    case "voltar-mesas": S.tela = "mesas"; render(); break;
    case "voltar-pedido": S.tela = "pedido"; render(); break;
    case "cat": S.categoria = v; render(); break;
    case "mais": { const c = S.carrinho[id] || (S.carrinho[id] = { qtd: 0, obs: "" }); c.qtd++; render(); break; }
    case "menos": { const c = S.carrinho[id]; if (c) c.qtd = Math.max(0, c.qtd - 1); render(); break; }
    case "revisar": S.tela = "revisar"; render(); window.scrollTo(0, 0); break;
    case "descartar": if (confirm("Descartar os itens desta mesa?")) { S.carrinho = {}; S.obsGeral = ""; S.tela = "mesas"; S.mesaCarrinho = null; render(); } break;
    case "enviar": enviar(); break;
    case "som": if (S.som) S.som = false; else ligarSom(); render(); break;
    case "st": await salvar(() => updateDoc(doc(fs, "pedidos", id), { status: v, atualizadoEm: serverTimestamp() })); break;
    case "cancelar": if (confirm("Cancelar este pedido?")) await salvar(() => updateDoc(doc(fs, "pedidos", id), { status: "cancelado", atualizadoEm: serverTimestamp() })); break;
    case "ativo": { const it = S.cardapio.find(x => x.id === id); if (it) await salvar(() => updateDoc(doc(fs, "cardapio", id), { ativo: it.ativo === false })); break; }
    case "editar": {
      const it = S.cardapio.find(x => x.id === id); if (!it) return;
      S.editando = id; S.form = { nome: it.nome || "", categoria: it.categoria || "", preco: String(it.preco ?? "").replace(".", ",") };
      render(); $("#f-nome")?.scrollIntoView({ block: "center" }); $("#f-nome")?.focus(); break;
    }
    case "cancelar-edicao": S.editando = null; S.form = { nome: "", categoria: "", preco: "" }; render(); break;
    case "remover-item":
      if (S.editando && confirm("Remover este prato do cardápio?")) {
        const rid = S.editando;
        if (await salvar(() => deleteDoc(doc(fs, "cardapio", rid)))) { S.editando = null; S.form = { nome: "", categoria: "", preco: "" }; toast("Prato removido"); render(); }
      }
      break;
    case "salvar-item": salvarItem(); break;
    case "criar-usuario": criarUsuario(); break;
    case "remover-usuario": {
      const u = S.equipe.find(x => x.id === id);
      if (u && confirm(`Remover o acesso de ${u.nome}? A pessoa não conseguirá mais entrar no sistema.`)) {
        if (await salvar(() => deleteDoc(doc(fs, "usuarios", id)))) toast("Acesso removido");
      }
      break;
    }
    case "salvar-config": {
      const nome = ($("#c-nome").value || "").trim().slice(0, 60);
      const mesas = Math.max(1, Math.min(200, parseInt($("#c-mesas").value, 10) || 20));
      if (await salvar(() => setDoc(doc(fs, "config", "geral"), { nome, mesas }))) toast("Dados do restaurante salvos");
      break;
    }
    case "limpar-pedidos": {
      const alvo = S.pedidos.filter(p => ["entregue", "cancelado"].includes(p.status));
      if (!alvo.length || !confirm(`Apagar ${alvo.length} pedidos finalizados? Isso não pode ser desfeito.`)) return;
      const ok = await salvar(async () => {
        for (let i = 0; i < alvo.length; i += 450) {
          const lote = writeBatch(fs);
          alvo.slice(i, i + 450).forEach(p => lote.delete(doc(fs, "pedidos", p.id)));
          await lote.commit();
        }
      });
      if (ok) toast(`${alvo.length} pedidos apagados`);
      break;
    }
  }
});
document.addEventListener("input", ev => {
  const t = ev.target;
  if (t.dataset.obs) { const c = S.carrinho[t.dataset.obs]; if (c) c.obs = t.value; }
  else if (t.id === "obs-geral") S.obsGeral = t.value;
  else if (t.dataset.form) S.form[t.dataset.form] = t.value;
  else if (t.dataset.eq) S.formEquipe[t.dataset.eq] = t.value;
  else if (/^(l|i)-/.test(t.id)) S.campos[t.id] = t.value;
});
document.addEventListener("change", async ev => {
  const t = ev.target;
  if (t.dataset.papel) {
    if (await salvar(() => updateDoc(doc(fs, "usuarios", t.dataset.papel), { papel: t.value }))) toast("Função atualizada");
  }
});
document.addEventListener("keydown", ev => {
  if (ev.key !== "Enter") return;
  const id = ev.target.id;
  if (id === "l-usuario" || id === "l-senha") entrar();
  else if (ev.target.dataset && ev.target.dataset.form) salvarItem();
});
