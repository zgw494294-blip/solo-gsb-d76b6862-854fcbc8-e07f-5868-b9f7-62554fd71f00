/* 透明图层叠序校准台 —— 前端逻辑（原生 JS） */
"use strict";

const MIN_LAYERS = 2, MAX_LAYERS = 7;
const MIN_SAMPLES = 1, MAX_SAMPLES = 4;
const MAX_RELATIONS = 12;

const state = {
  layers: [
    { id: "R", color: "#ff0000", opacity: 0.5 },
    { id: "B", color: "#0000ff", opacity: 0.5 },
  ],
  samples: [
    { background: "#ffffff", target: "#e189bc" },
    { background: "#000000", target: "#bc0089" },
  ],
  relations: [], // {lower, upper}
};

let solveTimer = null;
let lastErrorKey = "";
let inflightToken = 0;

const $ = (sel) => document.querySelector(sel);
const elLayers = $("#layers");
const elSamples = $("#samples");
const elRelations = $("#relations");
const elErrorBanner = $("#errorBanner");
const elErrorList = $("#errorList");
const elResultBody = $("#resultBody");
const elStatus = $("#status");

// ------------------------------------------------------------ 工具函数 --

function normalizeHex(raw) {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (!s) return null;
  if (s[0] !== "#") s = "#" + s;
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    s = "#" + s[1].repeat(2) + s[2].repeat(2) + s[3].repeat(2);
  }
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : null;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function scheduleSolve(delay = 200) {
  clearTimeout(solveTimer);
  solveTimer = setTimeout(runSolve, delay);
  markInferStaleness();
  markSuggestStaleness();
}

// ------------------------------------------------------------ 渲染输入 --

function render() {
  renderLayers();
  renderSamples();
  renderRelations();
  $("#addLayerBtn").disabled = state.layers.length >= MAX_LAYERS;
  $("#addSampleBtn").disabled = state.samples.length >= MAX_SAMPLES;
  $("#addRelationBtn").disabled = state.relations.length >= MAX_RELATIONS;
}

function renderLayers() {
  elLayers.innerHTML = "";
  const idCounts = {};
  state.layers.forEach((l) => {
    const k = l.id.trim();
    if (k) idCounts[k] = (idCounts[k] || 0) + 1;
  });
  const duplicateIds = new Set(
    Object.entries(idCounts).filter(([, n]) => n > 1).map(([k]) => k)
  );
  state.layers.forEach((layer, i) => {
    const validHex = normalizeHex(layer.color);
    const opNum = typeof layer.opacity === "number" ? layer.opacity : NaN;
    const opValid = Number.isFinite(opNum) && opNum >= 0 && opNum <= 1;
    const opValue = opValid ? opNum : "";
    const row = document.createElement("div");
    row.className = "layer-row";
    row.innerHTML = `
      <span class="row-index">${i + 1}</span>
      <input class="id-input ${layer.id && duplicateIds.has(layer.id) ? "invalid" : ""}"
             data-act="layer-id" data-i="${i}" type="text"
             value="${escapeHtml(layer.id)}" placeholder="ID" />
      <input type="color" data-act="layer-picker" data-i="${i}"
             value="${validHex || "#000000"}" title="选色" />
      <input class="hex-input ${validHex ? "" : "invalid"}" data-act="layer-hex" data-i="${i}"
             type="text" value="${escapeHtml(layer.color)}" placeholder="#RRGGBB" />
      <input class="opacity-range" data-act="layer-opacity-range" data-i="${i}"
             type="range" min="0" max="1" step="0.01" value="${opValid ? opNum : 1}" />
      <input class="opacity-input ${opValid ? "" : "invalid"}" data-act="layer-opacity"
             data-i="${i}" type="number" min="0" max="1" step="0.01"
             value="${opValue}" />
      <span class="opacity-val">${opValid ? Math.round(opNum * 100) + "%" : "—"}</span>
      <span class="spacer"></span>
      <button class="btn btn-ghost btn-small" data-act="remove-layer" data-i="${i}"
              type="button" ${state.layers.length <= MIN_LAYERS ? "disabled" : ""}>删除</button>
    `;
    elLayers.appendChild(row);
  });
}

function renderSamples() {
  elSamples.innerHTML = "";
  state.samples.forEach((smp, i) => {
    const bg = normalizeHex(smp.background);
    const tg = normalizeHex(smp.target);
    const row = document.createElement("div");
    row.className = "sample-row";
    row.innerHTML = `
      <span class="row-index">${i + 1}</span>
      <span class="field-label">背景
        <input type="color" data-act="sample-bg-picker" data-i="${i}"
               value="${bg || "#000000"}" />
        <input class="hex-input" data-act="sample-bg" data-i="${i}" type="text"
               value="${escapeHtml(smp.background)}" placeholder="#RRGGBB" />
      </span>
      <span class="field-label">目标
        <input type="color" data-act="sample-target-picker" data-i="${i}"
               value="${tg || "#000000"}" />
        <input class="hex-input" data-act="sample-target" data-i="${i}" type="text"
               value="${escapeHtml(smp.target)}" placeholder="#RRGGBB" />
      </span>
      <span class="spacer"></span>
      <button class="btn btn-ghost btn-small" data-act="remove-sample" data-i="${i}"
              type="button" ${state.samples.length <= MIN_SAMPLES ? "disabled" : ""}>删除</button>
    `;
    elSamples.appendChild(row);
  });
}

