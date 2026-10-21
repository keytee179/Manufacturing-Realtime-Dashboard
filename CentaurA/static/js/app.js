const processBody = document.getElementById("processBody");
const phaseHeader = document.getElementById("phaseHeader");
const pboBody = document.getElementById("pboBody");
const chart = echarts.init(document.getElementById("chart"));
const pboHeader = document.querySelector("#pbo-panel .panel-header strong");
const chartHeader = document.querySelector("#process-flow-chart .panel-header strong")
const PBOEngine = {
  running: false,
  paused: false,
  lastFrameTime: 0,
  rotateTimeout: null,
};

const API_BASE = "/NPI_CentaurA";
const PBO_ROTATE_NO_SCROLL_DELAY = 20000;
const YIELD_COLOR = "#22c55e";
const FAILRATE_COLOR = "#dc2626";
const selectedBuildsByPhase = {};
const MP_STATUS_COLOR = {
  rejected: "#dc2626",
  approved: "#2563eb",
  approval: "#2563eb",
  submitted: "#16a34a",
  deviated: "#7c3aed"
};

function shortBuildName(build) {
  if (!build) return "";
  const parts = build.split("-");
  return parts.length >= 3 ? parts.slice(2).join("-") : build;
}

function renderMPBadge(mpStatus) {
  if (!mpStatus) return "";
  let html = "";
  if (mpStatus.mbo) {
    const color =
      MP_STATUS_COLOR[String(mpStatus.mbo).toLowerCase()] || "#475569";
    html += `<span class="mp-badge" style="color:${color}">M</span>`;
  }
  if (mpStatus.pbo) {
    const color =
      MP_STATUS_COLOR[String(mpStatus.pbo).toLowerCase()] || "#475569";
    html += `<span class="mp-badge" style="color:${color}">P</span>`;
  }
  return html;
}

function getBuildSummary(lots) {
  let totalInput = 0;
  let totalOutput = 0;
  let totalPBO = 0;
  let totalFail = 0;
  lots.forEach(lot => {
    (lot.rows || []).forEach(r => {
      totalInput += Number(r.in || 0);
      totalOutput += Number(r.out || 0);
      totalPBO += Number(r.pbo || 0);
      totalFail += Number(r.fail || 0);
    });
  });
  return {
    totalInput,
    totalOutput,
    totalPBO,
    totalFail
  };
}

function getBuildGroupKey(build) {
  if (!build) return "";
  const dashCount = (build.match(/-/g) || []).length;
  let tail = "";
  if (dashCount >= 2) {
    tail = build.split("-").slice(2).join("-").trim();
  }
  else if (build.includes(" ")) {
    tail = build.split(" ", 2)[1].trim();
  } else {
    tail = build;
  }
  return tail.split(" ")[0];
}

let procMode = "all";
document.querySelectorAll("input[name='procMode']").forEach(r => {
  r.addEventListener("change", e => {
    procMode = e.target.value;
    loadProcessRealtime();
  });
});

let processOrderMap = {};
let globalPhaseHeader = null;
let pboViewMode = "LOT";
let chartFollowPBO = true;
let pboPendingReachBottom = null;
let selectedPBOBuilds = null;
let selectedChartBuildGroups = null;
let selectedChartLotTypes = null;
let lastRealtimeData = null;
let needReloadProcess = false;
let allPBOData = [];
let filterPBOMainOnly = false;
let pboAutoScrollTimer = null;
let pboRotateTimer = null;
let pboBuildRotateIdx = 0;
let pboBuildRotateList = [];
let selectedPhases = null;
let allPhases = [];
let pboData = [];
let pboSignature = "";
let pboMode = "ALL";
let selectedPBOBuildGroups = null;
let selectedPBOLotTypes = null;
let pboBaseConfigBeforeFilter = null;
let selectedPBOMainPhases = null;

function mapBuildToPBOLots(pboData, realtimeData) {
  if (!realtimeData || !realtimeData.rows) return;
  const lotToBuild = new Map();
  realtimeData.rows.forEach(r => {
    Object.values(r.cells || {}).forEach(cell => {
      (cell || []).forEach(lot => {
        if (lot.full && lot.build) {
          lotToBuild.set(lot.full, lot.build);
        }
      });
    });
  });
  pboData.forEach(cfg => {
    (cfg.lots || []).forEach(lot => {
      const raw = lotToBuild.get(lot.lot) || "";
      lot._rawBuild = raw;
      lot._buildInfo = normalizeBuildString(raw);
    });
  });
}

function getLotsForChartView() {
  const lots = [];
  pboData.forEach(cfg => {
    (cfg.lots || []).forEach(lot => {
      const info = lot._buildInfo;
      if (!info) return;

      if (
        selectedChartBuildGroups &&
        !selectedChartBuildGroups.includes(info.buildGroup)
      ) return;
      if (
        selectedChartLotTypes &&
        !selectedChartLotTypes.includes(info.lotTypeDisplay)
      ) return;
      lots.push(lot);
    });
  });
  return lots;
}

function pboScrollLoop(timestamp) {
  if (!PBOEngine.running || PBOEngine.paused) return;
  const el = pboBody;
  if (!el) return;
  if (!PBOEngine.lastFrameTime) {
    PBOEngine.lastFrameTime = timestamp;
  }
  const delta = timestamp - PBOEngine.lastFrameTime;
  PBOEngine.lastFrameTime = timestamp;
  const SPEED = 30;
  el.scrollTop += (SPEED * delta) / 1000;
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) {
    schedulePBORotateAfterScroll();
    return;
  }
  requestAnimationFrame(pboScrollLoop);
}

function schedulePBORotateAfterScroll() {
  clearTimeout(PBOEngine.rotateTimeout);
  PBOEngine.rotateTimeout = setTimeout(() => {
    if (!PBOEngine.running || PBOEngine.paused) return;
    rotatePBONextBuild();
  }, 5000);
}

function buildProcessOrderMap(processOrder) {
  processOrderMap = {};
  (processOrder || []).forEach((p, idx) => {
    processOrderMap[p] = idx;
  });
}

function sortRowsByProcessOrder(rows) {
  return (rows || []).slice().sort((a, b) => {
    const aIdx = processOrderMap[a.process] ?? 9999;
    const bIdx = processOrderMap[b.process] ?? 9999;
    return aIdx - bIdx;
  });
}

function rotatePBONextBuild() {
  if (!PBOEngine.running) return;
  const builds = getAllPBOBuildGroups();
  if (!builds.length) return;
  pboBuildRotateIdx = (pboBuildRotateIdx + 1) % builds.length;
  const build = builds[pboBuildRotateIdx];
  selectedPBOBuildGroups = [build];
  selectedPBOLotTypes = null;
  updatePBOHeaderTitle();
  renderPBOByBuild();
  populatePBOLotTypeFilter();
  if (pboBody) pboBody.scrollTop = 0;
  PBOEngine.lastFrameTime = 0;
  requestAnimationFrame(pboScrollLoop);
}

function ensurePBORunning() {
  if (PBOEngine.running) return;
  PBOEngine.running = true;
  PBOEngine.paused = false;
  PBOEngine.lastFrameTime = 0;
  if (pboBody) pboBody.scrollTop = 0;
  requestAnimationFrame(pboScrollLoop);
}

