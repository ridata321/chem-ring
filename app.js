// 高中化學光譜圓環：讀資料、Google 登入、送出建議
(function () {
  const CFG = window.CHEM_CONFIG || {};
  const $ = s => document.querySelector(s);

  // ---------- 共用：呼叫後端 ----------
  async function api(action, payload) {
    if (!CFG.API_URL) throw new Error("not_configured");
    const res = await fetch(CFG.API_URL, { method: "POST", body: JSON.stringify({ action, idToken: auth.token, ...payload }) });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || "failed");
    return j;
  }
  window.chemApi = api;

  // ---------- 試算表資料 → 圓環資料 ----------
  function convert(raw) {
    const books = raw.books;
    const order = Object.fromEntries(books.map((b, i) => [b.code, i]));
    const secs = raw.sections.filter(s => order[s.book] !== undefined)
      .map((s, i) => ({ ...s, i })).sort((a, b) => order[a.book] - order[b.book] || a.ch - b.ch || a.i - b.i);
    const chapters = [], chMap = {}, secByCode = {};
    secs.forEach(s => {
      const id = s.book + "|" + s.ch;
      if (!chMap[id]) { chMap[id] = { id, title: s.chTitle, num: s.ch, bookCode: s.book, sections: {} }; chapters.push(chMap[id]); }
      const short = s.code.replace(s.book, "").trim();
      const key = `${short} ${s.name}`;
      chMap[id].sections[key] = [];
      secByCode[s.code] = { ch: id, sec: key };
    });
    const definitions = {}; let skipped = 0;
    raw.definitions.forEach(d => {
      if (!(d.term in definitions)) definitions[d.term] = d.def || "";
      d.locs.forEach(code => { const s = secByCode[code]; if (!s) { skipped++; return; }
        const list = chMap[s.ch].sections[s.sec]; if (!list.includes(d.term)) list.push(d.term); });
    });
    const equations = raw.equations.map((e, i) => ({
      id: "e" + i, name: e.name, tex: e.tex || "", text: e.text || "",
      uses: e.locs.map(code => secByCode[code]).filter(Boolean),
    })).filter(e => e.uses.length);
    const bookList = books.map(b => ({ id: b.code, name: b.name, grade: b.grade, chapters: chapters.filter(c => c.bookCode === b.code).map(c => c.id) }));
    if (skipped) console.warn("有 " + skipped + " 個出現位置找不到對應的小節代碼");
    return { books: bookList, chapters, equations, definitions };
  }

  async function loadData() {
    const note = $("#dataNote");
    if (CFG.API_URL) {
      try {
        const r = await fetch(CFG.API_URL + "?action=data");
        const j = await r.json();
        if (j.ok) { note.textContent = "資料更新於 " + new Date(j.data.updatedAt).toLocaleString("zh-TW", { hour12: false }); return j.data; }
      } catch (e) { console.warn(e); }
    }
    const r = await fetch("data-snapshot.json");
    note.textContent = CFG.API_URL ? "目前連不上試算表，顯示的是備份資料" : "顯示的是備份資料";
    return r.json();
  }

  // ---------- Google 登入 ----------
  const auth = { token: null, user: null };
  function decode(jwt) {
    try { return JSON.parse(decodeURIComponent(escape(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))))); } catch (e) { return null; }
  }
  function setToken(t) {
    const p = t && decode(t);
    if (!p || p.exp * 1000 < Date.now() + 60000) { auth.token = null; auth.user = null; }
    else { auth.token = t; auth.user = { name: p.name || p.email, email: p.email, picture: p.picture || "" }; }
    try { t && auth.token ? sessionStorage.setItem("chemIdToken", t) : sessionStorage.removeItem("chemIdToken"); } catch (e) {}
    renderAuth();
    document.dispatchEvent(new CustomEvent("chem-auth"));
  }
  function signOut() {
    try { google.accounts.id.disableAutoSelect(); } catch (e) {}
    setToken(null);
  }
  let gsiReady = false;
  function initGsi() {
    if (gsiReady || !CFG.CLIENT_ID || !window.google || !google.accounts || !google.accounts.id) return gsiReady;
    google.accounts.id.initialize({ client_id: CFG.CLIENT_ID, callback: r => setToken(r.credential), auto_select: true, cancel_on_tap_outside: true });
    gsiReady = true;
    return true;
  }
  function gsiButton(el) {
    el.innerHTML = "";
    if (!CFG.CLIENT_ID) { el.innerHTML = '<span class="note">網站尚未設定 Google 登入</span>'; return; }
    if (!initGsi()) { el.innerHTML = '<span class="note">正在載入 Google 登入…</span>'; setTimeout(() => gsiButton(el), 600); return; }
    google.accounts.id.renderButton(el, { theme: "filled_black", size: "medium", text: "signin_with", shape: "pill", locale: "zh-TW" });
  }
  function renderAuth() {
    const a = $("#authArea");
    if (!a) return;
    if (auth.user) {
      a.innerHTML = `${auth.user.picture ? `<img src="${esc(auth.user.picture)}" alt="" referrerpolicy="no-referrer">` : ""}
        <span>${esc(auth.user.name)}</span>
        <button class="btn small" type="button" id="mineBtn">我的建議</button>
        <button class="btn small" type="button" id="outBtn">登出</button>`;
      $("#mineBtn").onclick = openMine; $("#outBtn").onclick = signOut;
    } else {
      a.innerHTML = '<div id="gsiTop"></div>'; gsiButton($("#gsiTop"));
    }
  }

  // ---------- 對話框 ----------
  document.body.insertAdjacentHTML("beforeend", `
  <dialog id="sugDlg"><form class="dlg" id="sugForm" method="dialog">
    <h3>提供建議</h3>
    <p class="note" style="margin:0">建議會送到站長的後台，由站長決定是否修改。送出需要用 Google 帳號登入。</p>
    <label>類型<select id="sType">
      <option>修改定義</option><option>修改方程式</option><option>新增定義</option><option>新增方程式</option><option>其他</option></select></label>
    <label>對象（詞或方程式名稱）<input id="sTarget" maxlength="120" placeholder="例如：莫耳"></label>
    <div id="sCurWrap" hidden><div class="note" style="margin-bottom:6px">目前內容</div><div class="cur" id="sCur"></div></div>
    <label>你的建議<textarea id="sText" maxlength="2000" required placeholder="寫下建議的內容"></textarea></label>
    <label>理由或出處（選填）<textarea id="sReason" maxlength="1000" placeholder="例如：課本 p.23 的寫法是……"></textarea></label>
    <div id="sLogin"></div>
    <div class="msg" id="sMsg" role="status"></div>
    <div class="row"><button class="btn" type="button" id="sCancel">取消</button><button class="btn primary" type="submit" id="sSubmit">送出建議</button></div>
  </form></dialog>
  <dialog id="mineDlg"><div class="dlg">
    <h3>我的建議</h3><div class="mine" id="mineList"></div>
    <div class="row"><button class="btn" type="button" id="mineClose">關閉</button></div>
  </div></dialog>`);

  const dlg = $("#sugDlg");
  let current = "";
  function openSuggest(type, target, cur) {
    $("#sType").value = type || "其他"; $("#sTarget").value = target || "";
    current = cur || ""; $("#sCur").textContent = current; $("#sCurWrap").hidden = !current;
    $("#sText").value = current; $("#sReason").value = ""; $("#sMsg").textContent = ""; $("#sMsg").className = "msg";
    $("#sSubmit").disabled = false;
    refreshLoginInDialog();
    dlg.showModal();
    setTimeout(() => $("#sText").focus(), 50);
  }
  function refreshLoginInDialog() {
    const box = $("#sLogin");
    if (auth.user) { box.innerHTML = `<span class="note">以 ${esc(auth.user.email)} 送出</span>`; }
    else { box.innerHTML = '<div class="note" style="margin-bottom:6px">請先登入：</div><div id="gsiDlg"></div>'; gsiButton($("#gsiDlg")); }
  }
  document.addEventListener("chem-auth", () => { if (dlg.open) refreshLoginInDialog(); });
  $("#sCancel").onclick = () => dlg.close();
  $("#sugForm").addEventListener("submit", async ev => {
    ev.preventDefault();
    const msg = $("#sMsg");
    if (!auth.user) { msg.className = "msg err"; msg.textContent = "請先用 Google 帳號登入再送出。"; return; }
    const text = $("#sText").value.trim();
    if (!text) { msg.className = "msg err"; msg.textContent = "請寫下建議內容。"; return; }
    if (text === current.trim()) { msg.className = "msg err"; msg.textContent = "建議內容和目前內容一樣，請先修改再送出。"; return; }
    $("#sSubmit").disabled = true; msg.className = "msg"; msg.textContent = "送出中…";
    try {
      await api("suggest", { type: $("#sType").value, target: $("#sTarget").value.trim(), current, suggestion: text, reason: $("#sReason").value.trim() });
      msg.className = "msg ok"; msg.textContent = "已送出，謝謝！站長審核後會在「我的建議」看到結果。";
      setTimeout(() => dlg.close(), 1600);
    } catch (e) {
      $("#sSubmit").disabled = false; msg.className = "msg err";
      msg.textContent = ({ rate_limited: "一小時內送出太多次，請稍後再試。", token_expired: "登入已過期，請重新登入。", bad_token: "登入已過期，請重新登入。", not_configured: "網站尚未設定後端，暫時無法送出。" })[e.message] || "送出失敗，請稍後再試。";
      if (/token/.test(e.message)) signOut();
    }
  });

  async function openMine() {
    const list = $("#mineList"); list.innerHTML = '<span class="note">讀取中…</span>';
    $("#mineDlg").showModal();
    try {
      const { items } = await api("mine", {});
      list.innerHTML = items.length ? items.map(it => `<div class="it">
        <div><span class="pill ${it.status === "已採納" ? "a" : it.status === "不採納" ? "r" : "p"}">${esc(it.status)}</span>　${esc(it.type)}・${esc(it.target || "（未指定）")}　<span class="note">${esc(it.time)}</span></div>
        <div>${esc(it.suggestion)}</div>
        ${it.note ? `<div class="note">站長回覆：${esc(it.note)}</div>` : ""}</div>`).join("") : '<span class="note">還沒有送出過建議。</span>';
    } catch (e) { list.innerHTML = '<span class="note">讀取失敗，請重新登入後再試。</span>'; }
  }
  $("#mineClose").onclick = () => $("#mineDlg").close();

  document.addEventListener("click", ev => {
    const b = ev.target.closest("[data-suggest]");
    if (b) { ev.stopPropagation(); openSuggest(b.dataset.type, b.dataset.target, b.dataset.current); }
  });
  $("#openSuggestGeneral").onclick = () => openSuggest("其他", "", "");

  // ---------- 啟動 ----------
  try { const t = sessionStorage.getItem("chemIdToken"); if (t) setToken(t); } catch (e) {}
  renderAuth();
  window.addEventListener("load", () => { if (!auth.user && initGsi()) { try { google.accounts.id.prompt(); } catch (e) {} } renderAuth(); });
  loadData().then(raw => boot(convert(raw))).catch(err => {
    console.error(err); $("#dataNote").textContent = "資料載入失敗，請重新整理。";
  });
})();