function renderRelations() {
  elRelations.innerHTML = "";
  if (state.relations.length === 0) {
    const empty = document.createElement("div");
    empty.className = "result-empty";
    empty.textContent = "暂无约束（任意图层顺序均可参与择优）。";
    elRelations.appendChild(empty);
    return;
  }
  const options = state.layers
    .map((l) => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.id)}</option>`)
    .join("");
  state.relations.forEach((rel, i) => {
    const row = document.createElement("div");
    row.className = "relation-row";
    row.innerHTML = `
      <select data-act="rel-lower" data-i="${i}">
        ${optionWith(options, rel.lower)}
      </select>
      <span class="relation-arrow">在更下方 ▲ 叠在</span>
      <select data-act="rel-upper" data-i="${i}">
        ${optionWith(options, rel.upper)}
      </select>
      <span class="relation-arrow">之上</span>
      <span class="spacer"></span>
      <button class="btn btn-ghost btn-small" data-act="remove-relation" data-i="${i}"
              type="button">删除</button>
    `;
    elRelations.appendChild(row);
  });
}

// select 选项无法靠内部标记 selected，重写一份带 selected 的
function optionWith(allOptions, selectedId) {
  if (!state.layers.some((l) => l.id === selectedId)) {
    return `<option value="" selected>（请选择）</option>${allOptions}`;
  }
  return state.layers
    .map(
      (l) =>
        `<option value="${escapeHtml(l.id)}"${l.id === selectedId ? " selected" : ""}>${escapeHtml(
          l.id
        )}</option>`
    )
    .join("");
}

// ------------------------------------------------------------ 事件代理 --

document.addEventListener("input", (e) => {
  const t = e.target;
  const act = t.dataset.act;
  if (!act) return;
  const i = Number(t.dataset.i);

  switch (act) {
    case "layer-id":
      state.layers[i].id = t.value;
      renderRelationsKeepFocus(t);
      scheduleSolve();
      break;
    case "layer-hex":
      state.layers[i].color = t.value;
      syncPicker(t, "layer-picker", i, t.value);
      t.classList.toggle("invalid", normalizeHex(t.value) === null);
      scheduleSolve();
      break;
    case "layer-picker":
      state.layers[i].color = t.value.toLowerCase();
      syncTextInput("layer-hex", i, t.value.toLowerCase());
      scheduleSolve();
      break;
    case "layer-opacity": {
      const v = parseFloat(t.value);
      state.layers[i].opacity = Number.isNaN(v) ? t.value : v;
      if (typeof state.layers[i].opacity === "number" &&
          state.layers[i].opacity >= 0 && state.layers[i].opacity <= 1) {
        syncRange(i, state.layers[i].opacity);
      }
      scheduleSolve();
      break;
    }
    case "layer-opacity-range":
      state.layers[i].opacity = parseFloat(t.value);
      syncNumberInput(i, state.layers[i].opacity);
      scheduleSolve();
      break;
    case "sample-bg":
    case "sample-target": {
      const key = act === "sample-bg" ? "background" : "target";
      state.samples[i][key] = t.value;
      syncPicker(t, act + "-picker", i, t.value);
      t.classList.toggle("invalid", normalizeHex(t.value) === null);
      scheduleSolve();
      break;
    }
    case "sample-bg-picker":
      state.samples[i].background = t.value.toLowerCase();
      syncTextInput("sample-bg", i, t.value.toLowerCase());
      scheduleSolve();
      break;
    case "sample-target-picker":
      state.samples[i].target = t.value.toLowerCase();
      syncTextInput("sample-target", i, t.value.toLowerCase());
      scheduleSolve();
      break;
    case "rel-lower":
      state.relations[i].lower = t.value;
      scheduleSolve();
      break;
    case "rel-upper":
      state.relations[i].upper = t.value;
      scheduleSolve();
      break;
  }
});

function syncPicker(textEl, pickerAct, i, raw) {
  const hx = normalizeHex(raw);
  const picker = document.querySelector(`input[data-act="${pickerAct}"][data-i="${i}"]`);
  if (picker && hx) picker.value = hx;
}
function syncTextInput(act, i, value) {
  const el = document.querySelector(`input[data-act="${act}"][data-i="${i}"]`);
  if (el && el.value !== value) {
    el.value = value;
    el.classList.remove("invalid");
  }
}
function syncRange(i, value) {
  const el = document.querySelector(`input[data-act="layer-opacity-range"][data-i="${i}"]`);
  if (el) el.value = value;
  const val = document.querySelectorAll(".layer-row")[i]?.querySelector(".opacity-val");
  if (val) val.textContent = Math.round(value * 100) + "%";
}
function syncNumberInput(i, value) {
  const el = document.querySelector(`input[data-act="layer-opacity"][data-i="${i}"]`);
  if (el && parseFloat(el.value) !== value) el.value = value;
  const val = document.querySelectorAll(".layer-row")[i]?.querySelector(".opacity-val");
  if (val) val.textContent = Math.round(value * 100) + "%";
}

// ID 文本框输入时只重建关系下拉，避免打断图层区输入焦点
function renderRelationsKeepFocus(activeEl) {
  const activeStart = activeEl.selectionStart;
  const activeEnd = activeEl.selectionEnd;
  renderRelations();
  activeEl.focus();
  try {
    activeEl.setSelectionRange(activeStart, activeEnd);
  } catch (_) { /* ignore */ }
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  const i = Number(btn.dataset.i);

  if (act === "add-layer" && state.layers.length < MAX_LAYERS) {
    state.layers.push({ id: uniqueId("L"), color: "#808080", opacity: 0.5 });
    render();
    scheduleSolve(0);
  } else if (act === "remove-layer" && state.layers.length > MIN_LAYERS) {
    const removed = state.layers[i].id.trim();
    state.layers.splice(i, 1);
    state.relations = state.relations.filter(
      (r) => r.lower.trim() !== removed && r.upper.trim() !== removed
    );
    render();
    scheduleSolve(0);
  } else if (act === "add-sample" && state.samples.length < MAX_SAMPLES) {
    state.samples.push({ background: "#ffffff", target: "#ffffff" });
    render();
    scheduleSolve(0);
  } else if (act === "remove-sample" && state.samples.length > MIN_SAMPLES) {
    state.samples.splice(i, 1);
    render();
    scheduleSolve(0);
  } else if (act === "add-relation" && state.relations.length < MAX_RELATIONS) {
    const first = state.layers[0]?.id || "";
    const second = state.layers[1]?.id || first;
    state.relations.push({ lower: first, upper: second });
    render();
    scheduleSolve(0);
  } else if (act === "remove-relation") {
    state.relations.splice(i, 1);
    render();
    scheduleSolve(0);
  }
});

let idCounter = 0;
function uniqueId(prefix) {
  let candidate;
  do {
    idCounter += 1;
    candidate = `${prefix}${idCounter}`;
  } while (state.layers.some((l) => l.id === candidate));
  return candidate;
}

// ------------------------------------------------------------ 调用后端 --

async function runSolve() {
  const payload = {
    layers: state.layers.map((l) => ({
      id: l.id,
      color: l.color,
      opacity: l.opacity,
    })),
    samples: state.samples.map((s) => ({
      background: s.background,
      target: s.target,
    })),
    relations: state.relations.map((r) => ({ lower: r.lower, upper: r.upper })),
  };

  const token = ++inflightToken;
  elStatus.textContent = "计算中…";
  elStatus.className = "status busy";

  try {
    const resp = await fetch("/api/solve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (token !== inflightToken) return; // 已有更新的请求，丢弃旧结果
    const data = await resp.json();
    if (!resp.ok) {
      showErrors(data.errors || [{ scope: "form", message: "求解失败" }]);
    } else {
      showErrors([]);
      renderResult(data);
    }
  } catch (err) {
    if (token !== inflightToken) return;
    showErrors([{ scope: "form", message: "无法连接计算服务：" + err.message }]);
  }
}

function showErrors(errors) {
  const key = JSON.stringify(errors);
  if (key === lastErrorKey) {
    // 内容不变时只更新状态文字，不重绘
    if (errors.length) {
      elStatus.textContent = "存在输入错误";
      elStatus.className = "status";
    }
    return;
  }
  lastErrorKey = key;

  if (!errors.length) {
    elErrorBanner.hidden = true;
    elErrorList.innerHTML = "";
    return;
  }
  elErrorList.innerHTML = errors
    .map((er) => `<li>${escapeHtml(er.message)}</li>`)
    .join("");
  elErrorBanner.hidden = false;
  elStatus.textContent = "存在输入错误";
  elStatus.className = "status";
  elResultBody.innerHTML = `<div class="result-empty">修正输入后将自动重新计算。</div>`;
  $("#inferCard").hidden = true;
  $("#suggestCard").hidden = true;
}

// ------------------------------------------------------------ 结果渲染 --

function renderResult(r) {
  elStatus.textContent = "";
  elStatus.className = "status";

  const chips = r.order
    .map((id, k) => {
      const layer = r.layers[k];
      const rgba = hexToRgba(layer.color, layer.opacity);
      return `
        <span class="chip">
          <span class="dot" style="background:${rgba}" title="${escapeHtml(id)}"></span>
          <span class="cid">${escapeHtml(id)}</span>
          <span class="cop">α=${Number(layer.opacity.toFixed(2))}</span>
        </span>`;
    })
    .join('<span class="order-sep">↑</span>');

  const body = `
    <div class="order-panel">
      <div class="order-title">最优叠放顺序（底 → 顶）</div>
      <div class="checker">
        <div class="order-chips">
          <span class="order-ends">底</span>
          ${chips}
          <span class="order-ends">↑ 顶</span>
        </div>
      </div>
      <div class="metric-row">
        <span>总平方误差（未取整 0–255 通道）：<b>${fmtSse(r.totalSse)}</b></span>
        <span>枚举排列：<b>${r.permutationsChecked}</b> 个</span>
        <span>满足约束：<b>${r.feasibleCount}</b> 个</span>
        <span>同分时按 ID 字典序决胜</span>
      </div>
    </div>
    ${r.samples.map(renderSample).join("")}
  `;
  elResultBody.innerHTML = body;
  syncInferPanel(r);
}

function renderSample(s) {
  const targetRgb = s.targetRgb.map((v) => Math.round(v)).join(", ");
  const predRgb = s.predictedRgb.map((v) => Math.round(v)).join(", ");
  const [cr, cg, cb] = s.channelSse;
  const rating =
    s.sse < 1 ? "r-good" : s.sse < 100 ? "r-mid" : "r-bad";
  return `
    <div class="sample-result">
      <div class="sample-result-head">
        <span>样本 ${s.index + 1}</span>
        <span class="${rating}">SSE = ${fmtSse(s.sse)}</span>
      </div>
      <div class="compare">
        <div class="swatch-box">
          <span class="swatch-big" style="background:${s.target}"></span>
          <span class="swatch-meta">
            <div class="name">目标色</div>
            <div class="hexval">${s.target}</div>
            <div class="name">rgb(${targetRgb})</div>
          </span>
        </div>
        <div class="compare-arrow">→</div>
        <div class="swatch-box">
          <span class="swatch-big" style="background:${s.predictedHex}"></span>
          <span class="swatch-meta">
            <div class="name">预测色</div>
            <div class="hexval">${s.predictedHex}</div>
            <div class="name">rgb(${predRgb})</div>
          </span>
        </div>
      </div>
      <div class="bg-note">
        <span class="mini" style="background:${s.background}"></span>
        在背景 ${s.background} 上叠放
      </div>
      <div class="sse-line">
        <span class="sse-chan">R²误差 ${fmtSse(cr)}</span>
        <span class="sse-chan">G²误差 ${fmtSse(cg)}</span>
        <span class="sse-chan">B²误差 ${fmtSse(cb)}</span>
      </div>
    </div>
  `;
}

function hexToRgba(hex, alpha) {
  const h = normalizeHex(hex) || "#000000";
  const r = parseInt(h.slice(1, 3), 16);
  const g = parseInt(h.slice(3, 5), 16);
  const b = parseInt(h.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function fmtSse(v) {
  if (v === 0) return "0";
  if (v < 0.001) return v.toExponential(3);
  return Number(v.toFixed(4)).toString();
}

// 网格值（0.01 整数倍）显示为两位小数；原始参数组入选时保留必要精度
function fmtOpacity(v) {
  if (Math.abs(v - Math.round(v * 100) / 100) < 1e-9) return Number(v.toFixed(2)).toString();
  return String(v);
}

// ============================================================ 不透明度反推 ==

const inferState = {
  order: [],          // 当前确认顺序（ID 数组）
  picks: new Set(),   // 勾选的待调 ID
  result: null,       // 最近一次成功返回
  resultKey: "",      // 结果产生时的输入指纹
  appliedSig: "",     // 上一次点「应用」之后的输入指纹（与当前一致则结果仍代表现状）
  applied: false,     // 当前结果是否已写回图层
};

let orderSlotBefore = "";

const elInferCard = $("#inferCard");
const elInferOrder = $("#inferOrder");
const elInferPick = $("#inferPick");
const elInferHint = $("#inferHint");
const elInferErrors = $("#inferErrors");
const elInferResult = $("#inferResult");
const elInferStatus = $("#inferStatus");

function inferSignature() {
  // 用于判断已有反推结果是否对应当前输入
  return JSON.stringify({
    layers: state.layers,
    samples: state.samples,
    relations: state.relations,
    order: inferState.order,
    picks: [...inferState.picks].sort(),
  });
}

function syncInferPanel(solveResult) {
  elInferCard.hidden = false;
  $("#suggestCard").hidden = false;
  const idSig = state.layers.map((l) => l.id).join("");
  const layerSet = new Set(state.layers.map((l) => l.id));

  if (inferState._idSig !== idSig) {
    // 图层集合（ID 列表）变化：重建顺序与勾选，默认采用求解顺序
    inferState._idSig = idSig;
    inferState.order = [...solveResult.order];
    inferState.picks = new Set();
    inferState.result = null;
    inferState.resultKey = "";
    inferState.appliedSig = "";
    inferState.applied = false;
    elInferResult.innerHTML = "";
    elInferErrors.hidden = true;
  } else {
    // 集合未变：把求解新出现、但当前顺序未包含的 ID 补齐（防御性）
    inferState.order = inferState.order.filter((id) => layerSet.has(id));
    solveResult.order.forEach((id) => {
      if (!inferState.order.includes(id)) inferState.order.push(id);
    });
    inferState.picks = new Set([...inferState.picks].filter((id) => layerSet.has(id)));
  }
  renderInferControls();
  markInferStaleness();
}

function layerById(id) {
  return state.layers.find((l) => l.id === id);
}

function renderInferControls() {
  // ---- 顺序槽 ----
  elInferOrder.innerHTML = "";
  inferState.order.forEach((id, pos) => {
    const layer = layerById(id);
    const hex = (layer && normalizeHex(layer.color)) || "#000000";
    const op = layer && Number.isFinite(layer.opacity) ? layer.opacity : null;
    const slot = document.createElement("span");
    slot.className = "order-slot";
    slot.innerHTML = `
      <select data-act="infer-order" data-pos="${pos}" title="该位置（底 → 顶第 ${pos + 1} 层）的图层">
        ${state.layers
          .map(
            (l) =>
              `<option value="${escapeHtml(l.id)}"${l.id === id ? " selected" : ""}>${escapeHtml(
                l.id
              )}</option>`
          )
          .join("")}
      </select>
      <span class="mini-dot" style="background:${hexToRgba(hex, op == null ? 1 : op)}"></span>
      <span class="mini-op">${op == null ? "α 非法" : "α=" + Number(op.toFixed(2))}</span>
    `;
    elInferOrder.appendChild(slot);
    if (pos < inferState.order.length - 1) {
      const ar = document.createElement("span");
      ar.className = "infer-arrow";
      ar.textContent = "↑";
      elInferOrder.appendChild(ar);
    }
  });

  // ---- 待调勾选 ----
  elInferPick.innerHTML = "";
  state.layers.forEach((l) => {
    const hex = normalizeHex(l.color) || "#000000";
    const checked = inferState.picks.has(l.id);
    const disabled = !checked && inferState.picks.size >= 2;
    const label = document.createElement("label");
    label.className = "pick-item" + (disabled ? " disabled" : "");
    label.innerHTML = `
      <input type="checkbox" data-act="infer-pick" data-id="${escapeHtml(l.id)}"
             ${checked ? "checked" : ""} ${disabled ? "disabled" : ""} />
      <span class="pick-dot" style="background:${hexToRgba(hex, l.opacity)}"></span>
      <span>${escapeHtml(l.id)}</span>
    `;
    elInferPick.appendChild(label);
  });

  updateInferRunHint();
  markInferStaleness();
}

function updateInferRunHint() {
  const btn = $("#inferRunBtn");
  const n = inferState.picks.size;
  btn.disabled = n < 1 || n > 2;
  elInferHint.textContent =
    n === 0 ? "请勾选 1～2 个待调图层" : `已选 ${n} 个，将在 0.00～1.00（步长 0.01）网格上联合反推`;
}

function markInferStaleness() {
  if (!inferState.result) return;
  const sig = inferSignature();
  // 结果产生时、或上次应用建议值之后的状态，都视为与当前结果一致
  const fresh = sig === inferState.resultKey || sig === inferState.appliedSig;
  inferState.applied = inferState.applied && fresh;
  const old = elInferResult.querySelector(".stale-note");
  if (!fresh && !old) {
    const note = document.createElement("div");
    note.className = "stale-note";
    note.textContent = "输入或选择已变化，以下结果可能过期，请重新反推。";
    elInferResult.prepend(note);
  } else if (fresh && old) {
    old.remove();
  }
}

// 结果是否仍代表当前输入；false 时「应用」按钮应可重新点击
function inferResultFresh() {
  if (!inferState.result) return false;
  const sig = inferSignature();
  return sig === inferState.resultKey || sig === inferState.appliedSig;
}

document.addEventListener("change", (e) => {
  const t = e.target;
  const act = t.dataset.act;
  if (act === "infer-order") {
    const pos = Number(t.dataset.pos);
    const prev = orderSlotBefore;
    // 与原占据新 ID 的槽位交换，保证顺序始终是全部图层的一个排列
    const other = inferState.order.findIndex((id, p) => p !== pos && id === t.value);
    inferState.order[pos] = t.value;
    if (other !== -1 && prev) inferState.order[other] = prev;
    renderInferControls();
  } else if (act === "infer-pick") {
    const id = t.dataset.id;
    if (t.checked) inferState.picks.add(id);
    else inferState.picks.delete(id);
    renderInferControls();
  }
});

// select change 前记录原值，供交换使用
document.addEventListener("focusin", (e) => {
  if (e.target.dataset && e.target.dataset.act === "infer-order") {
    const pos = Number(e.target.dataset.pos);
    orderSlotBefore = inferState.order[pos];
  }
});

document.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  if (btn.dataset.act === "infer-run") runInfer();
  if (btn.dataset.act === "infer-apply") applyInferResult();
});

async function runInfer() {
  const payload = {
    layers: state.layers.map((l) => ({ id: l.id, color: l.color, opacity: l.opacity })),
    samples: state.samples.map((s) => ({ background: s.background, target: s.target })),
    relations: state.relations.map((r) => ({ lower: r.lower, upper: r.upper })),
    order: inferState.order,
    adjustIds: [...inferState.picks].sort(),
  };
  elInferStatus.textContent = "反推中…";
  elInferStatus.className = "status busy";
  elInferErrors.hidden = true;

  try {
    const resp = await fetch("/api/infer-opacity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    elInferStatus.textContent = "";
    elInferStatus.className = "status";
    if (!resp.ok) {
      showInferErrors(data.errors || [{ scope: "form", message: "反推失败" }]);
      return;
    }
    inferState.result = data;
    inferState.resultKey = inferSignature();
    inferState.applied = false;
    renderInferResult(data);
  } catch (err) {
    elInferStatus.textContent = "";
    elInferStatus.className = "status";
    showInferErrors([{ scope: "form", message: "无法连接计算服务：" + err.message }]);
  }
}

function showInferErrors(errors) {
  elInferErrors.innerHTML =
    '<ul>' + errors.map((er) => `<li>${escapeHtml(er.message)}</li>`).join("") + "</ul>";
  elInferErrors.hidden = false;
}

function renderInferResult(r) {
  const delta = r.afterTotalSse - r.beforeTotalSse;
  const deltaCls = delta < -1e-9 ? "sse-delta-down" : delta > 1e-9 ? "sse-delta-up" : "";
  const deltaTxt =
    Math.abs(delta) < 1e-9 ? "持平" : `${delta > 0 ? "+" : "−"}${fmtSse(Math.abs(delta))}`;

  const rows = r.adjustments
    .map((a) => {
      const changed =
        Math.abs(a.originalOpacity - a.suggestedOpacity) > 1e-9;
      return `
        <tr>
          <td>${escapeHtml(a.id)}</td>
          <td class="num">${fmtOpacity(a.originalOpacity)}</td>
          <td class="op-arrow">→</td>
          <td class="num ${changed ? "op-new" : "op-same"}">
            ${fmtOpacity(a.suggestedOpacity)}${changed ? "" : "（原值即最优）"}
          </td>
        </tr>`;
    })
    .join("");

  const samples = r.afterSamples
    .map((s, k) => renderInferSample(s, r.beforeSamples[k]))
    .join("");

  const applied = inferResultFresh() && inferState.applied;
  elInferResult.innerHTML = `
    <table class="adj-table">
      <thead><tr><th>待调图层</th><th>原不透明度</th><th></th><th>建议不透明度</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="sse-compare">
      <span>调整前总误差：<b>${fmtSse(r.beforeTotalSse)}</b></span>
      <span class="after">调整后总误差：<b>${fmtSse(r.afterTotalSse)}</b></span>
      <span class="${deltaCls}">变化：<b>${deltaTxt}</b></span>
      <span>评估组合：<b>${r.combosChecked}</b> 组（含原始参数组）</span>
    </div>
    ${samples}
    <div class="infer-apply-row">
      <button class="btn btn-small" data-act="infer-apply" type="button"
              ${applied ? "disabled" : ""}>应用建议值回图层并重新求解</button>
      ${applied ? '<span class="applied-note">已应用，左侧图层与上方校准结果已更新。</span>' : ""}
    </div>
  `;
}

function renderInferSample(after, before) {
  return `
    <div class="sample-result">
      <div class="sample-result-head">
        <span>样本 ${after.index + 1}</span>
        <span class="hint">背景 ${after.background}</span>
      </div>
      <div class="tri-compare">
        ${triCell("目标色", after.target, after.targetRgb, null)}
        <span class="tri-arrow">→</span>
        ${triCell("调整前预测", before.predictedHex, before.predictedRgb, before.sse)}
        <span class="tri-arrow">→</span>
        ${triCell("调整后预测", after.predictedHex, after.predictedRgb, after.sse)}
      </div>
    </div>
  `;
}

function triCell(tag, hex, rgb, sse) {
  const rgbTxt = rgb.map((v) => Math.round(v)).join(", ");
  return `
    <div class="tri-cell">
      <div class="cell-tag">
        <span>${tag}</span>
        ${sse == null ? "" : `<span class="tag-sse">SSE ${fmtSse(sse)}</span>`}
      </div>
      <div class="tri-swatch">
        <span class="swatch-big" style="background:${hex}"></span>
        <span>
          <div class="hexval">${hex}</div>
          <div class="name">rgb(${rgbTxt})</div>
        </span>
      </div>
    </div>
  `;
}

function applyInferResult() {
  const r = inferState.result;
  if (!r) return;
  r.adjustments.forEach((a) => {
    const layer = state.layers.find((l) => l.id === a.id);
    if (layer) layer.opacity = a.suggestedOpacity;
  });
  // 记录应用后的状态指纹：在再次改动输入前，结果始终代表当前图层
  inferState.applied = true;
  inferState.appliedSig = inferSignature();
  renderInferResult(inferState.result);
  render();
  runSolve();
}

// ============================================================ 下一次背景测量建议 ==

const MIN_CANDIDATES = 2, MAX_CANDIDATES = 12;

const suggestState = {
  candidates: ["#808080", "#ffff00"], // 候选背景 HEX 原文
  tolerance: "100",                   // 容差原文（数字框）
  result: null,
  resultKey: "",                      // 结果产生时的输入指纹
};

const elSuggestCandidates = $("#suggestCandidates");
const elSuggestTolerance = $("#suggestTolerance");
const elSuggestErrors = $("#suggestErrors");
const elSuggestResult = $("#suggestResult");
const elSuggestStatus = $("#suggestStatus");

function suggestSignature() {
  // 输入（图层 / 样本 / 关系 / 候选 / 容差）指纹；变化后旧建议即失效
  return JSON.stringify({
    layers: state.layers,
    samples: state.samples,
    relations: state.relations,
    candidates: suggestState.candidates,
    tolerance: suggestState.tolerance,
  });
}

function candidateNorms() {
  // 返回每行的规范化结果（非法为 null）与「规范化后重复」集合
  const norms = suggestState.candidates.map((raw) => normalizeHex(raw));
  const counts = new Map();
  norms.forEach((h) => { if (h) counts.set(h, (counts.get(h) || 0) + 1); });
  const dup = new Set([...counts.entries()].filter(([, n]) => n > 1).map(([h]) => h));
  return { norms, dup };
}

function renderSuggestControls() {
  elSuggestCandidates.innerHTML = "";
  suggestState.candidates.forEach((raw, i) => {
    const row = document.createElement("div");
    row.className = "candidate-row";
    row.innerHTML = `
      <span class="row-index">${i + 1}</span>
      <input type="color" data-act="candidate-picker" data-i="${i}"
             value="${normalizeHex(raw) || "#000000"}" title="选色" />
      <input class="hex-input" data-act="candidate-hex"
             data-i="${i}" type="text" value="${escapeHtml(raw)}" placeholder="#RRGGBB" />
      <span class="spacer"></span>
      <button class="btn btn-ghost btn-small" data-act="remove-candidate" data-i="${i}"
              type="button">删除</button>
    `;
    elSuggestCandidates.appendChild(row);
  });
  refreshCandidateValidity();
}

// 不重建行，仅刷新非法/重复标记与增删按钮可用性（避免输入时丢焦点）
function refreshCandidateValidity() {
  const { norms, dup } = candidateNorms();
  elSuggestCandidates.querySelectorAll(".candidate-row").forEach((row, i) => {
    const invalid = norms[i] === null || dup.has(norms[i]);
    row.querySelector('[data-act="candidate-hex"]').classList.toggle("invalid", invalid);
  });
  $("#addCandidateBtn").disabled = suggestState.candidates.length >= MAX_CANDIDATES;
  const atMin = suggestState.candidates.length <= MIN_CANDIDATES;
  elSuggestCandidates.querySelectorAll('[data-act="remove-candidate"]').forEach((btn) => {
    btn.disabled = atMin;
  });

  const tNum = parseFloat(suggestState.tolerance);
  const tolValid = Number.isFinite(tNum) && tNum >= 0;
  elSuggestTolerance.classList.toggle("invalid", !tolValid);
}

function markSuggestStaleness() {
  if (!suggestState.result) return;
  const fresh = suggestSignature() === suggestState.resultKey;
  const old = elSuggestResult.querySelector(".stale-note");
  if (!fresh && !old) {
    const note = document.createElement("div");
    note.className = "stale-note";
    note.textContent = "输入或候选已变化，以下建议基于旧输入，请重新生成。";
    elSuggestResult.prepend(note);
  } else if (fresh && old) {
    old.remove();
  }
}

function suggestResultFresh() {
  return !!suggestState.result && suggestSignature() === suggestState.resultKey;
}

// 候选项的增删与输入（与图层区同样的事件代理）
document.addEventListener("input", (e) => {
  const t = e.target;
  const act = t.dataset.act;
  if (act === "candidate-hex") {
    const i = Number(t.dataset.i);
    suggestState.candidates[i] = t.value;
    const norm = normalizeHex(t.value);
    const picker = elSuggestCandidates.querySelector(`[data-act="candidate-picker"][data-i="${i}"]`);
    if (picker && norm) picker.value = norm;
    refreshCandidateValidity();
    markSuggestStaleness();
  } else if (act === "candidate-picker") {
    const i = Number(t.dataset.i);
    suggestState.candidates[i] = t.value.toLowerCase();
    const textEl = elSuggestCandidates.querySelector(`[data-act="candidate-hex"][data-i="${i}"]`);
    if (textEl && textEl.value !== t.value.toLowerCase()) {
      textEl.value = t.value.toLowerCase();
    }
    refreshCandidateValidity();
    markSuggestStaleness();
  }
});

elSuggestTolerance.addEventListener("input", () => {
  suggestState.tolerance = elSuggestTolerance.value;
  const tNum = parseFloat(suggestState.tolerance);
  const tolValid = Number.isFinite(tNum) && tNum >= 0;
  elSuggestTolerance.classList.toggle("invalid", !tolValid);
  markSuggestStaleness();
});

document.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === "add-candidate" && suggestState.candidates.length < MAX_CANDIDATES) {
    suggestState.candidates.push("#ffffff");
    renderSuggestControls();
    markSuggestStaleness();
  } else if (act === "remove-candidate" && suggestState.candidates.length > MIN_CANDIDATES) {
    suggestState.candidates.splice(Number(btn.dataset.i), 1);
    renderSuggestControls();
    markSuggestStaleness();
  } else if (act === "suggest-run") {
    runSuggest();
  }
});

function validateSuggestInputs() {
  const errs = [];
  const raws = suggestState.candidates;
  if (!(MIN_CANDIDATES <= raws.length && raws.length <= MAX_CANDIDATES)) {
    errs.push(`候选背景必须为 ${MIN_CANDIDATES}～${MAX_CANDIDATES} 个，当前 ${raws.length} 个`);
  }
  const seen = new Set();
  raws.forEach((raw, i) => {
    const norm = normalizeHex(raw);
    if (norm === null) {
      errs.push(`第 ${i + 1} 个候选背景色非法：${String(raw).trim() || "（空）"}，需要形如 #RRGGBB 的 HEX 值`);
    } else if (seen.has(norm)) {
      errs.push(`第 ${i + 1} 个候选背景色重复：${norm}（规范化后与前面的候选相同）`);
    } else {
      seen.add(norm);
    }
  });
  const tNum = parseFloat(suggestState.tolerance);
  if (!Number.isFinite(tNum) || tNum < 0) {
    errs.push("误差容差必须是非负有限数字");
  }
  return errs;
}