function setupPBOPauseOnHover() {
  const pboPanel = document.getElementById("pbo-panel");
  if (!pboPanel) return;
  pboPanel.addEventListener("mouseenter", () => {
    PBOEngine.paused = true;
    clearTimeout(PBOEngine.rotateTimeout);
    PBOEngine.rotateTimeout = null;
  });
  pboPanel.addEventListener("mouseleave", () => {
    PBOEngine.paused = false;
    PBOEngine.lastFrameTime = 0;
    requestAnimationFrame(pboScrollLoop);
  });
}

function populateChartBuildFilter() {
  const dropdown = document.getElementById("chartCfgDropdown");
  const menu = dropdown.querySelector(".dropdown-menu");
  const label = dropdown.querySelector(".dropdown-label");
  const buildGroups = new Set();
  pboData.forEach(cfg => {
    (cfg.lots || []).forEach(lot => {
      if (lot._buildInfo) {
        buildGroups.add(lot._buildInfo.buildGroup);
      }
    });
  });
  menu.innerHTML = "";
  Array.from(buildGroups).sort().forEach(bg => {
    const row = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = bg;
    cb.addEventListener("change", () => {
      chartFollowPBO = false;
      selectedChartBuildGroups = Array.from(
        menu.querySelectorAll("input:checked")
      ).map(x => x.value);
      if (!selectedChartBuildGroups.length) {
        selectedChartBuildGroups = null;
      }
      label.textContent = selectedChartBuildGroups
        ? selectedChartBuildGroups.join(", ")
        : "Select Build";
      populateChartLotTypeFilter();
      renderProcessFlowChart();
    });
    row.append(cb, " ", bg);
    menu.appendChild(row);
  });
}

function populateChartLotTypeFilter() {
  const dropdown = document.getElementById("chartLotDropdown");
  const menu = dropdown.querySelector(".dropdown-menu");
  const label = dropdown.querySelector(".dropdown-label");
  menu.innerHTML = "";
  if (!Array.isArray(selectedChartBuildGroups)) {
    label.textContent = "Select Lot";
    return;
  }
  const lotTypes = new Set();
  pboData.forEach(cfg => {
    (cfg.lots || []).forEach(lot => {
      const info = lot._buildInfo;
      if (
        info &&
        selectedChartBuildGroups.includes(info.buildGroup)
      ) {
        lotTypes.add(info.lotTypeDisplay);
      }
    });
  });
  Array.from(lotTypes).sort().forEach(lt => {
    const row = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = lt;
    cb.addEventListener("change", () => {
      chartFollowPBO = false;
      selectedChartLotTypes = Array.from(
        menu.querySelectorAll("input:checked")
      ).map(x => x.value);
      if (!selectedChartLotTypes.length) {
        selectedChartLotTypes = null;
      }
      label.textContent = selectedChartLotTypes
        ? selectedChartLotTypes.join(", ")
        : "Select Lot";
        renderProcessFlowChart();
    });
    row.append(cb, " ", lt);
    menu.appendChild(row);
  });
}

function getAllPBOBuildGroups() {
  const set = new Set();
  allPBOData.forEach(cfg => {
    (cfg.lots || []).forEach(lot => {
      if (lot._buildInfo) {
        set.add(lot._buildInfo.buildGroup);
      }
    });
  });
  return Array.from(set);
}

function normalizeBuildString(rawBuild) {
  if (!rawBuild) return null;
  let s = rawBuild.replace(/^CENA-/, "").trim();
  const phase = s.split(/[-\s]/)[0];
  const afterPhase = s.replace(new RegExp("^" + phase + "[-\\s]?"), "").trim();
  const lotTypeDisplay = afterPhase;
  let lotTypeKey = afterPhase
    .replace(/\s+\d+$/, "")
    .replace(/\d+$/, "")
    .replace(/\s+/g, "")
    .toUpperCase();
  if (lotTypeKey.startsWith("ZO")) {
    lotTypeKey = "ZO";
  }
  return {
    phase,
    lotTypeKey,
    buildGroup: `${phase}-${lotTypeKey}`,
    buildDisplay: s,
    lotTypeDisplay
  };
}

function getConfigGroupKey(info) {
  if (!info || !info.buildDisplay) return "UNKNOWN";
  const parts = info.buildDisplay.trim().split(/\s+/);
  if (parts.length >= 2) {
    return parts[0] + " " + parts[1];
  }
  return info.buildDisplay;
}

async function loadProcessRealtime() {
  const qs = new URLSearchParams();
  if (Array.isArray(selectedPhases)) {
    qs.set("phase", selectedPhases.join(","));
  }
  const res = await fetch(`${API_BASE}/api/process_realtime?${qs}`);
  const data = await res.json();
  const cfgEl = document.getElementById("configSource");
  if (cfgEl && Array.isArray(data.phase_header)) {
    cfgEl.innerHTML = "";
    data.phase_header.forEach(p => {
      const span = document.createElement("span");
      span.textContent = p.phase;
      if (!p.active) {
        span.style.opacity = "0.4";
      }
      cfgEl.appendChild(span);
    });
  }
  const srcEl = document.getElementById("dataSource");
    if (srcEl && data.source_file) {
      if (data.source_updated) {
        srcEl.textContent = `Source: ${data.source_file} (Updated: ${data.source_updated})`;
      } else {
        srcEl.textContent = `Source: ${data.source_file}`;
      }
    }
  if (Array.isArray(data.phase_header)) {
  if (!globalPhaseHeader) {
    globalPhaseHeader = data.phase_header;
  }
    renderConfigChip(globalPhaseHeader);
  }
  lastRealtimeData = data;
  const displayPhases =
    Array.isArray(selectedPhases) && selectedPhases.length
      ? data.display_phases
      : data.all_phases;
  allPhases = displayPhases;
  document.documentElement.style.setProperty("--phase-count", allPhases.length);
  phaseHeader.innerHTML = "";
  const phaseCount = data.phase_lot_count || {};
  allPhases.forEach(ph => {
    const buildSet = new Set();
    const mainBuildsSet = new Set();
    data.rows.forEach(r => {
      (r.cells[ph] || []).forEach(l => {
        if (l.build) {
          buildSet.add(l.build);
          if (
            typeof l.build === "string" &&
            l.build.toLowerCase().includes("main")
          ) {
            mainBuildsSet.add(l.build);
          }
        }
      });
    });
    const builds = Array.from(buildSet);
    const mainBuilds = Array.from(mainBuildsSet);
    const selected = selectedBuildsByPhase[ph] || [];
    const wrap = document.createElement("div");
    wrap.className = "h-phase";
    wrap.style.position = "relative";
    const title = document.createElement("span");
    title.textContent = `${ph} (${phaseCount[ph] || 0})`;
    title.style.cursor = "pointer";
    title.onclick = e => {
      e.stopPropagation();
      selectedBuildsByPhase[ph] = [];
      loadProcessRealtime();
    };
    wrap.appendChild(title);
    if (mainBuilds.length > 0) {
      const mainSpan = document.createElement("span");
      mainSpan.textContent = ` - MAIN: ${mainBuilds.length}`;
      mainSpan.style.marginLeft = "4px";
      mainSpan.style.color = "#16a34a";
      mainSpan.style.fontWeight = "600";
      mainSpan.style.cursor = "pointer";
      mainSpan.onclick = e => {
        e.stopPropagation();
        selectedBuildsByPhase[ph] = mainBuilds;
        loadProcessRealtime();
      };
      wrap.appendChild(mainSpan);
    }
    const toggle = document.createElement("span");
    toggle.textContent = " ▾";
    toggle.style.cursor = "pointer";
    const dropdown = document.createElement("div");
    dropdown.className = "build-dropdown hidden";
    dropdown.style.position = "absolute";
    dropdown.style.top = "100%";
    dropdown.style.left = "0";
    dropdown.style.zIndex = "3000";
    dropdown.addEventListener("click", e => e.stopPropagation());
    const allRow = document.createElement("label");
    const allCb = document.createElement("input");
    allCb.type = "checkbox";
    allCb.checked = selected.length === 0;
    allCb.onchange = () => {
      selectedBuildsByPhase[ph] = [];
      loadProcessRealtime();
    };
    allRow.append(allCb, " All");
    dropdown.appendChild(allRow);
    const groupMap = new Map();
    builds.forEach(b => {
      const key = getBuildGroupKey(b);
      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key).push(b);
    });
    Array.from(groupMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .forEach(([groupKey, rawBuilds]) => {
        const row = document.createElement("label");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked =
          rawBuilds.length > 0 &&
          rawBuilds.every(b => selected.includes(b));
        cb.onchange = () => {
          selectedBuildsByPhase[ph] = selectedBuildsByPhase[ph] || [];
          if (cb.checked) {
            rawBuilds.forEach(b => {
              if (!selectedBuildsByPhase[ph].includes(b)) {
                selectedBuildsByPhase[ph].push(b);
              }
            });
          } else {
            selectedBuildsByPhase[ph] =
              selectedBuildsByPhase[ph].filter(b => !rawBuilds.includes(b));
          }
          renderProcessBodyFromData(lastRealtimeData);
        };
        row.append(cb, " ", groupKey);
        dropdown.appendChild(row);
      });
    toggle.onclick = e => {
      e.stopPropagation();
      dropdown.classList.toggle("hidden");
    };
    wrap.append(toggle, dropdown);
    phaseHeader.appendChild(wrap);
  });
  document.addEventListener("click", () => {
    document.querySelectorAll(".build-dropdown")
      .forEach(dd => dd.classList.add("hidden"));
  });
  renderProcessBodyFromData(data);
  renderPhaseFilter(data.all_phases);
}

