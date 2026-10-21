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

const API_BASE = "/NPI_EOS";
const PBO_ROTATE_NO_SCROLL_DELAY = 20000;
const YIELD_COLOR = "#22c55e";
const selectedBuildsByPhase = {};

function shortBuildName(build) {
  if (!build) return "";
  let s = build
    .replace(/EOS\s*-?T\s*-?/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = s.split(" ");
  const projIdx = tokens.findIndex(
    t => /^C?\d{4}$/.test(t)
  );
  if (projIdx === -1) return s;
  const tail = tokens.slice(projIdx + 1).filter(t => !/^\d+$/.test(t));
  return tail.join(" ");
}

function getBuildGroupKey(build) {
  if (!build || typeof build !== "string") return "";
  const raw = build.replace(/-/g, " ").replace(/\s+/g, " ").trim();
  const parts = raw.split(" ");
  const lotIdx = parts.findIndex(
    p => /^C?\d{4,}/i.test(p)
  );
  if (lotIdx === -1) return raw;
  let lotNo = parts[lotIdx].toUpperCase();
  if (/^\d{4}$/.test(lotNo)) {
    lotNo = `C${lotNo}`;
  }
  const mainIdx = parts.findIndex(
    (p, idx) => idx > lotIdx && p.toUpperCase() === "MAIN"
  );
  if (mainIdx !== -1) {
    return `${lotNo} MAIN`;
  }
  let i = lotIdx + 1;
  const suffixParts = [];
  while (i < parts.length && /^[A-Z]+$/i.test(parts[i])) {
    suffixParts.push(parts[i]);
    i++;
  }
  return suffixParts.length
    ? `${lotNo} ${suffixParts.join(" ")}`
    : lotNo;
}

let procMode = "all";
document.querySelectorAll("input[name='procMode']").forEach(r => {
  r.addEventListener("change", e => {
    procMode = e.target.value;
    loadProcessRealtime();
  });
});

let globalPhaseHeader = null;
let pboViewMode = "LOT";
let isPBOUserFiltering = false;
let selectedPBOMainOnly = false;
let chartFollowPBO = true;
let pboPendingReachBottom = null;
let selectedPBOBuilds = null;
let selectedChartBuildGroups = null;
let selectedChartLotTypes = null;
let lastRealtimeData = null;
let needReloadProcess = false;
let allPBOData = [];
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

function passBuildFilter(lot) {
  if (!selectedPBOBuildGroups) return true;
  return selectedPBOBuildGroups.includes(
    lot._buildInfo?.buildFamily
  );
}

function getLotsForChartView() {
  const lots = [];
  pboData.forEach(cfg => {
    (cfg.lots || []).forEach(lot => {
      const info = lot._buildInfo;
      if (!info) return;

      if (
        selectedChartBuildGroups &&
        !selectedChartBuildGroups.includes(info.buildFamily)
      ) return;
      if (
        selectedChartLotTypes &&
        !selectedChartLotTypes.includes(info.lotType)
      ) return;
      lots.push(lot);
    });
  });
  return lots;
}

function getMinYieldPerLot(data) {
  const map = {};
  data.forEach(row => {
    const key = `${row["Lot Number"]}||${row["Station Name"]}`;
    const y = parseFloat((row["Station Yield"] || "").replace("%", ""));
    if (isNaN(y)) return;
    if (!map[key]) {
      map[key] = y;
    } else {
      map[key] = Math.min(map[key], y);
    }
  });
  return map;
}

function calcStationYield(data, selectedLot) {
  const lotStationMap = getMinYieldPerLot(data);
  const stationLotValues = {};
  Object.keys(lotStationMap).forEach(key => {
    const [lot, station] = key.split("||");
    const value = lotStationMap[key];
    if (selectedLot) {
      if (lot === selectedLot) {
        stationLotValues[station] = value;
      }
      return;
    }
    if (!stationLotValues[station]) {
      stationLotValues[station] = [];
    }
    stationLotValues[station].push(value);
  });
  const result = {};
  Object.keys(stationLotValues).forEach(station => {
    const arr = stationLotValues[station];
    if (selectedLot) {
      result[station] = arr;
    } else {
      const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
      result[station] = avg;
    }
  });
  return result;
}

function calcOverallYield(yieldList) {
  const valid = yieldList.filter(v => typeof v === "number");
  if (!valid.length) return null;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
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
    if (isPBOUserFiltering === true) {
      PBOEngine.paused = true;
      setTimeout(() => {
        el.scrollTop = 0;
        PBOEngine.lastFrameTime = 0;
        PBOEngine.paused = false;
        requestAnimationFrame(pboScrollLoop);
      }, 5000);
      return;
    }
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
        buildGroups.add(lot._buildInfo.buildFamily);
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
      chartFollowPBO = true;
      selectedChartBuildGroups = Array.from(
        menu.querySelectorAll("input:checked")
      ).map(x => x.value);
      if (!selectedChartBuildGroups.length) {
        selectedChartBuildGroups = null;
      }
      selectedPBOBuildGroups = selectedChartBuildGroups;
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
        selectedChartBuildGroups.includes(info.buildFamily)
      ) {
        lotTypes.add(info.lotType);
      }
    });
  });
  Array.from(lotTypes).sort().forEach(lt => {
    const row = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = lt;
    cb.addEventListener("change", () => {
      chartFollowPBO = true;
      selectedChartLotTypes = Array.from(
        menu.querySelectorAll("input:checked")
      ).map(x => x.value);
      if (!selectedChartLotTypes.length) {
        selectedChartLotTypes = null;
      }
      label.textContent = selectedChartLotTypes
        ? selectedChartLotTypes.join(", ")
        : "Select Lot";
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
        set.add(lot._buildInfo.buildFamily);
      }
    });
  });
  return Array.from(set);
}