async function runSuggest() {
  const errs = validateSuggestInputs();
  if (errs.length) {
    showSuggestErrors(errs);
    return;
  }
  elSuggestErrors.hidden = true;
  elSuggestStatus.textContent = "评估中…";
  elSuggestStatus.className = "status busy";

  const payload = {
    layers: state.layers.map((l) => ({ id: l.id, color: l.color, opacity: l.opacity })),
    samples: state.samples.map((s) => ({ background: s.background, target: s.target })),
    relations: state.relations.map((r) => ({ lower: r.lower, upper: r.upper })),
    candidateBackgrounds: suggestState.candidates.map((c) => normalizeHex(c) || c),
    tolerance: parseFloat(suggestState.tolerance),
  };

  try {
    const resp = await fetch("/api/suggest-background", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    elSuggestStatus.textContent = "";
    elSuggestStatus.className = "status";
    if (!resp.ok) {
      showSuggestErrors((data.errors || [{ message: "生成建议失败" }]).map((er) => er.message));
      return;
    }
    suggestState.result = data;
    suggestState.resultKey = suggestSignature();
    renderSuggestResult(data);
  } catch (err) {
    elSuggestStatus.textContent = "";
    elSuggestStatus.className = "status";
    showSuggestErrors(["无法连接计算服务：" + err.message]);
  }
}

function showSuggestErrors(messages) {
  elSuggestErrors.innerHTML = "<ul>" + messages.map((m) => `<li>${escapeHtml(m)}</li>`).join("") + "</ul>";
  elSuggestErrors.hidden = false;
}

function renderSuggestResult(r) {
  elSuggestErrors.hidden = true;
  const stale = suggestResultFresh()
    ? ""
    : '<div class="stale-note">输入或候选已变化，以下建议基于旧输入，请重新生成。</div>';

  const truncNote = r.withinToleranceCount > r.ordersShown
    ? `（按总误差、ID 序列取前 ${r.ordersShown} 条）`
    : "";
  const summary = `
    <div class="suggest-summary">
      <span>最优总误差：<b>${fmtSse(r.bestTotalSse)}</b></span>
      <span>容差：<b>${fmtSse(r.tolerance)}</b></span>
      <span>阈值：<b>${fmtSse(r.threshold)}</b></span>
      <span>符合容差的顺序：<b>${r.withinToleranceCount}</b> / ${r.feasibleCount} 条 ${truncNote}</span>
    </div>`;

  const ordersTable = renderOrdersTable(r.orders);

  let body;
  if (!r.needExtraMeasurement) {
    body = `
      ${stale}
      ${summary}
      <div class="suggest-none">
        容差范围内只有 ${r.withinToleranceCount} 条合规叠序，当前样本已足以确定顺序，<b>无需追加测量</b>。
      </div>
      <div class="infer-field-label">候选背景（未打分，得分仅在存在两条以上待区分顺序时才有意义）</div>
      ${renderCandidateTable(r.candidates, null)}`;
  } else {
    body = `
      ${stale}
      ${summary}
      <div class="suggest-reco">
        建议下一次在背景
        <span class="reco-swatch" style="background:${r.recommendedBackground}"></span>
        <b class="mono">${r.recommendedBackground}</b>
        上测量（得分 <b class="mono">${fmtSse(r.recommendedScore)}</b>，
        为该背景上任意两顺序预测色的最小未取整 RGB 平方距离，越大越易区分；同分按 HEX 字典序）。
      </div>
      ${renderHardestPair(r.hardestPair)}
      <div class="infer-field-label">各候选背景得分（任意两条顺序预测色的最小未取整 RGB 平方距离，越大越好）</div>
      ${renderCandidateTable(r.candidates, r.recommendedBackground)}
      ${ordersTable}`;
  }
  elSuggestResult.innerHTML = body;
}

function renderHardestPair(hp) {
  return `
    <div class="hardest-pair">
      <div class="hardest-title">推荐背景上最难区分的一对顺序（第 ${hp.orderRanks[0]} / ${hp.orderRanks[1]} 条，平方距离 ${fmtSse(hp.distance)}）</div>
      <div class="tri-compare">
        ${hardestCell("顺序 " + hp.orderRanks[0] + "：" + hp.orderA.join(" → "),
                      hp.predictedAHex, hp.predictedA)}
        <span class="tri-arrow">vs</span>
        ${hardestCell("顺序 " + hp.orderRanks[1] + "：" + hp.orderB.join(" → "),
                      hp.predictedBHex, hp.predictedB)}
      </div>
    </div>`;
}

function hardestCell(tag, hex, rgb255) {
  const rgbTxt = rgb255.map((v) => v.toFixed(2)).join(", ");
  const rgbRound = rgb255.map((v) => Math.round(v)).join(", ");
  return `
    <div class="tri-cell">
      <div class="cell-tag"><span>${escapeHtml(tag)}</span></div>
      <div class="tri-swatch">
        <span class="swatch-big" style="background:${hex}"></span>
        <span>
          <div class="hexval">${hex}</div>
          <div class="name">rgb(${rgbTxt}) 未取整</div>
          <div class="name">rgb(${rgbRound})</div>
        </span>
      </div>
    </div>`;
}

function renderCandidateTable(candidates, recommended) {
  // 展示顺序：得分由高到低，同分按 HEX 字典序；无需测量时 score 为 null，按 HEX 排
  const rows = candidates
    .slice()
    .sort((x, y) => (x.score == null || y.score == null
      ? x.background.localeCompare(y.background)
      : y.score - x.score || x.background.localeCompare(y.background)))
    .map((c) => {
      const hp = c.hardestPair;
      const isRec = c.background === recommended;
      const scoreTxt = c.score == null ? "—" : fmtSse(c.score);
      const pairTxt = hp ? `第 ${hp.orderRanks[0]} / ${hp.orderRanks[1]} 条（距离 ${fmtSse(hp.distance)}）` : "—";
      return `
        <tr class="${isRec ? "candidate-reco" : ""}">
          <td><span class="cand-swatch" style="background:${c.background}"></span></td>
          <td class="mono">${c.background}${isRec ? ' <span class="reco-tag">推荐</span>' : ""}</td>
          <td class="num mono">${scoreTxt}</td>
          <td class="hint">${pairTxt}</td>
        </tr>`;
    })
    .join("");
  return `
    <table class="adj-table candidate-table">
      <thead><tr><th></th><th>候选背景</th><th>得分</th><th>最难区分的一对</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderOrdersTable(orders) {
  const rows = orders
    .map((o) => `
      <tr>
        <td class="num">${o.rank}</td>
        <td class="mono">${o.order.map(escapeHtml).join(" → ")}</td>
        <td class="num mono">${fmtSse(o.totalSse)}</td>
      </tr>`)
    .join("");
  return `
    <div class="orders-table-title">参与区分的候选叠序（按总误差、ID 序列排序）</div>
    <table class="adj-table orders-table">
      <thead><tr><th>#</th><th>底 → 顶 ID 序列</th><th>总平方误差</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ------------------------------------------------------------ 启动 --
render();
renderSuggestControls();
runSolve();