function normalizeMPStatus(status) {
  if (!status) return "";
  const s = status.trim().toLowerCase();
  if (s.startsWith("reject")) return "Rejected";
  if (s.startsWith("submit")) return "Submitted";
  if (s.startsWith("approve") && !s.includes("condition")) return "Approved";
  if (s.startsWith("condition")) return "Conditional Approved";
  return status.trim();
}

function renderCellMPBadge(mp) {
  if (!mp || !Array.isArray(mp.xbo) || !mp.status) return "";
  const order = ["E", "M", "P"];
  return `
    <div class="mp-cell-badge">
      ${order.map(x => {
        if (!mp.xbo.includes(x)) return "";
        const raw = mp.status[x] || "";
        let cls = "mp-text";
        if (raw) {
          const s = raw.toLowerCase();
          if (s.startsWith("approve")) cls += " mp-approved";
          else if (s.startsWith("reject")) cls += " mp-rejected";
          else if (s.startsWith("submit")) cls += " mp-submitted";
        } else {
          cls += " mp-waiting";
        }
        return `<span class="${cls}">${x}</span>`;
      }).join("")}
    </div>
  `;
}

function renderProcessBodyFromData(data) {
  processBody.innerHTML = "";
  const mode = procMode;
  data.rows.forEach(r => {
    const hasLot = Object.values(r.cells).some(arr => arr.length > 0);
    if (mode === "have_lot" && !hasLot) return;
    processBody.innerHTML += `
      <div class="pr-row">
        <div class="c-no">${r.no}</div>
        <div class="c-process">
          ${r.process}
          ${renderMPBadge(r["__mp_status__"])}
        </div>
        ${allPhases.map((ph, idx) => {
          const lots = (r.cells[ph] || []).filter(l => {
            const sel = selectedBuildsByPhase[ph];
            if (!sel || sel.length === 0) return true;
            return sel.includes(l.build);
          });
          let cellClass = "";
          if (lots.length > 10) {
            cellClass = "cell-many";
          } else if (lots.length > 5) {
            cellClass = "cell-mid";
          }
          return `
            <div class="phase-cell ${cellClass}
              ${idx === 0 ? "phase-left-edge" : ""}
              ${idx === allPhases.length - 1 ? "phase-right-edge" : ""}"
              style="position:relative">
              ${(() => {
                  const mp = r.__mp_status__?.[ph];
                  if (!mp) return "";
                  return renderCellMPBadge(mp);
                })()}
              ${lots.map(l => {
                let statusText = "";
                let lotClass = `lot ${l.color}`;
                const procName = l.current_process || r.process || "";
                if (l.time_type === "Finished") {
                    lotClass = "lot blue";
                    statusText = `Finished`;
                }
                else if (l.time_type === "WORK") {
                    statusText =
                        `Processing ${formatDurationFromMinutes(l.minutes)} in ${procName}`;
                }
                else if (l.time_type === "Waiting") {
                    statusText =
                        `Waiting ${formatDurationFromMinutes(l.minutes)} in ${procName}`;
                }
                else if (l.time_type === "Offline") {
                    statusText =
                        `Offline ${formatDurationFromMinutes(l.minutes)} in ${procName}`;
                }
                return `
                  <div class="lot-wrapper">
                    <div class="lot ${l.color} ${timeToIntensity(l.minutes || 0)}">
                      ${l.lot}
                    </div>
                    <div class="lot-tooltip ${l.color}">
                      <strong>Lot:</strong> ${l.full}<br>
                      <strong>Config:</strong> ${l.config}<br>
                      <strong>Build:</strong> ${shortBuildName(l.build)}<br>
                      <strong>Input QTY:</strong> ${l.input_qty}<br>
                      ${statusText}
                    </div>
                  </div>
                `;
              }).join("")}
            </div>
          `;
        }).join("")}
      </div>
    `;
  });
}

document.addEventListener("mouseover", e => {
  const wrapper = e.target.closest(".lot-wrapper");
  if (!wrapper) return;
  const tooltip = wrapper.querySelector(".lot-tooltip");
  if (!tooltip) return;
  tooltip.classList.remove("flip-left");
  const rect = tooltip.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  if (rect.right > viewportWidth - 8) {
    tooltip.classList.add("flip-left");
  }
});

function renderPhaseFilter(phases) {
  const dropdown = document.getElementById("phaseDropdown");
  const menu = dropdown?.querySelector(".phase-menu");
  const label = dropdown?.querySelector(".phase-label");
  if (!dropdown || !menu) return;
  menu.innerHTML = "";
  phases.forEach(ph => {
    const row = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = ph;
    cb.checked = Array.isArray(selectedPhases)
      ? selectedPhases.includes(ph)
      : false;
    cb.addEventListener("change", () => {
      const checked = Array.from(
        menu.querySelectorAll("input:checked")
      ).map(x => x.value);
      selectedPhases = checked.length ? checked : null;
      label.textContent = checked.length ? `Phase (${checked.length})` : "Select Phase";
      loadProcessRealtime();
    });
    row.append(cb, " ", ph);
    menu.appendChild(row);
  });
  label.onclick = () => menu.classList.toggle("hidden");
  document.addEventListener("click", e => {
    if (!dropdown.contains(e.target)) {
      menu.classList.add("hidden");
    }
  });
}