function getLotColor(name, idx) {
  const palette = [
    "#2563eb","#16a34a","#f59e0b","#dc2626",
    "#7c3aed","#0891b2","#ea580c","#9333ea",
    "#0f766e","#c2410c"
  ];
  return palette[idx % palette.length];
}

function normalizeBuildString(rawBuild) {
  if (!rawBuild || typeof rawBuild !== "string") return null;
  let s = rawBuild.replace(/(\d+)-(\d+)/g, "$1§$2");
  s = s
    .replace(/EOS/gi, "")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
  s = s.replace(/§/g, "-");
  const tokens = s.split(" ");
  const modelIdx = tokens.findIndex(
    t => /^C?\d{4}$/.test(t)
  );
  if (modelIdx === -1) return null;
  let model = tokens[modelIdx].toUpperCase();
  if (/^\d{4}$/.test(model)) {
    model = `C${model}`;
  }
  const hasT   = tokens.slice(0, modelIdx).includes("T");
  let lotType = tokens.slice(modelIdx + 1)[0] || "UNKNOWN";
  let mainIndex = "";
  let subIndex = "";
  const matchPair = s.match(/\b(\d+)-(\d+)\b/);
  if (matchPair) {
    mainIndex = matchPair[1];
    subIndex  = matchPair[2];
  } else {
    const matchSingle = s.match(/\b(\d+)\b/);
    if (matchSingle) {
      mainIndex = matchSingle[1];
    }
  }
  return {
    lotBadge: subIndex
      ? `${model} ${lotType} ${mainIndex}-${subIndex}`
      : `${model} ${lotType} ${mainIndex}`,
    buildGroup: `${hasT ? "T " : ""}${model} ${lotType} ${mainIndex}`.trim(),
    buildFamily: `${hasT ? "T " : ""}${model} ${lotType}`.trim(),
    model,
    lotType,
    lotTypeDisplay: lotType,
    mainIndex,
    subIndex,
  };
}

