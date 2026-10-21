#!/usr/bin/.env python3
from pathlib import Path
import os
import pandas as pd
from flask import Flask, jsonify, render_template, request
import csv
import re
from pathlib import Path
from datetime import datetime
def create_app(base_dir: Path):
    def build_to_lot_label(build: str) -> str:
        if not build:
            return ""
        b = build.strip()
        dash_parts = b.split("-")
        if len(dash_parts) >= 3:
            return "-".join(dash_parts[2:]).strip()
        if " " in b:
            return b.split(" ", 1)[1].strip()
        return b

    def normalize_process(p: str) -> str:
        return " ".join(p.strip().lower().split())

    def load_std_pbo_map(csv_path=None):
        if csv_path is None:
            csv_path = BASE_DIR / "Process_order.csv"
        std_pbo_map = {}
        with open(csv_path, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for r in reader:
                proc = normalize_process(r["Process"])
                try:
                    std_pbo = int(r["PBO"])
                except:
                    std_pbo = 0
                std_pbo_map[proc] = std_pbo
        return std_pbo_map

    def safe_int(val):
        try:
            return int(pd.to_numeric(val, errors="coerce") or 0)
        except Exception:
            return 0

    BASE_DIR = Path(__file__).resolve().parent
    DATA_DIR = BASE_DIR.parent / "data" / "CenA" / "final_check"
    DATA_DIR_SUB = BASE_DIR.parent / "data" / "CenA" / "Sub-Inline" / "final_check"

    app = Flask(
        __name__,
        template_folder=str(BASE_DIR / "templates"),
        static_folder=str(BASE_DIR / "static")
    )

    def find_latest_xlsx():
        files = []
        for r, _, fs in os.walk(DATA_DIR):
            for f in fs:
                if f.lower().startswith("final_check_") and f.lower().endswith(".xlsx"):
                    files.append(Path(r) / f)
        return max(files, key=lambda p: p.stat().st_mtime) if files else None

    def load_process_order():
        return pd.read_csv(BASE_DIR / "Process_order.csv")["Process"].astype(str).tolist()

    def build_phase_header(final_check_path: Path, temp_config_path: Path):
        df_final = pd.read_excel(final_check_path)
        if "phase" not in df_final.columns:
            return []
        final_phases = set(
            df_final["phase"]
            .dropna()
            .astype(str)
            .str.strip()
            .unique()
        )
        if not final_phases:
            return []
        groups = sorted({p[:2] for p in final_phases if len(p) >= 2})
        df_cfg = pd.read_excel(temp_config_path)
        phase_header = []
        for group in groups:
            if group not in df_cfg.columns:
                continue
            cfg_phases = (
                df_cfg[group]
                .dropna()
                .astype(str)
                .str.strip()
                .tolist()
            )
            for p in cfg_phases:
                phase_header.append({
                    "phase": p,
                    "active": p in final_phases
                })
        return phase_header

    def detect_process_column(df):
        for c in df.columns:
            if c.strip().lower() in ("station name", "process", "station"):
                return c
        raise KeyError("Process column not found")

    def load_datapy_status_map(excel_path: Path):
        result = {}
        if not excel_path.exists():
            return result
        try:
            df = pd.read_excel(excel_path, sheet_name="DataPy")
        except Exception as e:
            print("DataPy read error:", e)
            return result
        required_cols = {"Process", "Phase", "xBO", "Status"}
        if not required_cols.issubset(df.columns):
            return result
        XBO_MAP = {
            "EBO": "E",
            "MBO": "M",
            "PBO": "P",
        }
        for _, r in df.iterrows():
            proc = r.get("Process")
            phase = r.get("Phase")
            xbo = r.get("xBO")
            if pd.isna(proc) or pd.isna(phase) or pd.isna(xbo):
                continue
            proc_norm = normalize_process(str(proc))
            phase_key = str(phase).strip()
            xbo_raw = str(xbo).strip().upper()
            if xbo_raw not in XBO_MAP:
                continue
            xbo_short = XBO_MAP[xbo_raw]
            status = None if pd.isna(r.get("Status")) else str(r.get("Status")).strip()
            key = (proc_norm, phase_key)
            if key not in result:
                result[key] = {
                    "xbo": set(),
                    "status": {}
                }
            result[key]["xbo"].add(xbo_short)

            if status and status.strip():
                result[key]["status"][xbo_short] = status.strip()
            else:
                result[key]["status"][xbo_short] = ""
        return result

    def load_process_order_sub():
        return pd.read_csv(BASE_DIR / "Process_order_Sub.csv")["Process"].astype(str).tolist()

    def find_latest_xlsx_sub():
        files = []
        for r, _, fs in os.walk(DATA_DIR_SUB):
            for f in fs:
                if f.lower().startswith("final_check_") and f.lower().endswith(".xlsx"):
                    files.append(Path(r) / f)
        return max(files, key=lambda p: p.stat().st_mtime) if files else None

    def color_intensity_class(minutes):
        if minutes < 120:
            return "i-100"
        if minutes < 1440:
            return "i-80"
        if minutes < 2880:
            return "i-60"
        if minutes < 4320:
            return "i-40"
        return "i-20"

    @app.route("/api/process_realtime")
    def api_process_realtime():
        mode = request.args.get("mode", "main")
        if mode == "sub":
            process_order = load_process_order_sub()
            xlsx_path = find_latest_xlsx_sub()
        else:
            process_order = load_process_order()
            xlsx_path = find_latest_xlsx()
        phase_param = request.args.get("phase", "")
        phase_filter = phase_param.split(",") if phase_param else None
        latest = xlsx_path
        if not latest:
            return jsonify({"phases": [], "rows": []})
        df = pd.read_excel(latest)
        df.columns = [c.strip() for c in df.columns]
        process_col = detect_process_column(df)
        if "Phase" in df.columns:
            df["__PHASE__"] = df["Phase"].astype(str)
        else:
            df["__PHASE__"] = df["Config"].astype(str).str[:5]
        df["__PROCESS__"] = df[process_col].astype(str)
        if "Build" in df.columns:
            df["__BUILD__"] = df["Build"].astype(str)
        else:
            df["__BUILD__"] = ""
        if mode != "sub":
            process_order = load_process_order()
        datapy_excel = BASE_DIR / "data_track" / "Cen-A C4-Overall tracker for operation build plan.xlsx"
        datapy_status_map = load_datapy_status_map(datapy_excel)
        process_index = {p: i for i, p in enumerate(process_order)}
        FINISH_CHECK_PROCESS = process_order[-2]
        FINAL_PROCESS = process_order[-1]
        all_phases = sorted(df["__PHASE__"].dropna().unique().tolist())
        display_phases = (
            [p for p in all_phases if p in phase_filter]
            if phase_filter else all_phases
        )
        table = {p: {ph: [] for ph in display_phases} for p in process_order}
        now = pd.Timestamp.now()
        phase_lot_count = (
            df.groupby("__PHASE__")["Lot Number"]
            .nunique()
            .to_dict()
        )
        smt_df = df[df["__PROCESS__"] == "SMT"].sort_values("Input Time")
        lot_order = {}
        for cfg, g in smt_df.groupby("Config"):
            for i, lot in enumerate(g["Lot Number"].dropna().unique(), 1):
                lot_order[(cfg, lot)] = i
        for lot, glot in df.groupby("Lot Number"):
            phase = glot["__PHASE__"].iloc[0]
            if phase not in display_phases:
                continue
            visited = glot["__PROCESS__"].dropna().unique().tolist()
            visited = [p for p in visited if p in process_index]
            if not visited:
                continue
            last_proc = max(visited, key=lambda p: process_index[p])
            r = (
                glot[glot["__PROCESS__"] == last_proc]
                .sort_values(["Input Time", "Output Time"])
                .iloc[-1]
            )
            build_val = r.get("__BUILD__", "")
            input_time = r.get("Input Time")
            output_time = r.get("Output Time")
            finish_rows = glot[glot["__PROCESS__"] == FINISH_CHECK_PROCESS]
            if not finish_rows.empty and not finish_rows["Output Time"].dropna().empty:
                table[FINAL_PROCESS][phase].append({
                    "lot": build_to_lot_label(build_val),
                    "full": lot,
                    "config": r["Config"],
                    "build": build_val,
                    "input_qty": safe_int(r.get("Input QTY", 0)),
                    "minutes": 0,
                    "time_type": "Finished",
                    "color": "blue"
                })
                continue
            if pd.notna(input_time) and pd.isna(output_time):
                minutes = int((now - pd.to_datetime(input_time)).total_seconds() // 60)
                if minutes >= 4320:
                    time_type = "Offline"
                    color = "gray"
                elif minutes >= 2880:
                    time_type = "WORK"
                    color = "red"
                else:
                    time_type = "WORK"
                    color = "green"
                table[last_proc][phase].append({
                    "lot": build_to_lot_label(build_val),
                    "full": lot,
                    "config": r["Config"],
                    "build": build_val,
                    "input_qty": safe_int(r.get("Input QTY", 0)),
                    "minutes": minutes,
                    "time_type": time_type,
                    "color": color,
                    "intensity": color_intensity_class(minutes),
                    "current_process": last_proc
                })
                continue
            if pd.notna(output_time):
                next_idx = process_index[last_proc] + 1
                if next_idx < len(process_order):
                    next_proc = process_order[next_idx]
                    minutes = int((now - pd.to_datetime(output_time)).total_seconds() // 60)
                    if minutes >= 4320:
                        time_type = "Offline"
                        color = "gray"
                    elif minutes >= 2880:
                        time_type = "Waiting"
                        color = "red"
                    else:
                        time_type = "Waiting"
                        color = "yellow"
                    table[next_proc][phase].append({
                        "lot": build_to_lot_label(build_val),
                        "full": lot,
                        "config": r["Config"],
                        "build": build_val,
                        "input_qty": safe_int(r.get("Input QTY", 0)),
                        "minutes": minutes,
                        "time_type": time_type,
                        "color": color,
                        "intensity": color_intensity_class(minutes),
                        "current_process": next_proc
                    })
        rows = []
        for i, proc in enumerate(process_order):
            proc_norm = normalize_process(proc)
            mp_by_phase = {}
            for ph in display_phases:
                key = (proc_norm, ph)
                if key in datapy_status_map:
                    mp_raw = datapy_status_map[key]
                    mp_by_phase[ph] = {
                        "xbo": sorted(list(mp_raw.get("xbo", []))),
                        "status": mp_raw.get("status", {})
                    }
            row = {
                "no": i + 1,
                "process": proc,
                "cells": table.get(proc, {}),
                "__mp_status__": mp_by_phase
            }
            rows.append(row)
            MAIN_PATTERN = re.compile(r"\bMAIN(\s+\d+(-\d+)?)?\s*$", re.IGNORECASE)
            finished_phase_map = {}
            for ph in all_phases:
                main_lots = []
                for r in rows:
                    for lot in r["cells"].get(ph, []):
                        build = lot.get("build", "")
                        if not isinstance(build, str):
                            continue
                        b = build.strip().upper()
                        if MAIN_PATTERN.search(b):
                            main_lots.append(lot)
                if not main_lots:
                    finished_phase_map[ph] = False
                else:
                    finished_phase_map[ph] = all(
                        lot.get("time_type") == "Finished"
                        for lot in main_lots
                    )
        realtime_phases = set(display_phases)
        phase_group = None
        if display_phases:
            phase_group = display_phases[0][:2]
        phase_header = []
        latest_file = xlsx_path
        if latest_file:
            source_name = latest_file.name
            source_updated = datetime.fromtimestamp(
                latest_file.stat().st_mtime
            ).strftime("%Y-%m-%d %H:%M")
        else:
            source_name = "N/A"
            source_updated = None
        try:
            final_check_file = latest_file
            temp_config_file = (
                    BASE_DIR / "data_track" / "Temp_Config.xlsx"
            )
            phase_header = build_phase_header(
                final_check_file,
                temp_config_file
            )
            for p in phase_header:
                ph = p.get("phase")
                p["finished"] = finished_phase_map.get(ph, False)
        except Exception as e:
            print("Build phase_header error:", e)
            phase_header = []
        latest_file = xlsx_path
        source_name = latest_file.name if latest_file else "N/A"
        if mode == "sub":
            source_file = xlsx_path.name
        else:
            source_file = xlsx_path.name
        return jsonify({
            "all_phases": all_phases,
            "display_phases": display_phases,
            "phase_lot_count": phase_lot_count,
            "rows": rows,
            "phase_header": phase_header,
            "source_file": xlsx_path.name if xlsx_path else "N/A",
            "source_updated": source_updated
        })

    @app.route("/api/pbo")
    def api_pbo():
        mode = request.args.get("mode", "main")
        if mode == "sub":
            latest = find_latest_xlsx_sub()
            process_order = load_process_order_sub()
            std_pbo_map = load_std_pbo_map(BASE_DIR / "Process_order_Sub.csv")
        else:
            latest = find_latest_xlsx()
            process_order = load_process_order()
            std_pbo_map = load_std_pbo_map()
        if not latest:
            return jsonify([])
        df = pd.read_excel(latest)
        df.columns = [c.strip() for c in df.columns]
        process_col = detect_process_column(df)
        result = []
        EXCLUDE_PROCESSES = {"SMT"}
        SPECIAL_YIELD_PROCESS = "VCSEL Attach_1"
        yield_col = None
        for c in df.columns:
            if c.strip().lower() in ("yield", "station yield"):
                yield_col = c
                break
        for cfg, gcfg in df.groupby("Config"):
            lots = []
            flow = {}
            flow_by_lot = {}
            for lot, glot in gcfg.groupby("Lot Number"):
                rows = []
                final_rows = []
                for p in process_order:
                    x = glot[glot[process_col] == p]
                    if x.empty:
                        continue
                    inp = safe_int(x["Input QTY"].max())
                    out = safe_int(x["Output QTY"].min())
                    fail_sum = safe_int(x["Failure QTY"].sum())
                    pbo = safe_int(x["PBO"].sum())
                    if inp > 0 or out > 0:
                        flow.setdefault(p, {"input": 0, "output": 0, "fail": 0})
                        flow[p]["input"] += inp
                        flow[p]["output"] += out
                        flow[p]["fail"] += fail_sum
                        flow_by_lot.setdefault(lot, {})[p] = inp
                    if pbo == 0 and fail_sum == 0:
                        continue
                    failure_detail = {}
                    if "Failure Name" in x.columns and "Failure QTY" in x.columns:
                        for _, fr in x.iterrows():
                            name_raw = fr.get("Failure Name")
                            if pd.isna(name_raw):
                                continue
                            name = str(name_raw).strip()
                            qty = safe_int(fr.get("Failure QTY", 0))
                            if name and qty > 0:
                                failure_detail[name] = failure_detail.get(name, 0) + qty
                    rows.append({
                        "process": p,
                        "in": inp,
                        "out": out,
                        "pbo": pbo,
                        "std_pbo": std_pbo_map.get(normalize_process(p), 0),
                        "fail": fail_sum,
                        "failure_detail": failure_detail
                    })
                for _, r in glot.iterrows():
                    process_name = r[process_col]
                    if process_name in EXCLUDE_PROCESSES:
                        continue
                    out_qty = safe_int(r.get("Output QTY", 0))
                    if out_qty <= 0:
                        continue
                    inp_qty = safe_int(r.get("Input QTY", 0))
                    fail_qty = safe_int(r.get("Failure QTY", 0))
                    y = None
                    if process_name == SPECIAL_YIELD_PROCESS:
                        y = 100.0 - (fail_qty / out_qty) * 100.0
                    else:
                        raw_yield = r.get(yield_col) if yield_col else None
                        if pd.notna(raw_yield):
                            try:
                                if isinstance(raw_yield, str) and "%" in raw_yield:
                                    y = float(raw_yield.replace("%", "").strip())
                                else:
                                    y = float(raw_yield)
                                    if y <= 1:
                                        y = y * 100
                            except:
                                y = None
                    final_rows.append({
                        "process": process_name,
                        "input": inp_qty,
                        "yield": round(y, 2) if y is not None else None
                    })
                if rows:
                    lots.append({
                        "lot": lot,
                        "pbo": safe_int(glot["PBO"].sum()),
                        "fail": safe_int(glot["Failure QTY"].sum()),
                        "rows": rows,
                        "final_rows": final_rows
                    })
            result.append({
                "config": cfg,
                "lots": lots,
                "flow": flow,
                "flow_by_lot": flow_by_lot,
                "process_order": process_order
            })
        return jsonify(result)

    @app.route("/api/filter_meta")
    def api_filter_meta():
        mode = request.args.get("mode", "main")
        latest = find_latest_xlsx_sub() if mode == "sub" else find_latest_xlsx()
        if not latest:
            return jsonify({
                "phases": [],
                "configs": [],
                "lots": []
            })
        df = pd.read_excel(latest)
        df.columns = [c.strip() for c in df.columns]
        phases = (
            df["Phase"].dropna().astype(str).unique().tolist()
            if "Phase" in df.columns
            else []
        )
        configs = (
            df["Config"].dropna().astype(str).unique().tolist()
            if "Config" in df.columns
            else []
        )
        lots = (
            df["Lot Number"].dropna().astype(str).unique().tolist()
            if "Lot Number" in df.columns
            else []
        )
        return jsonify({
            "phases": sorted(phases),
            "configs": sorted(configs),
            "lots": sorted(lots)
        })

    @app.route("/")
    def index():
        return render_template("cen_index.html")

    @app.route("/sub")
    def cen_index_sub():
        return render_template("cen_index_sub.html")

    return app

if __name__ == "__main__":
    BASE_DIR = Path(__file__).resolve().parent
    app = create_app(BASE_DIR)
    app.run(host="0.0.0.0", port=5001)