async function loadPBO(force = false) {
  const res = await fetch(`${API_BASE}/api/pbo`);
  const data = await res.json();
  if (!allPBOData.length) {
    allPBOData = data || [];
  }
  pboData = data || [];
  mapBuildToPBOLots(pboData, lastRealtimeData);
  renderPBOHeaderWithFilters();
  renderPBOByBuild();
  renderProcessFlowChart();
  if (!selectedPBOBuildGroups) {
  }
  populateChartBuildFilter();
  populateChartLotTypeFilter();
  setupDropdownToggle("chartCfgDropdown");
  setupDropdownToggle("chartLotDropdown");
  ensurePBORunning();
}

async function loadFilterMeta() {
  const res = await fetch(`${API_BASE}/api/filter_meta`);
  const meta = await res.json();
  populatePhaseDropdown(meta.phases);
  populateConfigDropdown(meta.configs);
  populateLotDropdown(meta.lots);
}

function resetPBOFilter() {
  selectedPBOBuildGroups = null;
  selectedPBOLotTypes = null;
  selectedPBOMainPhases = null;
  document
    .querySelectorAll("#pboBuildDropdown input[type='checkbox']")
    .forEach(cb => cb.checked = false);
  document
    .querySelectorAll("#pboLotTypeDropdown input[type='checkbox']")
    .forEach(cb => cb.checked = false);
  document
    .querySelectorAll("#pboMainDropdown input[type='checkbox']")
    .forEach(cb => cb.checked = false);
  const buildLabel =
    document.querySelector("#pboBuildDropdown .dropdown-label");
  if (buildLabel) buildLabel.textContent = "Select Build";
  const lotLabel =
    document.querySelector("#pboLotTypeDropdown .dropdown-label");
  if (lotLabel) lotLabel.textContent = "Select Lot Type";
  const mainLabel =
    document.querySelector("#pboMainDropdown .dropdown-label");
  if (mainLabel) mainLabel.textContent = "Select MAIN";
  PBOEngine.userFiltering = false;
  clearTimeout(PBOEngine.rotateTimeout);
  PBOEngine.rotateTimeout = null;
  PBOEngine.lastFrameTime = 0;
  updatePBOHeaderTitle();
  renderPBOByBuild();
  populatePBOLotTypeFilter();
  ensurePBORunning();
}

function resetChartFilter() {
  chartFollowPBO = false;
  selectedChartBuildGroups = null;
  selectedChartLotTypes = null;
  document
    .querySelectorAll("#chartCfgDropdown input[type='checkbox']")
    .forEach(cb => cb.checked = false);
  document
    .querySelectorAll("#chartLotDropdown input[type='checkbox']")
    .forEach(cb => cb.checked = false);
  document.querySelector("#chartCfgDropdown .dropdown-label")
    .textContent = "Select Build";
  document.querySelector("#chartLotDropdown .dropdown-label")
    .textContent = "Select Lot";
  populateChartLotTypeFilter();
  renderProcessFlowChart();
}

function getChartLots() {
  return chartFollowPBO
    ? getLotsForCurrentBuild()
    : getLotsForChartView();
}

function bindPBOViewToggle() {
  document.querySelectorAll(".pbo-view-btn").forEach(btn => {
    btn.onclick = () => {
      pboViewMode = btn.dataset.view;
      document.querySelectorAll(".pbo-view-btn")
        .forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      renderPBOByBuild();
    };
  });
}

function renderPBOHeaderWithFilters() {
  setTimeout(bindPBOViewToggle);
  const header = document.querySelector("#pbo-panel .panel-header");
  if (!header || header.dataset.ready) return;
  header.dataset.ready = "1";
  header.innerHTML = `
    <div class="pbo-header-left">
      <strong>PBO QTY by Process</strong>
      <div class="pbo-view-toggle">
        <button class="pbo-view-btn active" data-view="LOT">LOT</button>
        <button class="pbo-view-btn" data-view="CONFIG">CONFIG</button>
      </div>
    </div>
    <div class="pbo-header-right">
      <div class="dropdown" id="pboBuildDropdown">
        <span class="dropdown-label">Select Build</span>
        <div class="dropdown-menu hidden"></div>
      </div>
      <div class="dropdown" id="pboLotTypeDropdown">
        <span class="dropdown-label">Select Lot Type</span>
        <div class="dropdown-menu hidden"></div>
      </div>
      <div class="dropdown" id="pboMainDropdown">
        <span class="dropdown-label">Select MAIN</span>
        <div class="dropdown-menu hidden"></div>
      </div>
      <button id="pboResetBtn" class="btn btn-secondary btn-sm">Reset</button>
      <button id="pboExportBtn" class="btn btn-primary btn-sm">Export</button>
      <button id="pboExportSummaryBtn" class="btn btn-secondary btn-sm">Export Summary</button>
    </div>
  `;
  populatePBOBuildFilter();
  populatePBOLotTypeFilter();
  populatePBOMainFilter();
  setupDropdownToggle("pboBuildDropdown");
  setupDropdownToggle("pboLotTypeDropdown");
  setupDropdownToggle("pboMainDropdown");
  document
    .getElementById("pboResetBtn")
    .addEventListener("click", resetPBOFilter);
  document
    .getElementById("pboExportBtn")
    .addEventListener("click", exportPBOToExcel);
  document
    .getElementById("pboExportSummaryBtn")
    .addEventListener("click", exportPBOSummary);
}

function exportPBOSummary() {
  if (!Array.isArray(pboData) || !pboData.length) {
    alert("No PBO data");
    return;
  }
  const rows = [];
  const buildMap = {};
  function normProc(s) {
    return String(s || "")
      .toUpperCase()
      .replace(/\s+/g, " ")
      .trim();
  }
  pboData.forEach(cfg => {
    (cfg.lots || []).forEach(lot => {
      const info = lot._buildInfo;
      if (!info || !info.buildGroup) return;
      if (!info.buildGroup.endsWith("-MAIN")) return;
      const buildKey = info.buildGroup;
      if (!buildMap[buildKey]) {
        buildMap[buildKey] = [];
      }
      buildMap[buildKey].push(lot);
    });
  });
  Object.entries(buildMap).forEach(([build, lots]) => {
    let sumInput = 0;
    let sumOutput = 0;
    let sumPBO = 0;
    let sumFail = 0;
    let overallFailDetail = {};
    lots.forEach((lot, idx) => {
      if (!Array.isArray(lot.rows) || !lot.rows.length) return;
      const finalRows = lot.final_rows || [];
      const vsaRow = finalRows.find(r =>
        normProc(r.process).includes("VSA PNP")
      );
      const input = Number(
        vsaRow?.in ??
        vsaRow?.input ??
        vsaRow?.in_qty ??
        vsaRow?.input_qty ??
        0
      );
      const last = lot.rows[lot.rows.length - 1];
      const output = Number(last.out || 0);
      const pbo = Number(lot.pbo || 0);
      const fail = Number(lot.fail || 0);
      sumInput += input;
      sumOutput += output;
      sumPBO += pbo;
      sumFail += fail;
      let processFailMap = {};
      lot.rows.forEach(r => {
        const process = r.process;
        const detail = r.failure_detail || {};
        if (!Object.keys(detail).length) return;
        if (!processFailMap[process]) {
          processFailMap[process] = {};
        }
        Object.entries(detail).forEach(([name, qty]) => {
          processFailMap[process][name] =
            (processFailMap[process][name] || 0) + qty;
          overallFailDetail[name] =
            (overallFailDetail[name] || 0) + qty;
        });
      });
      const failNameStr = Object.entries(processFailMap)
        .map(([process, detailObj]) => {
          const inner = Object.entries(detailObj)
            .map(([k, v]) => `${k}: ${v}`)
            .join(" | ");
          return `${process}(${inner})`;
        })
        .join(" || ");
      const denom = output + fail;
      const failRate = denom > 0
        ? (fail / denom) * 100
        : 0;
      rows.push({
        BUILD: build,
        "Lot ID": `Main ${idx + 1}`,
        "Input QTY": input,
        "Output QTY": output,
        "PBO": pbo,
        "Fail": fail,
        "Fail Rate (%)": failRate.toFixed(2),
        "Fail Name": failNameStr
      });
    });
    const overallFailName = Object.entries(overallFailDetail)
      .map(([k, v]) => `${k}: ${v}`)
      .join("   |   ");
    const overallDenom = sumOutput + sumFail;
    const overallRate = overallDenom > 0
      ? (sumFail / overallDenom) * 100
      : 0;
    rows.push({
      BUILD: build,
      "Lot ID": "Overall",
      "Input QTY": sumInput,
      "Output QTY": sumOutput,
      "PBO": sumPBO,
      "Fail": sumFail,
      "Fail Rate (%)": overallRate.toFixed(2),
      "Fail Name": overallFailName
    });
  });
  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Summary");
  XLSX.writeFile(workbook, "PBO_Summary_CentaurA.xlsx");
}