function normalizeLotGroup(lotLabel) {
  if (!lotLabel || typeof lotLabel !== "string") return null;
  const m = lotLabel.trim().match(/^([A-Z]+)(\s+\d+([-]\d+)*)?$/i);
  return m ? m[1].toUpperCase() : lotLabel;
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

async function loadProcessRealtime() {
  const qs = new URLSearchParams();
  if (Array.isArray(selectedPhases)) {
    qs.set("phase", selectedPhases.join(","));
  }
  const res = await fetch(`${API_BASE}/api/process_realtime?${qs}`);
  const data = await res.json();
  const srcEl = document.getElementById("dataSource");
    if (srcEl && data.source_file) {
      if (data.source_updated) {
        srcEl.textContent = `Source: ${data.source_file} (Updated: ${data.source_updated})`;
      } else {
        srcEl.textContent = `Source: ${data.source_file}`;
      }
    }
  lastRealtimeData = data;
  if (Array.isArray(data.phase_header)) {
    if (!globalPhaseHeader) {
      globalPhaseHeader = data.phase_header;
    }
    renderConfigChip(globalPhaseHeader);
  }
  const displayPhases =
    Array.isArray(selectedPhases) && selectedPhases.length
      ? data.display_phases
      : data.all_phases;
  allPhases = displayPhases;
  document.documentElement.style.setProperty("--phase-count", allPhases.length);
  phaseHeader.innerHTML = "";
  const phaseCount = {};
  data.all_phases.forEach(ph => {
    let count = 0;
    data.rows.forEach(r => {
      count += (r.cells?.[ph] || []).length;
    });
    phaseCount[ph] = count;
  });
  allPhases.forEach(ph => {
    const buildSet = new Set();
    const mainBuildsSet = new Set();
    data.rows.forEach(r => {
      const cellLots = r.cells?.[ph] || [];
      cellLots.forEach(l => {
        if (typeof l.build === "string") {
          const group = getBuildGroupKey(l.build);
          if (group) buildSet.add(group);
          if (
            typeof l.build === "string" &&
            l.build.toUpperCase().includes("MAIN")
          ) {
            mainBuildsSet.add(l.lot);
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
        selectedBuildsByPhase[ph] = [`${ph} MAIN`];
        renderProcessBodyFromData(lastRealtimeData);
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
      title.onclick = e => {
      e.stopPropagation();
      Object.keys(selectedBuildsByPhase).forEach(k => {
        selectedBuildsByPhase[k] = [];
      });
      loadProcessRealtime();
    };
    };
    allRow.append(allCb, " All");
    dropdown.appendChild(allRow);
    const groupMap = new Map();
    builds.forEach(b => {
      const key = b;
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
              selectedBuildsByPhase[ph].filter(
                b => !rawBuilds.includes(b)
              );
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
    document
      .querySelectorAll(".build-dropdown")
      .forEach(dd => dd.classList.add("hidden"));
  });
  renderProcessBodyFromData(data);
  renderPhaseFilter(data.all_phases);
}

function renderConfigChip(phaseHeader) {
  const el = document.getElementById("phaseHeaderRight");
  if (!el) return;
  el.innerHTML = "";
  const label = document.createElement("span");
  label.className = "legend-title";
  el.appendChild(label);
  const normalized = (phaseHeader || []).map(p => {
    if (typeof p === "object" && p !== null) return p;
    return { phase: String(p), active: true, finished: false };
  });
  const activePhases = normalized.map(p => p.phase);
  const prefixSet = new Set(
    activePhases.map(ph => ph.substring(0, 2))
  );
  let configSource = [];
  if (window.config_phases) {
    configSource = window.config_phases;
  } else if (lastRealtimeData?.config_phases) {
    configSource = lastRealtimeData.config_phases;
  }
  if (!Array.isArray(configSource) || !configSource.length) {
    return;
  }
  const fullList = configSource
    .map(c => String(c))
    .filter(cfg => {
      if (cfg.length <= 3) return false;
      return [...prefixSet].some(prefix =>
        cfg.startsWith(prefix)
      );
    })
    .sort();
  fullList.forEach(cfg => {
    const chip = document.createElement("span");
    const original = normalized.find(p => p.phase === cfg);
    let cls = "phase-chip ";
    if (original?.finished) cls += "finished";
    else if (activePhases.includes(cfg)) cls += "active";
    else cls += "inactive";
    chip.className = cls;
    chip.textContent = cfg;
    el.appendChild(chip);
  });
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
        <div class="c-process">${r.process}</div>
        ${allPhases.map(ph => {
          const lots = (r.cells[ph] || []).filter(l => {
            const sel = selectedBuildsByPhase[ph];
            if (!sel || sel.length === 0) return true;
            return sel.includes(getBuildGroupKey(l.build));
          });
          let cellClass = "";
          if (lots.length > 10) {
            cellClass = "cell-many";
          } else if (lots.length > 5) {
            cellClass = "cell-mid";
          }
          return `
            <div class="phase-cell ${cellClass}">
              ${(() => {
                const mp = r.__mp_status__?.[ph];
                if (!mp) return "";
                return renderCellMPBadge(mp);
              })()}
              <div class="phase-left">
                ${lots.map(l => {
                  const badgeText = l.lot
                    ? l.lot.replace(/^C\d{4}\s+/i, "").trim()
                    : shortBuildName(l.build) || "";
                  let statusText = "";
                  const procName = l.current_process || r.process || "";
                  if (l.time_type === "Finished") {
                    statusText = `Finished`;
                  } else if (l.time_type === "WORK") {
                    statusText = `Processing ${formatDurationFromMinutes(l.minutes)} in ${procName}`;
                  } else if (l.time_type === "Waiting") {
                    statusText = `Waiting ${formatDurationFromMinutes(l.minutes)} in ${procName}`;
                  } else if (l.time_type === "Offline") {
                    statusText = `Offline ${formatDurationFromMinutes(l.minutes)} in ${procName}`;
                  }
                  return `
                    <div class="lot-wrapper">
                      <div class="lot ${l.color} ${timeToIntensity(l.minutes || 0)}">
                        ${badgeText}
                      </div>
                      <div class="lot-tooltip ${l.color}">
                        <strong>Lot:</strong> ${l.full}<br>
                        <strong>Config:</strong> ${l.config}<br>
                        <strong>Build:</strong> ${badgeText}<br>
                        <strong>Input QTY:</strong> ${l.input_qty}<br>
                        ${statusText}
                      </div>
                    </div>
                  `;
                }).join("")}
              </div>
            </div>
          `;
        }).join("")}
      </div>
    `;
  });
}

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
      label.textContent = checked.length ? checked.join(", ") : "Select Phase";
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
  mapBuildToPBOLots(pboData);
  renderPBOHeaderWithFilters();
  renderPBOByBuild();
  renderProcessFlowChart();
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
  isPBOUserFiltering = false;
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
  renderProcessFlowChart();
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
  pboData.forEach(cfg => {
    (cfg.lots || []).forEach(lot => {
      const info = lot._buildInfo;
      if (!info) return;
      if (info.lotType.toUpperCase() !== "MAIN") return;
      const buildKey = info.model;
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
        (r.process || "").toUpperCase().includes("VSA PNP")
      );
      const input = Number(
        vsaRow?.input ??
        vsaRow?.in ??
        vsaRow?.input_qty ??
        vsaRow?.in_qty ??
        0
      );
      const last = lot.rows[lot.rows.length - 1];
      const output = Number(
        last.out ??
        last.output ??
        last.out_qty ??
        last.output_qty ??
        0
      );
      const pbo = Number(lot.pbo || 0);
      const fail = Nuber(lot.fail || 0);
      sumInput += input;
      sumOutput += output;
      sumPBO += pbo;
      sumFail += fail;
      let failDetailMap = {};
      lot.rows.forEach(r => {
        const detail = r.failure_detail || {};
        Object.entries(detail).forEach(([name, qty]) => {
          failDetailMap[name] = (failDetailMap[name] || 0) + qty;
          overallFailDetail[name] = (overallFailDetail[name] || 0) + qty;
        });
      });
      const failNameStr = Object.entries(failDetailMap)
        .map(([k, v]) => `${k}: ${v}`)
        .join("   |   ");
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
  XLSX.writeFile(workbook, "PBO_Summary_EOS.xlsx");
}

function populatePBOMainFilter() {
  const dropdown = document.getElementById("pboMainDropdown");
  const menu = dropdown?.querySelector(".dropdown-menu");
  const label = dropdown?.querySelector(".dropdown-label");
  if (!menu || !label) return;
  menu.innerHTML = "";
  const buildSet = new Set();
  pboData.forEach(cfg => {
    (cfg.lots || []).forEach(lot => {
      const info = lot._buildInfo;
      if (!info || !info.buildFamily) return;
      if (
        selectedPBOBuildGroups &&
        !selectedPBOBuildGroups.includes(info.buildFamily)
      ) return;
      buildSet.add(info.buildFamily);
    });
  });
  const mainBuilds = Array.from(buildSet).filter(b => b.includes(" MAIN"));
  const allRow = document.createElement("label");
  const allCb = document.createElement("input");
  allCb.type = "checkbox";
  allCb.checked = selectedPBOMainOnly === true;
  allCb.onchange = () => {
    selectedPBOMainOnly = allCb.checked;
    label.textContent = allCb.checked ? "ALL MAIN" : "Select MAIN";
    selectedPBOBuildGroups = allCb.checked ? [...mainBuilds] : null;
    renderPBOByBuild();
    populatePBOLotTypeFilter();
  };
  allRow.append(allCb, " ALL MAIN");
  menu.appendChild(allRow);
  mainBuilds.sort().forEach(build => {
    const row = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = build;
    cb.checked =
      Array.isArray(selectedPBOBuildGroups) &&
      selectedPBOBuildGroups.includes(build);
    cb.onchange = () => {
      selectedPBOMainOnly = true;
      isPBOUserFiltering = true;
      selectedPBOBuildGroups = selectedPBOBuildGroups || [];
      if (cb.checked) {
        if (!selectedPBOBuildGroups.includes(build)) {
          selectedPBOBuildGroups.push(build);
        }
      } else {
        selectedPBOBuildGroups =
          selectedPBOBuildGroups.filter(b => b !== build);
      }
      if (!selectedPBOBuildGroups.length) {
        selectedPBOMainOnly = false;
        selectedPBOBuildGroups = null;
      }
      label.textContent = selectedPBOMainOnly
        ? selectedPBOBuildGroups.join(", ")
        : "Select MAIN";
      renderPBOByBuild();
      populatePBOLotTypeFilter();
    };
    row.append(cb, " ", build);
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
  const buildFamilySet = new Set();
  pboData.forEach(cfg => {
    (cfg.lots || []).forEach(lot => {
      const info = lot._buildInfo;
      if (info?.buildFamily) {
        buildFamilySet.add(info.buildFamily);
      }
    });
  });
  menu.innerHTML = "";
  Array.from(buildFamilySet).sort().forEach(buildFamily => {
    const row = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = buildFamily;
    cb.checked =
      Array.isArray(selectedPBOBuildGroups) &&
      selectedPBOBuildGroups.includes(buildFamily);
    cb.onchange = () => {
      isPBOUserFiltering = true;
      selectedPBOBuildGroups = Array.from(
        menu.querySelectorAll("input:checked")
      ).map(x => x.value);
      if (!selectedPBOBuildGroups.length) {
        selectedPBOBuildGroups = null;
        selectedPBOMainOnly = false;
      }
      label.textContent = selectedPBOBuildGroups
        ? selectedPBOBuildGroups.join(", ")
        : "Select Build";
      populatePBOMainFilter();
      populatePBOLotTypeFilter();
      renderPBOByBuild();
    };
    row.append(cb, " ", buildFamily);
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
  const lotSet = new Set();
  pboData.forEach(cfg => {
    (cfg.lots || []).forEach(lot => {
      const info = lot._buildInfo;
      if (!info) return;
      if (
        selectedPBOBuildGroups &&
        !selectedPBOBuildGroups.includes(info.buildGroup)
      ) return;
      const lotKey = info.subIndex
        ? `${info.lotType} ${info.mainIndex}-${info.subIndex}`
        : `${info.lotType} ${info.mainIndex}`;
      lotSet.add(lotKey);
    });
  });
  if (!lotSet.size) {
    label.textContent = "No Lot";
    return;
  }
  label.textContent = selectedPBOLotTypes
    ? selectedPBOLotTypes.join(", ")
    : "Select Lot";
  Array.from(lotSet).sort().forEach(lotName => {
    const row = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = lotName;
    cb.checked =
      Array.isArray(selectedPBOLotTypes) &&
      selectedPBOLotTypes.includes(lotName);
    cb.onchange = () => {
      isPBOUserFiltering = true;
      selectedPBOLotTypes = Array.from(
        menu.querySelectorAll("input:checked")
      ).map(x => x.value);
      if (!selectedPBOLotTypes.length) {
        selectedPBOLotTypes = null;
      }
      label.textContent = selectedPBOLotTypes
        ? selectedPBOLotTypes.join(", ")
        : "Select Lot";
      renderPBOByBuild();
    };
    row.append(cb, " ", lotName);
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

function passMainFilter(lot) {
  if (!selectedPBOMainPhases) return true;
  const info = lot._buildInfo;
  if (!info) return false;
  const isMain =
    typeof info.lotType === "string" &&
    info.lotType.toUpperCase() === "MAIN";
  if (!isMain) return false;
  if (selectedPBOMainPhases.length === 0) return true;
  return selectedPBOMainPhases.includes(info.phase);
}

function passLotTypeFilter(lot) {
  if (!selectedPBOLotTypes) return true;
  const info = lot._buildInfo;
  if (!info) return false;
  const lotKey = info.subIndex
    ? `${info.lotType} ${info.mainIndex}-${info.subIndex}`
    : `${info.lotType} ${info.mainIndex}`;
  return selectedPBOLotTypes.includes(lotKey);
}

function renderPBOByBuild() {
  if (pboBody) pboBody.innerHTML = "";
  let lots = [];
  pboData.forEach(cfg => {
    (cfg.lots || []).forEach(lot => {
      const info = lot._buildInfo;
      if (!info || typeof info.buildFamily !== "string") return;
      if (
        Array.isArray(selectedPBOBuildGroups) &&
        selectedPBOBuildGroups.length > 0 &&
        !selectedPBOBuildGroups.includes(info.buildFamily)
      ) return;
      if (
        selectedPBOMainOnly === true &&
        !info.buildFamily.includes(" MAIN")
      ) return;
      if (
          Array.isArray(selectedPBOLotTypes) &&
          selectedPBOLotTypes.length > 0
      ) {
        const lotKey = info.subIndex
          ? `${info.lotType} ${info.mainIndex}-${info.subIndex}`
          : `${info.lotType} ${info.mainIndex}`;
        if (!selectedPBOLotTypes.includes(lotKey)) return;
      }
      lots.push(lot);
    });
  });
  const headerEl = document.querySelector(
    "#pbo-panel .panel-header .pbo-header-left strong"
  );
  const buildSet = new Set(
    lots.map(l => l._buildInfo?.buildFamily).filter(Boolean)
  );
  if (headerEl) {
    if (buildSet.size === 0) {
      headerEl.textContent = "PBO QTY by Process - Build: None";
    } else if (buildSet.size === 1) {
      headerEl.textContent =
        "PBO QTY by Process - Build: " + Array.from(buildSet)[0];
    } else {
      headerEl.textContent =
        "PBO QTY by Process - Build: Multiple";
    }
  }
  if (!lots.length) {
    return;
  }
  const groupMap = {};
  lots.forEach(lot => {
    const key = lot._buildInfo?.buildFamily || "UNKNOWN";
    if (!groupMap[key]) {
      groupMap[key] = [];
    }
    groupMap[key].push(lot);
  });
  Object.entries(groupMap).forEach(([buildKey, groupLots]) => {
    renderPBO({
      config: buildKey,
      lots: groupLots
    });
  });
}

function mapBuildToPBOLots(pboData) {
  pboData.forEach(cfg => {
    (cfg.lots || []).forEach(lot => {
      const rawBuild = lot.build;
      if (!rawBuild || typeof rawBuild !== "string") return;
      const info = normalizeBuildString(rawBuild);
      if (!info) return;
      lot._rawBuild = rawBuild;
      lot._buildInfo = info;
    });
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

function renderPBO(cfg) {
  const lots = cfg.lots || [];
  function normProc(s) {
    return String(s || "")
      .toUpperCase()
      .replace(/\s+/g, " ")
      .replace(/[^A-Z ]/g, "")
      .trim();
  }
  if (pboViewMode === "CONFIG") {
    const processMap = {};
    let totalInput = 0;
    let totalOutput = 0;
    let totalPBO = 0;
    let totalFail = 0;
    lots.forEach((lot, lotIdx) => {
      const flowRows = lot.final_rows || [];
      const pboRows  = lot.rows || [];
      let lotInput = null;
      const inputMap = {};
      const outputMap = {};
      flowRows.forEach(r => {
        const key = r.process;
        if (!inputMap[key]) inputMap[key] = 0;
        const inVal = Number(r.in_qty ?? r.input_qty ?? r.in ?? r.input ?? 0);
        inputMap[key] = Math.max(inputMap[key], inVal);
        const proc = normProc(r.process);
        if (proc.includes("VSA PNP") && lotInput === null) {
          lotInput = inVal;
        }
      });
      pboRows.forEach(r => {
        const key = r.process;
        if (!outputMap[key]) outputMap[key] = 0;
        const outVal = Number(
          r.out_qty ??
          r.output_qty ??
          r["Output QTY"] ??
          r.out ??
          r.output ??
          0
        );
        outputMap[key] = Math.max(outputMap[key], outVal);
      });
      if (lotInput !== null) totalInput += lotInput;
      const lotOutputs = Object.values(outputMap)
        .filter(v => typeof v === "number" && v > 0);
      if (lotOutputs.length) {
        const lotFinalOutput = Math.min(...lotOutputs);
        totalOutput += lotFinalOutput;
      }
      pboRows.forEach(r => {
        const key = r.process;
        if (!processMap[key]) {
          processMap[key] = {
            process: key,
            input: 0,
            output: 0,
            pbo: 0,
            std: 0,
            fail: 0,
            failDetail: {},
            pboByLot: []
          };
        }
        const pboVal  = Number(r.pbo || 0);
        const failVal = Number(r.fail || 0);
        const stdVal  = Number(r.std_pbo || 0);
        processMap[key].input  += (inputMap[key]  || 0);
        processMap[key].output += (outputMap[key] || 0);
        processMap[key].pbo  += pboVal;
        processMap[key].fail += failVal;
        processMap[key].std  = stdVal;
        if (pboVal > 0) {
          processMap[key].pboByLot.push({
            lot:
              lot.full ||
              lot.lot_number ||
              lot.lot ||
              `Lot ${lotIdx + 1}`,
            val: pboVal
          });
        }
        if (r.failure_detail) {
          Object.entries(r.failure_detail).forEach(([name, qty]) => {
            processMap[key].failDetail[name] =
              (processMap[key].failDetail[name] || 0) + qty;
          });
        }
        totalPBO += pboVal;
        totalFail += failVal;
      });
    });
    const rows = Object.values(processMap);
    pboBody.innerHTML += `
      <div class="lot-title">
        <span class="lot-strong">${cfg.config}</span>
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
              <div style="font-weight:600;color:${r.pbo > r.std ? '#dc2626' : '#111827'}">
                ${r.pbo}${r.std > 0 ? `<span style="font-size:11px; margin-left:2px">/${r.std}</span>` : ""}
              </div>
              ${
                r.pboByLot.length
                  ? `<div style="font-size:11px">
                      ${r.pboByLot.map(x => `${x.lot}: ${x.val}`).join("<br>")}
                     </div>`
                  : ""
              }
            </td>
            <td>
              ${
                r.fail > 0
                  ? `
                  <span style="color:#dc2626;font-weight:600">${r.fail}</span>
                  ${
                    Object.keys(r.failDetail).length
                      ? `<div style="font-size:10px;color:#b91c1c">
                          ${Object.entries(r.failDetail)
                            .map(([name, qty]) => `${name}: ${qty}`)
                            .join("<br>")}
                         </div>`
                      : ""
                  }
                  `
                  : "0"
              }
            </td>
          </tr>
        `).join("")}
      </table>
    `;
    return;
  }
  const showPhaseInLotHeader =
    !Array.isArray(selectedPBOBuildGroups) ||
    selectedPBOBuildGroups.length !== 1;
  lots.forEach(lot => {
    const info = lot._buildInfo;
    let lotLabel = "N/A";
    if (info) {
      const idx = info.subIndex
        ? `${info.mainIndex}-${info.subIndex}`
        : info.mainIndex || "";
      lotLabel = [
        info.model,
        info.lotType,
        idx
      ]
        .filter(Boolean)
        .join(" ");
    }
    const phase = info?.phase || "";
    const currentProcess = getCurrentProcessOfLot(
      lot.lot,
      lastRealtimeData,
      cfg.process_order
    );
    pboBody.innerHTML += `
      <div class="lot-title">
        ${showPhaseInLotHeader ? `<span class="lot-strong">${phase} </span>` : ""}
        <span class="lot-strong">${lotLabel}</span>
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
            <td>
              <span style="font-weight:600">
                ${r.pbo}
              </span>
            </td>
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
  XLSX.writeFile(workbook, "PBO_QTY_By_Process_EOS.xlsx");
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
        !selectedPBOBuildGroups.includes(info.buildFamily)
      ) {
        return;
      }
      if (selectedPBOLotTypes) {
        const lotKey = info.subIndex
          ? `${info.lotType} ${info.mainIndex}-${info.subIndex}`
          : `${info.lotType} ${info.mainIndex}`;
        if (!selectedPBOLotTypes.includes(lotKey)) return;
      }
      lots.push(lot);
    });
  });
  return lots;
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
    processRows.forEach(r => {
      if (r.out) output = r.out;
    });
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
  const barSeries = Array.from(failureTypes).map((failType, idx, arr) => ({
    name: failType,
    type: "bar",
    stack: "fail",
    yAxisIndex: 0,
    itemStyle: {
      color: getLotColor(failType, idx)
    },
    data: builds.map((b, i) => {
      const fail = buildMap[b].failMap[failType] || 0;
      const total = buildMap[b].failTotal || 0;
      if (!total) return 0;
      const rate = failureRateList[i] / 100;
      return (fail / total) * rate * 100;
    }),
    label: idx === arr.length - 1 ? {
      show: true,
      position: "top",
      fontSize: 9,
      fontWeight: "600",
      color: "#dc2626",
      formatter: p => {
        const i = p.dataIndex;
        const fail = totalFailList[i];
        const rate = failureRateList[i].toFixed(2);
        return `${fail} - ${rate}%`;
      }
    } : undefined
  }));
  const inputList = builds.map(b => buildMap[b].input);
  const inputLine = {
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
      distance: 15,
      backgroundColor: "#facc15",
      color: "#000",
      padding: [2, 4],
      borderRadius: 2,
      fontSize: 9,
      formatter: p => inputList[p.dataIndex]
    },
    data: inputList
  };
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
      width: "85%",
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
        }
      },
      {
        type: "value",
        name: "Input Quantity",
        position: "right"
      }
    ],
    series: [
      ...barSeries,
      inputLine
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
      if (
        selectedPBOBuildGroups &&
        !selectedPBOBuildGroups.includes(info.buildFamily)
      ) return;
      if (selectedChartLotTypes) {
        const lotKey = info.subIndex
          ? `${info.lotType} ${info.mainIndex}-${info.subIndex}`
          : `${info.lotType} ${info.mainIndex}`;
        if (!selectedChartLotTypes.includes(lotKey)) return;
      }
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

(async function init() {
  await loadProcessRealtime();
  await loadPBO(true);
  setupPBOPauseOnHover();
})();

setInterval(() => {
  loadProcessRealtime();
}, 15000);
window.addEventListener("resize", () => chart.resize());
