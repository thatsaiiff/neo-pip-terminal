"""Dependency free CSV companion exports for research runs."""

from __future__ import annotations

import io
import json
import math
import re
import zipfile
from html import escape
from typing import Any


def _strategy_rows(report: dict[str, Any], strategy_id: str | None = None) -> list[dict[str, Any]]:
    strategies = report.get("strategies", [])
    if strategy_id:
        strategies = [item for item in strategies if item.get("strategy_id") == strategy_id]
    return strategies


def xlsx_bytes(report: dict[str, Any], strategy_id: str | None = None) -> bytes:
    strategies = _strategy_rows(report, strategy_id)
    summary_rows: list[list[Any]] = [["Strategy", "Net P&L INR", "Gross profit INR", "Gross loss INR", "Charges INR", "Return on capital %", "Trades", "Win rate %", "Profit factor", "Max drawdown %", "Expectancy INR"]]
    trade_rows: list[list[Any]] = [["Strategy", "Entry time epoch", "Exit time epoch", "Signal time epoch", "Symbol", "Option type", "Strike", "Expiry", "Day type", "DTE calendar", "DTE sessions", "Lots", "Lot size", "Quantity", "Entry premium", "Exit premium", "Delta entry", "Delta exit", "Theta entry", "Theta exit", "Vega entry", "Vega exit", "Gamma entry", "Gamma exit", "IV entry", "IV exit", "IV rank", "IV percentile", "Gross P&L INR", "Costs INR", "Net P&L INR", "R multiple", "MFE INR", "MAE INR", "Slippage INR", "Entry spread", "Exit spread", "Holding minutes", "Exit reason"]]
    for item in strategies:
        summary = item.get("summary", {})
        metrics = {metric.get("id"): metric.get("value") for metric in item.get("metrics", [])}
        summary_rows.append([item.get("strategy", {}).get("name", item.get("strategy_id")), summary.get("net_pnl"), summary.get("gross_profit"), summary.get("gross_loss"), summary.get("charges"), summary.get("return_on_capital_pct"), summary.get("total_trades"), metrics.get("win_rate"), metrics.get("profit_factor"), item.get("drawdown", {}).get("max_drawdown_pct"), metrics.get("expectancy")])
        for trade in item.get("trades", []):
            trade_rows.append([item.get("strategy_id"), trade.get("entry_time"), trade.get("exit_time"), trade.get("signal_time"), trade.get("symbol"), trade.get("option_type"), trade.get("strike"), trade.get("expiry"), trade.get("day_type"), trade.get("dte_calendar"), trade.get("dte_sessions"), trade.get("lots"), trade.get("lot_size"), trade.get("quantity"), trade.get("entry_price"), trade.get("exit_price"), trade.get("delta_entry"), trade.get("delta_exit"), trade.get("theta_entry"), trade.get("theta_exit"), trade.get("vega_entry"), trade.get("vega_exit"), trade.get("gamma_entry"), trade.get("gamma_exit"), trade.get("iv_entry"), trade.get("iv_exit"), trade.get("iv_rank"), trade.get("iv_percentile"), trade.get("gross_pnl"), trade.get("charges"), trade.get("net_pnl"), trade.get("r_multiple"), trade.get("mfe_inr"), trade.get("mae_inr"), trade.get("slippage_cost"), trade.get("entry_spread"), trade.get("exit_spread"), trade.get("holding_minutes"), trade.get("exit_reason")])
    metrics_rows: list[list[Any]] = [["Strategy", "Metric", "Value", "Unit", "Definition", "Formula", "Benchmark", "Status", "Unavailable reason"]]
    registry_rows: list[list[Any]] = [["Group", "Metric ID", "Display name", "Definition", "Formula", "Unit", "Benchmark", "Calculation function", "Required fields", "Interpretation", "Data quality status"]]
    validation_rows: list[list[Any]] = [["Strategy", "Segment", "Metric", "Value", "Unit", "Definition", "Formula", "Status"]]
    analytics_rows: list[list[Any]] = [["Strategy", "Group", "Metric", "Value", "Unit", "Status / explanation"]]
    optimization_rows: list[list[Any]] = [["Strategy", "Rank", "Parameters", "Training trades", "Training expectancy INR", "Training profit factor", "Training max drawdown %", "Training score"]]
    for group, definitions in (report.get("metric_registry") or {}).items():
        if not isinstance(definitions, list):
            continue
        for definition in definitions:
            if not isinstance(definition, dict):
                continue
            registry_rows.append([group, definition.get("id"), definition.get("name"), definition.get("definition"),
                                  definition.get("formula"), definition.get("unit"), definition.get("benchmark"),
                                  definition.get("calculation_function"), json.dumps(definition.get("required_fields", []), ensure_ascii=True),
                                  definition.get("interpretation"), definition.get("data_quality_status")])
    for item in strategies:
        for metric in item.get("metrics", []):
            metrics_rows.append([item.get("strategy_id"), metric.get("name"), metric.get("value"), metric.get("unit"), metric.get("definition"), metric.get("formula"), metric.get("benchmark"), metric.get("status"), metric.get("unavailable_reason")])
        for segment_name in ("in_sample", "out_of_sample"):
            segment = item.get("validation", {}).get(segment_name, {})
            for metric in segment.get("metrics", []):
                validation_rows.append([item.get("strategy_id"), segment_name, metric.get("name"), metric.get("value"), metric.get("unit"), metric.get("definition"), metric.get("formula"), metric.get("status")])
        for group, values in (("Options", item.get("options_metrics", {})), ("Execution", item.get("execution_metrics", {})), ("Risk", item.get("tail_risk", {})), ("Capital", item.get("summary", {})), ("Slippage stress", item.get("slippage_stress", {}))):
            for key, value in values.items():
                if isinstance(value, dict):
                    analytics_rows.append([item.get("strategy_id"), group, key, json.dumps(value, ensure_ascii=True, sort_keys=True), "details", value.get("unavailable_reason") or value.get("reason") or value.get("assumption")])
                else:
                    analytics_rows.append([item.get("strategy_id"), group, key, value, "", ""])
        optimization = item.get("optimization", {})
        for rank, candidate in enumerate(optimization.get("top_candidates", []), 1):
            training = candidate.get("training", {})
            optimization_rows.append([item.get("strategy_id"), rank, json.dumps(candidate.get("parameters", {}), sort_keys=True), training.get("trades"), training.get("expectancy"), training.get("profit_factor"), training.get("max_drawdown_pct"), candidate.get("training_score")])
    sheets = [("Summary", summary_rows), ("Trades", trade_rows), ("Metrics", metrics_rows),
              ("Validation", validation_rows), ("Risk Options", analytics_rows), ("Optimization", optimization_rows),
              ("Metric Registry", registry_rows)]

    def column_name(index: int) -> str:
        output = ""
        while index:
            index, remainder = divmod(index - 1, 26)
            output = chr(65 + remainder) + output
        return output

    def cell_xml(reference: str, value: Any) -> str:
        if value is None:
            return f'<c r="{reference}"/>'
        if isinstance(value, bool):
            return f'<c r="{reference}" t="b"><v>{1 if value else 0}</v></c>'
        if isinstance(value, (int, float)) and math.isfinite(float(value)):
            return f'<c r="{reference}"><v>{value}</v></c>'
        if isinstance(value, (list, dict)):
            value = json.dumps(value, ensure_ascii=True, sort_keys=True)
        text = escape(str(value), quote=False)
        return f'<c r="{reference}" t="inlineStr"><is><t xml:space="preserve">{text}</t></is></c>'

    def worksheet_xml(rows: list[list[Any]]) -> str:
        body = []
        for row_index, row in enumerate(rows, 1):
            cells = "".join(cell_xml(f"{column_name(col_index)}{row_index}", value) for col_index, value in enumerate(row, 1))
            body.append(f'<row r="{row_index}">{cells}</row>')
        last_column = column_name(max((len(row) for row in rows), default=1))
        return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                f'<dimension ref="A1:{last_column}{len(rows)}"/><sheetViews><sheetView workbookViewId="0"/></sheetViews>'
                f'<sheetFormatPr defaultRowHeight="15"/><sheetData>{"".join(body)}</sheetData></worksheet>')

    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' + ''.join(f'<Override PartName="/xl/worksheets/sheet{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' for i in range(1, len(sheets) + 1)) + '</Types>')
        archive.writestr("_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
        archive.writestr("xl/workbook.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + ''.join(f'<sheet name="{name}" sheetId="{i}" r:id="rId{i}"/>' for i, (name, _) in enumerate(sheets, 1)) + '</sheets></workbook>')
        archive.writestr("xl/_rels/workbook.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + ''.join(f'<Relationship Id="rId{i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{i}.xml"/>' for i in range(1, len(sheets) + 1)) + '</Relationships>')
        for i, (_, rows) in enumerate(sheets, 1):
            archive.writestr(f"xl/worksheets/sheet{i}.xml", worksheet_xml(rows))
    return out.getvalue()


def pdf_bytes(report: dict[str, Any], strategy_id: str | None = None) -> bytes:
    strategies = _strategy_rows(report, strategy_id)
    lines = ["NEO PIP OPTIONS RESEARCH", "Results summary and metric definitions", ""]
    for item in strategies:
        summary = item.get("summary", {})
        lines.extend([
            item.get("strategy", {}).get("name", item.get("strategy_id", "Strategy")),
            f"Net P&L INR: {summary.get('net_pnl', 'N/A')} | Trades: {summary.get('total_trades', 'N/A')} | Charges INR: {summary.get('charges', 'N/A')}",
            f"Data coverage: {item.get('data_quality', {}).get('data_range_start', 'N/A')} to {item.get('data_quality', {}).get('data_range_end', 'N/A')}",
        ])
        for metric in item.get("metrics", []):
            value = metric.get("value")
            if metric.get("id") == "max_drawdown":
                value = f"{value}% ({metric.get('value_inr')} INR)"
            lines.append(f"{metric.get('name')}: {value if value is not None else 'N/A'} {metric.get('unit', '')} | {metric.get('status', '')}")
            lines.append(f"  Definition: {metric.get('definition', 'N/A')} | Formula: {metric.get('formula', 'N/A')}")
            if metric.get("interpretation"):
                lines.append(f"  Interpretation: {metric['interpretation']}")
            if metric.get("unavailable_reason"):
                lines.append(f"  {metric['unavailable_reason']}")
        for group_name, group_data in (("Options", item.get("options_metrics", {})),
                                       ("Execution", item.get("execution_metrics", {})),
                                       ("Tail risk", item.get("tail_risk", {}))):
            lines.append(f"{group_name} metrics:")
            for metric_name, value in group_data.items():
                if metric_name in {"mfe_mae_scatter", "iv_rank_history", "drawdown_curve"}:
                    lines.append(f"  {metric_name}: {len(value)} observations" if isinstance(value, list) else f"  {metric_name}: N/A")
                    continue
                text = json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":")) if isinstance(value, (dict, list)) else str(value)
                if len(text) > 260:
                    text = text[:257] + "..."
                lines.append(f"  {metric_name}: {text}")
        validation = item.get("validation", {})
        for segment_name in ("in_sample", "out_of_sample"):
            segment = validation.get(segment_name, {})
            if segment:
                lines.append(f"{segment_name} net P&L INR: {segment.get('summary', {}).get('net_pnl', 'N/A')} | trades: {segment.get('summary', {}).get('total_trades', 'N/A')} | max DD %: {segment.get('drawdown', {}).get('max_drawdown_pct', 'N/A')}")
        optimization = item.get("optimization", {})
        if optimization:
            lines.append(f"Optimization status: {optimization.get('status', 'N/A')} | selected parameters: {optimization.get('selected_parameters', {})}")
            lines.append(f"Untouched holdout: {optimization.get('holdout', {})}")
        lines.append("")
    registry = report.get("metric_registry") or {}
    lines.extend(["METRIC DEFINITIONS AND FORMULAS", ""])
    for group_name, definitions in registry.items():
        if not isinstance(definitions, list):
            continue
        lines.append(f"{group_name.title()} registry:")
        for metric in definitions:
            if not isinstance(metric, dict):
                continue
            lines.append(f"  {metric.get('name', metric.get('id'))} ({metric.get('unit', 'N/A')}): {metric.get('definition', 'N/A')}")
            lines.append(f"    Formula: {metric.get('formula', 'N/A')}")
            lines.append(f"    Required: {', '.join(map(str, metric.get('required_fields', [])))} | Status: {metric.get('data_quality_status', 'evaluated per run')}")
            if metric.get("interpretation"):
                lines.append(f"    Interpretation: {metric['interpretation']}")
        lines.append("")
    lines.extend(["DATA AND EXECUTION LIMITS", *[f"* {x}" for x in report.get("assumptions", [])]])
    wrapped = []
    for line in lines:
        raw = str(line).encode("ascii", "replace").decode("ascii")
        while len(raw) > 96:
            cut = raw.rfind(" ", 0, 96)
            if cut < 1: cut = 96
            wrapped.append(raw[:cut]); raw = raw[cut:].lstrip()
        wrapped.append(raw)
    pages = [wrapped[i:i + 48] for i in range(0, len(wrapped), 48)] or [[]]
    objects: list[bytes] = []
    font_id = 3 + len(pages) * 2
    page_ids = [3 + i * 2 for i in range(len(pages))]
    content_ids = [page_id + 1 for page_id in page_ids]
    kids = " ".join(f"{page_id} 0 R" for page_id in page_ids)
    objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objects.append(f"<< /Type /Pages /Kids [{kids}] /Count {len(pages)} >>".encode())
    for i, lines_on_page in enumerate(pages):
        content_parts = ["BT", "/F1 9 Tf", "50 790 Td", "12 TL"]
        for index, line in enumerate(lines_on_page):
            safe = line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
            if index: content_parts.append("T*")
            content_parts.append(f"({safe}) Tj")
        content_parts.append("ET")
        stream = "\n".join(content_parts).encode("ascii", "replace")
        objects.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 {font_id} 0 R >> >> /Contents {content_ids[i]} 0 R >>".encode())
        objects.append(b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream")
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    output = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for index, obj in enumerate(objects, 1):
        offsets.append(len(output))
        output.extend(f"{index} 0 obj\n".encode()); output.extend(obj); output.extend(b"\nendobj\n")
    xref_start = len(output)
    output.extend(f"xref\n0 {len(objects) + 1}\n".encode())
    output.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]: output.extend(f"{offset:010d} 00000 n \n".encode())
    output.extend(f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref_start}\n%%EOF\n".encode())
    return bytes(output)