function populatePBOMainFilter() {
  const dropdown = document.getElementById("pboMainDropdown");
  const menu = dropdown.querySelector(".dropdown-menu");
  const label = dropdown.querySelector(".dropdown-label");
  const phaseSet = new Set();
  allPBOData.forEach(cfg => {
    (cfg.lots || []).forEach(lot => {
      const info = lot._buildInfo;
      if (
        info &&
        typeof info.buildGroup === "string" &&
        info.buildGroup.endsWith("-MAIN")
      ) {
        phaseSet.add(info.phase);
      }
    });
  });
  menu.innerHTML = "";
  const allRow = document.createElement("label");
  const allCb = document.createElement("input");
  allCb.type = "checkbox";
  allCb.checked =
    Array.isArray(selectedPBOMainPhases) &&
    selectedPBOMainPhases.length === 0;
  allCb.onchange = () => {
    selectedPBOMainPhases = allCb.checked ? [] : null;
    label.textContent = allCb.checked ? "ALL MAIN" : "Select MAIN";
    renderPBOByBuild();
  };
  allRow.append(allCb, " ALL MAIN");
  menu.appendChild(allRow);
  Array.from(phaseSet)
    .sort()
    .forEach(ph => {
      const row = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked =
        Array.isArray(selectedPBOMainPhases) &&
        selectedPBOMainPhases.includes(ph);
      cb.onchange = () => {
        selectedPBOMainPhases = selectedPBOMainPhases || [];
        if (cb.checked) {
          if (!selectedPBOMainPhases.includes(ph)) {
            selectedPBOMainPhases.push(ph);
          }
        } else {
          selectedPBOMainPhases =
            selectedPBOMainPhases.filter(x => x !== ph);
        }
        if (!selectedPBOMainPhases.length) {
          selectedPBOMainPhases = null;
        }
        label.textContent = selectedPBOMainPhases
          ? selectedPBOMainPhases.join(", ")
          : "Select MAIN";
        renderPBOByBuild();
        populatePBOLotTypeFilter();
      };
      row.append(cb, " ", ph);
      menu.appendChild(row);
    });
}

function getCurrentProcessOfLot(lotFull, realtimeData, processOrder) {
  if (!lotFull) return null;
  if (realtimeData && realtimeData.rows) {
    for (const row of realtimeData.rows) {
      for (const ph of Object.keys(row.cells || {})) {
        if ((row.cells[ph] || []).some(l => l.full === lotFull)) {
          return row.process;
        }
      }
    }
  }
  return null;
}

function populatePBOBuildFilter() {
  const menu = document.querySelector("#pboBuildDropdown .dropdown-menu");
  const label = document.querySelector("#pboBuildDropdown .dropdown-label");
  if (!menu) return;
  const buildGroupSet = new Set();
  allPBOData.forEach(cfg => {
    (cfg.lots || []).forEach(lot => {
      if (lot._buildInfo) {
        buildGroupSet.add(lot._buildInfo.buildGroup);
      }
    });
  });
  menu.innerHTML = "";
  Array.from(buildGroupSet).sort().forEach(bg => {
    const row = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = bg;
    cb.addEventListener("change", () => {
      PBOEngine.userFiltering = true;
      clearTimeout(PBOEngine.rotateTimeout);
      PBOEngine.rotateTimeout = null;
      selectedPBOBuildGroups = Array.from(
        menu.querySelectorAll("input:checked")
      ).map(x => x.value);
      if (!selectedPBOBuildGroups.length) {
        selectedPBOBuildGroups = null;
      }
      selectedPBOLotTypes = null;

      label.textContent = selectedPBOBuildGroups
        ? selectedPBOBuildGroups.join(", ")
        : "Select Build";
      populatePBOLotTypeFilter();
      updatePBOHeaderTitle();
      renderPBOByBuild();
    });
    row.append(cb, " ", bg);
    menu.appendChild(row);
  });
}

function buildProcessIndexMap(processOrder) {
  const map = {};
  processOrder.forEach((p, idx) => {
    map[p] = idx;
  });
  return map;
}

function populatePBOLotTypeFilter() {
  const menu = document.querySelector("#pboLotTypeDropdown .dropdown-menu");
  const label = document.querySelector("#pboLotTypeDropdown .dropdown-label");
  if (!menu) return;
  menu.innerHTML = "";
  const validLots = getLotsAfterMainAndBuildFilter();
  const lotTypeSet = new Set();
  validLots.forEach(lot => {
    const info = lot._buildInfo;
    if (info?.lotTypeDisplay) {
      lotTypeSet.add(info.lotTypeDisplay);
    }
  });
  if (!lotTypeSet.size) {
    label.textContent = "No Lot Type";
    return;
  }
  label.textContent = selectedPBOLotTypes
    ? selectedPBOLotTypes.join(", ")
    : "Select Lot Type";
  Array.from(lotTypeSet).sort().forEach(lt => {
    const row = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = lt;
    cb.checked =
      Array.isArray(selectedPBOLotTypes) &&
      selectedPBOLotTypes.includes(lt);
    cb.onchange = () => {
      selectedPBOLotTypes = selectedPBOLotTypes || [];
      if (cb.checked) {
        if (!selectedPBOLotTypes.includes(lt)) {
          selectedPBOLotTypes.push(lt);
        }
      } else {
        selectedPBOLotTypes =
          selectedPBOLotTypes.filter(x => x !== lt);
      }
      if (!selectedPBOLotTypes.length) {
        selectedPBOLotTypes = null;
      }
      label.textContent = selectedPBOLotTypes
        ? selectedPBOLotTypes.join(", ")
        : "Select Lot Type";
      renderPBOByBuild();
    };
    row.append(cb, " ", lt);
    menu.appendChild(row);
  });
}

function setupDropdownToggle(id) {
  const dropdown = document.getElementById(id);
  if (!dropdown) return;
  const label = dropdown.querySelector(".dropdown-label");
  const menu = dropdown.querySelector(".dropdown-menu");
  label.addEventListener("click", () => menu.classList.toggle("hidden"));
  document.addEventListener("click", e => {
    if (!dropdown.contains(e.target)) menu.classList.add("hidden");
  });
}

function getLotsAfterMainAndBuildFilter() {
  const lots = [];
  pboData.forEach(cfg => {
    (cfg.lots || []).forEach(lot => {
      if (!lot._buildInfo) return;
      if (!passMainFilter(lot)) return;
      if (!passBuildFilter(lot)) return;
      lots.push(lot);
    });
  });
  return lots;
}

function passBuildFilter(lot) {
  if (!selectedPBOBuildGroups) return true;
  return selectedPBOBuildGroups.includes(lot._buildInfo?.buildGroup);
}

function passMainFilter(lot) {
  if (!selectedPBOMainPhases) return true;
  const info = lot._buildInfo;
  if (!info) return false;
  const isMain =
    typeof info.buildGroup === "string" &&
    info.buildGroup.endsWith("-MAIN");
  if (!isMain) return false;
  if (selectedPBOMainPhases.length === 0) return true;
  return selectedPBOMainPhases.includes(info.phase);
}

function passLotTypeFilter(lot) {
  if (!selectedPBOLotTypes) return true;
  return selectedPBOLotTypes.includes(lot._buildInfo?.lotTypeDisplay);
}

function renderPBOByBuild() {
  pboBody.innerHTML = "";
  if (pboViewMode === "LOT") {
    pboData.forEach(cfg => {
      const baseLots = cfg.lots || [];
      const mainAndBuildFilteredLots = baseLots.filter(lot => {
        if (!lot._buildInfo) return false;
        return passBuildFilter(lot) && passMainFilter(lot);
      });
      const finalLots = mainAndBuildFilteredLots.filter(lot =>
        passLotTypeFilter(lot)
      );
      if (!finalLots.length) return;
      renderPBO({
        ...cfg,
        lots: finalLots
      });
    });
    return;
  }
  const allLots = [];
  pboData.forEach(cfg => {
    (cfg.lots || []).forEach(lot => {
      if (!lot._buildInfo) return;
      if (!passBuildFilter(lot)) return;
      if (!passMainFilter(lot)) return;
      if (!passLotTypeFilter(lot)) return;
      allLots.push(lot);
    });
  });
  if (!allLots.length) {
    return;
  }
  renderPBO({
    ...pboData[0],
    lots: allLots
  });
}

function updatePBOHeaderTitle() {
  const el = document.querySelector(
    "#pbo-panel .panel-header .pbo-header-left strong"
  );
  if (!el) return;
  if (!Array.isArray(selectedPBOBuildGroups) || selectedPBOBuildGroups.length === 0) {
    el.textContent = "PBO QTY by Process - Build: All";
    return;
  }
  if (selectedPBOBuildGroups.length === 1) {
    el.textContent = `PBO QTY by Process - Build: ${selectedPBOBuildGroups[0]}`;
    return;
  }
  el.textContent = "PBO QTY by Process - Build: Multiple";
}

function normalizeProc(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]/g, " ")
    .replace(/\s+/g, " ");
}

function renderPBO(cfg) {
  const lots = cfg.lots || [];
  if (pboViewMode === "CONFIG") {
    if (!lots.length) return;
    function normalizeProc(s) {
      return String(s || "")
        .trim()
        .toLowerCase()
        .replace(/[_-]/g, " ")
        .replace(/\s+/g, " ");
    }
    const groupMap = {};
    lots.forEach(lot => {
      const info = lot._buildInfo;
      if (!info) return;
      let key = "";
      if (info.buildDisplay.toUpperCase().includes("MAIN")) {
        key = `${info.phase} MAIN`;
      } else {
        key = `${info.phase} ${info.lotTypeKey}`;
      }
      if (!groupMap[key]) groupMap[key] = [];
      groupMap[key].push(lot);
    });
    buildProcessOrderMap(cfg.process_order);
    Object.entries(groupMap).forEach(([groupName, groupLots]) => {
      const allRows = [];
      groupLots.forEach(lot => {
        (lot.rows || []).forEach(r => {
          allRows.push({
            process: r.process,
            input: Number(r.in ?? 0),
            output: Number(r.out ?? 0),
            pbo: Number(r.pbo ?? 0),
            fail: Number(r.fail ?? 0),
            std: Number(r.std_pbo ?? 0),
            lot: lot.lot,
            failure_detail: r.failure_detail || {}
          });
        });
      });
      const processMap = {};
      allRows.forEach(r => {
        const key = r.process;
        if (!processMap[key]) {
          processMap[key] = {
            process: key,
            input: 0,
            output: 0,
            pbo: 0,
            fail: 0,
            std: r.std,
            failDetail: {},
            lotBreakdown: []
          };
        }
        processMap[key].input += r.input;
        processMap[key].output += r.output;
        processMap[key].pbo += r.pbo;
        processMap[key].fail += r.fail;
        processMap[key].lotBreakdown.push({
          lot: r.lot,
          pbo: r.pbo
        });
        Object.entries(r.failure_detail).forEach(([name, qty]) => {
          processMap[key].failDetail[name] =
            (processMap[key].failDetail[name] || 0) + qty;
        });
      });
      const rows = Object.values(processMap).sort((a, b) => {
        const aIdx = processOrderMap[a.process] ?? 9999;
        const bIdx = processOrderMap[b.process] ?? 9999;
        return aIdx - bIdx;
      });
      const inputKey = normalizeProc("VSA PnP");
      const outputKey = normalizeProc("OQC Prox test");
      let totalInput = 0;
      let totalOutput = 0;
      groupLots.forEach(lot => {
        const parentCfg = pboData.find(c =>
          (c.lots || []).some(l => l.lot === lot.lot)
        );
        if (!parentCfg) return;
        const flow = parentCfg.flow || {};
        Object.entries(flow).forEach(([procName, v]) => {
          const proc = normalizeProc(procName);
          if (proc === inputKey) {
            totalInput += Number(v.input ?? 0);
          }
          if (proc === outputKey) {
            totalOutput += Number(v.output ?? 0);
          }
        });
      });
      const totalPBO = rows.reduce((s, r) => s + r.pbo, 0);
      const totalFail = rows.reduce((s, r) => s + r.fail, 0);
      pboBody.innerHTML += `
        <div class="lot-title">
          <span class="lot-strong">${groupName}</span>
          <span> - Input: ${totalInput}</span>
          <span> - Output: ${totalOutput}</span>
          <span class="lot-strong lot-pbo"> - PBO: ${totalPBO}</span>
          <span class="lot-strong lot-fail"
                style="color:${totalFail > 0 ? '#dc2626' : '#111827'}">
            - Fail: ${totalFail}
          </span>
        </div>
        <table class="pbo-table">
          <tr>
            <th>Process</th>
            <th>Total Input</th>
            <th>Total Output</th>
            <th>Total PBO</th>
            <th>Total Fail</th>
          </tr>
          ${rows.map(r => `
            <tr>
              <td>${r.process}</td>
              <td>${r.input}</td>
              <td>${r.output}</td>
              <td>
                <div style="font-weight:600; color:${r.pbo > r.std ? '#dc2626' : '#111827'}">
                  ${r.pbo}${r.std > 0 ? `<span style="font-weight:600">/${r.std}</span>` : ""}
                </div>
                ${(r.lotBreakdown || []).map(lb => `
                  <div style="font-size:10px">
                    ${lb.lot}: ${lb.pbo}
                  </div>
                `).join("")}
              </td>
              <td>
                ${
                  r.fail > 0
                    ? `
                      <span style="color:#dc2626;font-weight:600">
                        ${r.fail}
                      </span>
                      ${
                        Object.keys(r.failDetail || {}).length
                          ? `<div style="font-size:10px;color:#b91c1c">
                              ${Object.entries(r.failDetail)
                                .map(([name, qty]) => `${name}: ${qty}`)
                                .join("<br>")}
                             </div>`
                          : ""
                      }
                    `
                    : `<span>0</span>`
                }
              </td>
            </tr>
          `).join("")}
        </table>
      `;
    });
    return;
  }
  const showPhaseInLotHeader =
    !Array.isArray(selectedPBOBuildGroups) ||
    selectedPBOBuildGroups.length !== 1;
  lots.forEach(lot => {
    const info = lot._buildInfo;
    const lotType = info?.lotTypeDisplay || "N/A";
    const phase = info?.phase || "";
    const currentProcess = getCurrentProcessOfLot(
      lot.lot,
      lastRealtimeData,
      cfg.process_order
    );
    pboBody.innerHTML += `
      <div class="lot-title">
        ${showPhaseInLotHeader ? `<span class="lot-strong">${phase} - </span>` : ""}
        <span class="lot-strong">${lotType}</span>
        <span class="lot-normal"> - ${lot.lot}</span>
        <span class="lot-normal"> - ${currentProcess}</span>
        <span class="lot-strong lot-pbo">
          - PBO:${lot.pbo}
        </span>
        <span class="lot-strong lot-fail"
              style="color:${lot.fail > 0 ? '#dc2626' : '#111827'}">
         - Fail:${lot.fail}
        </span>
      </div>
      <table class="pbo-table">
        <tr>
          <th>Process</th>
          <th>Input</th>
          <th>Output</th>
          <th>PBO</th>
          <th>Fail</th>
        </tr>
        ${(lot.rows || []).map(r => `
          <tr>
            <td>${r.process}</td>
            <td>${r.in}</td>
            <td>${r.out}</td>
            <td><span style="font-weight:600">${r.pbo}</span></td>
            <td>
              ${
                r.fail > 0
                  ? `<span style="color:#dc2626;font-weight:600">${r.fail}</span>
                     ${
                       r.failure_detail
                         ? `<div style="font-size:10px;color:#b91c1c">
                            ${Object.entries(r.failure_detail)
                              .map(([name, qty]) => `${name}: ${qty}`)
                              .join("<br>")}
                           </div>`
                         : ""
                     }`
                  : `<span>0</span>`
              }
            </td>
          </tr>
        `).join("")}
      </table>
    `;
  });
}

function exportPBOToExcel() {
  let rows = [];
  pboData.forEach(cfg => {
    (cfg.lots || []).forEach(lot => {
      const info = lot._buildInfo || {};
      lot.rows.forEach(r => {
        rows.push({
          Config: cfg.config,
          Phase: info.phase || "",
          Build: info.buildGroup || "",
          Lot: lot.lot,
          Process: r.process,
          Input: r.in,
          Output: r.out,
          PBO: r.pbo,
          Std_PBO: r.std_pbo,
          Fail: r.fail,
        });
      });
    });
  });
  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "PBO");
  XLSX.writeFile(workbook, "PBO_QTY_By_Process_CentaurA.xlsx");
}

function formatDurationFromMinutes(minutes) {
  if (!Number.isFinite(minutes) || minutes < 0) return "0h";
  const totalMinutes = Math.floor(minutes);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const mins = totalMinutes % 60;
  let parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (days === 0 && hours === 0) parts.push(`${mins}m`);
  return parts.join(" ");
}

function timeToIntensity(minutes) {
  if (minutes >= 180) return "i-100";
  if (minutes >= 120) return "i-80";
  if (minutes >= 60)  return "i-60";
  if (minutes >= 30)  return "i-40";
  return "i-20";
}

function resetPhaseFilter() {
  selectedPhases = null;
  const phaseDropdown = document.getElementById("phaseDropdown");
  if (phaseDropdown) {
    phaseDropdown
      .querySelectorAll("input[type='checkbox']")
      .forEach(cb => {
        cb.checked = false;
      });
  }
  const phaseLabel = document.querySelector(".phase-label");
  if (phaseLabel) {
    phaseLabel.textContent = "Select Phase";
  }
  loadProcessRealtime();
}

function getFilteredPBOLotsForChart() {
  const lots = [];
  pboData.forEach(cfg => {
    (cfg.lots || []).forEach(lot => {
      const info = lot._buildInfo;
      if (!info) return;
      if (
        selectedPBOBuildGroups &&
        !selectedPBOBuildGroups.includes(info.buildGroup)
      ) {
        return;
      }
      if (
        selectedPBOLotTypes &&
        !selectedPBOLotTypes.includes(info.lotTypeDisplay)
      ) {
        return;
      }
      lots.push(lot);
    });
  });
  return lots;
}

function renderConfigChip(phaseHeader) {
  const el = document.getElementById("phaseHeaderRight");
  if (!el) return;
  el.innerHTML = "";
  const label = document.createElement("span");
  label.className = "legend-title";
  label.textContent = "";
  el.appendChild(label);
  phaseHeader.forEach(p => {
    const chip = document.createElement("span");
    let cls = "phase-chip ";
    if (p.finished) cls += "finished";
    else if (p.active) cls += "active";
    else cls += "inactive";
    chip.className = cls;
    chip.textContent = p.phase;
    el.appendChild(chip);
  });
}

function getLotColor(name, idx) {
  const colors = [
    "#2563eb", "#16a34a", "#f59e0b", "#dc2626",
    "#7c3aed", "#0891b2", "#ea580c", "#9333ea",
    "#0f766e", "#c2410c"
  ];
  return colors[idx % colors.length];
}

function buildYieldSeriesMulti(lots, chartProcesses) {
  const buildMap = {};
  lots.forEach(lot => {
    const build = lot._buildInfo?.buildGroup || "UNKNOWN";
    if (!buildMap[build]) buildMap[build] = {};
    (lot.final_rows || []).forEach(r => {
      if (r.yield == null) return;
      if (!buildMap[build][r.process]) {
        buildMap[build][r.process] = [];
      }
      buildMap[build][r.process].push(Number(r.yield));
    });
  });
  return Object.entries(buildMap).map(([build, procMap], idx) => ({
    name: build,
    type: "line",
    smooth: true,
    symbol: "circle",
    symbolSize: 6,
    lineStyle: {
      width: 3,
      color: getLotColor(build, idx)
    },
    itemStyle: {
      color: getLotColor(build, idx)
    },
    data: chartProcesses.map(p => {
      const arr = procMap[p];
      if (!arr) return null;
      return arr.reduce((a, b) => a + b, 0) / arr.length;
    })
  }));
}

function renderProcessFlowChart() {
  if (!pboData || !pboData.length) return;
  let lots = chartFollowPBO
    ? getLotsForCurrentBuild()
    : getLotsForChartView();
  if (!lots.length) {
    chart.clear();
    return;
  }
  const buildMap = {};
  lots.forEach(lot => {
    if (!lot._buildInfo) return;
    let build = lot._buildInfo.buildGroup || "UNKNOWN";
    build = build.replace(/\s+\d+$/, "");
    if (!buildMap[build]) {
      buildMap[build] = {
        input: 0,
        output: 0,
        failMap: {},
        failTotal: 0
      };
    }
    const finalRows = lot.final_rows || [];
    const processRows = lot.rows || [];
    if (!finalRows.length) return;
    const vsaRow = finalRows.find(r =>
      (r.process || "").toUpperCase().includes("VSA PNP")
    );
    const inputQTY = Number(
      vsaRow?.in ??
      vsaRow?.input ??
      vsaRow?.in_qty ??
      vsaRow?.input_qty ??
      0
    );
    buildMap[build].input += inputQTY;
    let output = 0;
    let foundIdx = -1;
    const procList = lastRealtimeData?.rows || [];
    procList.forEach((r, idx) => {
      Object.values(r.cells || {}).forEach(arr => {
        (arr || []).forEach(l => {
          if (l.full === lot.lot) foundIdx = idx;
        });
      });
    });
    if (foundIdx >= 0) {
      for (let i = foundIdx; i >= 0; i--) {
        const row = procList[i];
        Object.values(row.cells || {}).forEach(arr => {
          (arr || []).forEach(l => {
            if (l.full === lot.lot) {
              const val = Number(
                l.output_qty ?? l.input_qty ?? l.input ?? 0
              );
              if (val > 0 && output === 0) output = val;
            }
          });
        });
        if (output > 0) break;
      }
    }
    buildMap[build].output += output;
    processRows.forEach(r => {
      const detail = r.failure_detail || {};
      Object.entries(detail).forEach(([name, qty]) => {
        buildMap[build].failMap[name] =
          (buildMap[build].failMap[name] || 0) + Number(qty || 0);
        buildMap[build].failTotal += Number(qty || 0);
      });
    });
  });
  const builds = Object.keys(buildMap);
  if (!builds.length) {
    chart.clear();
    return;
  }
  const failureRateList = builds.map(b => {
    const { output, failTotal } = buildMap[b];
    const denom = output + failTotal;
    return denom > 0 ? (failTotal / denom) * 100 : 0;
  });
  const totalFailList = builds.map(b => buildMap[b].failTotal);
  const failureTypes = new Set();
  builds.forEach(b => {
    Object.keys(buildMap[b].failMap).forEach(f => failureTypes.add(f));
  });
  const barSeries = Array.from(failureTypes).map((failType, idx) => ({
    name: failType,
    type: "bar",
    stack: "fail",
    yAxisIndex: 0,
    itemStyle: {
      color: getLotColor(failType, idx)
    },
    data: builds.map((b, i) => {
      const fail = buildMap[b].failMap[failType] || 0;
      const totalFail = buildMap[b].failTotal || 0;
      if (totalFail === 0) return 0;
      const rate = failureRateList[i] / 100;
      return (fail / totalFail) * rate * 100;
    })
  }));
  const inputList = builds.map(b => buildMap[b].input);
  chartHeader.innerHTML = "Config Performance Chart";
  chart.setOption({
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      confine: true,
      textStyle: {
        fontSize: 11
      },
      formatter: function (params) {
        const idx = params[0].dataIndex;
        const build = builds[idx];
        const info = buildMap[build];
        let html = `<b>${build}</b><br/>`;
        html += `Input: ${info.input}<br/>`;
        html += `Output: ${info.output}<br/>`;
        html += `<span style="color:#dc2626">Fail: ${info.failTotal}</span><br/>`;
        const rate = failureRateList[idx].toFixed(2);
        html += `<span style="color:#2563eb">Rate: ${rate}%</span><br/><br/>`;
        params.forEach(p => {
          if (p.seriesType === "bar") {
            const failQty = buildMap[build].failMap[p.seriesName] || 0;
            if (failQty > 0) {
              html += `${p.marker} ${p.seriesName}: ${failQty}<br/>`;
            }
          }
        });
        return html;
      }
    },
    legend: {
      bottom: 6,
      left: "center",
      width: "90%",
      textStyle: { fontSize: 9 }
    },
    grid: {
      top: 50,
      left: 70,
      right: 90,
      bottom: 110,
      containLabel: true
    },
    xAxis: {
      type: "category",
      data: builds,
      axisLabel: {
        rotate: 45,
        interval: 0,
        margin: 12,
        fontSize: 9
      }
    },
    yAxis: [
      {
        type: "value",
        name: "Failure Rate (%)",
        min: 0,
        max: Math.ceil(Math.max(...failureRateList, 1) + 5),
        axisLabel: {
          formatter: "{value}%"
        },
        splitLine: { show: true }
      },
      {
        type: "value",
        name: "Input Quantity",
        position: "right",
        splitLine: { show: false }
      }
    ],
    series: [
      ...barSeries.map((s, idx, arr) => {
        const isTop = idx === arr.length - 1;
        return {
          ...s,
          label: isTop ? {
            show: true,
            position: "top",
            fontSize: 10,
            fontWeight: "600",
            color: "#dc2626",
            formatter: p => {
              const i = p.dataIndex;
              const fail = totalFailList[i];
              const rate = failureRateList[i].toFixed(2);
              return `${fail} - ${rate}%`;
            }
          } : undefined
        };
      }),
      {
        name: "Input QTY",
        type: "line",
        yAxisIndex: 1,
        symbol: "circle",
        symbolSize: 6,
        lineStyle: {
          width: 2,
          color: "#facc15"
        },
        itemStyle: {
          color: "#facc15"
        },
        label: {
          show: true,
          position: "top",
          distance: 18,
          backgroundColor: "#facc15",
          color: "#000",
          padding: [2, 4],
          borderRadius: 2,
          fontSize: 10,
          formatter: p => inputList[p.dataIndex]
        },
        data: inputList
      }
    ]
  }, true);
}

function setupChartDropdown(id) {
  const dropdown = document.getElementById(id);
  if (!dropdown) return;
  const label = dropdown.querySelector(".dropdown-label");
  const menu = dropdown.querySelector(".dropdown-menu");
  label.onclick = (e) => {
    e.stopPropagation();
    menu.classList.toggle("hidden");
  };
  menu.onclick = (e) => {
    e.stopPropagation();
  };
  document.addEventListener("click", (e) => {
    if (!dropdown.contains(e.target)) {
      menu.classList.add("hidden");
    }
  });
}

function onChartBuildFilterChange(menuEl) {
  chartFollowPBO = false;
  selectedChartBuildGroups = Array.from(
    menuEl.querySelectorAll("input:checked")
  ).map(x => x.value);
  if (!selectedChartBuildGroups.length) {
    selectedChartBuildGroups = null;
  }
  renderProcessFlowChart();
}

function onChartLotFilterChange(menuEl) {
  chartFollowPBO = false;
  selectedChartLotTypes = Array.from(
    menuEl.querySelectorAll("input:checked")
  ).map(x => x.value);
  if (!selectedChartLotTypes.length) {
    selectedChartLotTypes = null;
  }
  renderProcessFlowChart();
}

function getLotsForCurrentBuild() {
  const lots = [];
  pboData.forEach(cfg => {
    (cfg.lots || []).forEach(lot => {
      const info = lot._buildInfo;
      if (!info) return;
      if (selectedPBOBuildGroups &&
          !selectedPBOBuildGroups.includes(info.buildGroup)) return;
      if (selectedPBOLotTypes &&
          !selectedPBOLotTypes.includes(info.lotTypeDisplay)) return;
      lots.push(lot);
    });
  });
  return lots;
}

document.getElementById("phaseResetBtn")
  ?.addEventListener("click", e => {
    e.preventDefault();
    e.stopPropagation();
    resetPhaseFilter();
  });

document.getElementById("chartResetBtn")
  .addEventListener("click", resetChartFilter);

window.openSubDashboard = function () {
  window.open(
    "/NPI_CentaurA/sub",
    "_blank"
  );
};

(async function init() {
  await loadProcessRealtime();
  await loadPBO(true);
  setupPBOPauseOnHover();
})();

setInterval(() => {
  loadProcessRealtime();
}, 15000);
window.addEventListener("resize", () => chart.resize());
