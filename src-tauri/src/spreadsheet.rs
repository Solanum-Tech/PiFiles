//! Spreadsheet preview: Excel (xlsx, xlsm, xlsb, xls), OpenDocument (ods) via calamine, and CSV/TSV.

use calamine::{open_workbook_auto, Data, Reader};
use serde::Serialize;
use std::path::Path;

const MAX_ROWS: usize = 5_000;
const MAX_COLS: usize = 200;

#[derive(Serialize)]
pub struct Sheet {
    pub sheets: Vec<String>,
    pub sheet: String,
    pub rows: Vec<Vec<String>>,
    pub total_rows: usize,
    pub total_cols: usize,
    pub truncated: bool,
}

fn cell_text(c: &Data) -> String {
    match c {
        Data::Empty => String::new(),
        Data::String(s) => s.clone(),
        Data::Float(f) => {
            if f.fract() == 0.0 && f.abs() < 1e15 { format!("{}", *f as i64) } else { format!("{f}") }
        }
        Data::Int(i) => i.to_string(),
        Data::Bool(b) => if *b { "TRUE".into() } else { "FALSE".into() },
        Data::DateTime(d) => d
            .as_datetime()
            .map(|dt| if dt.time() == chrono::NaiveTime::MIN { dt.date().to_string() } else { dt.format("%Y-%m-%d %H:%M:%S").to_string() })
            .unwrap_or_else(|| d.to_string()),
        Data::DateTimeIso(s) | Data::DurationIso(s) => s.clone(),
        Data::Error(e) => format!("#{e:?}"),
    }
}

pub fn read(path: &Path, sheet: Option<&str>) -> Result<Sheet, String> {
    let ext = path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).unwrap_or_default();
    if ext == "csv" || ext == "tsv" {
        let mut rdr = csv::ReaderBuilder::new()
            .has_headers(false)
            .flexible(true)
            .delimiter(if ext == "tsv" { b'\t' } else { b',' })
            .from_path(path)
            .map_err(|e| e.to_string())?;
        let mut rows = Vec::new();
        let mut total_rows = 0;
        let mut total_cols = 0;
        for rec in rdr.records() {
            let rec = rec.map_err(|e| e.to_string())?;
            total_rows += 1;
            total_cols = total_cols.max(rec.len());
            if rows.len() < MAX_ROWS {
                rows.push(rec.iter().take(MAX_COLS).map(|s| s.to_string()).collect());
            }
        }
        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        return Ok(Sheet { sheets: vec![name.clone()], sheet: name, rows, total_rows, total_cols, truncated: total_rows > MAX_ROWS || total_cols > MAX_COLS });
    }

    let mut wb = open_workbook_auto(path).map_err(|e| e.to_string())?;
    let sheets = wb.sheet_names();
    let name = sheet
        .filter(|s| sheets.iter().any(|n| n == s))
        .map(str::to_string)
        .or_else(|| sheets.first().cloned())
        .ok_or("Workbook has no sheets")?;
    let range = wb.worksheet_range(&name).map_err(|e| e.to_string())?;
    let (h, w) = range.get_size();
    let rows = range
        .rows()
        .take(MAX_ROWS)
        .map(|r| r.iter().take(MAX_COLS).map(cell_text).collect())
        .collect();
    Ok(Sheet { sheets, sheet: name, rows, total_rows: h, total_cols: w, truncated: h > MAX_ROWS || w > MAX_COLS })
}

#[derive(serde::Deserialize, Clone, Debug)]
pub struct CellEdit {
    pub row: usize,
    pub col: usize,
    pub value: String,
}

/// Where an edited workbook ended up (a converted copy for formats that can't be written back).
#[derive(Serialize)]
pub struct Saved {
    pub path: String,
    pub converted: bool,
}

fn free_path(dir: &Path, stem: &str, ext: &str) -> std::path::PathBuf {
    let mut p = dir.join(format!("{stem}.{ext}"));
    let mut i = 2;
    while p.exists() {
        p = dir.join(format!("{stem} ({i}).{ext}"));
        i += 1;
    }
    p
}

fn set_cell(ws: &mut umya_spreadsheet::Worksheet, row: usize, col: usize, value: &str) {
    let cell = ws.cell_mut(((col + 1) as u32, (row + 1) as u32));
    if let Some(f) = value.strip_prefix('=') {
        cell.set_formula(f);
    } else {
        cell.set_value(value); // typed: numbers, TRUE/FALSE, text
    }
}

/// Saves cell edits (0-based row/col). CSV/TSV and XLSX/XLSM are written in place - XLSX keeps
/// its formatting, formulas and other sheets; XLS/XLSB/ODS can't be written, so an .xlsx copy
/// with the edits is created next to the original.
pub fn save(path: &Path, sheet: Option<&str>, edits: &[CellEdit]) -> Result<Saved, String> {
    let ext = path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "csv" | "tsv" => {
            let delim = if ext == "tsv" { b'\t' } else { b',' };
            let mut rows: Vec<Vec<String>> = csv::ReaderBuilder::new()
                .has_headers(false)
                .flexible(true)
                .delimiter(delim)
                .from_path(path)
                .map_err(|e| e.to_string())?
                .records()
                .map(|r| r.map(|r| r.iter().map(String::from).collect()).map_err(|e| e.to_string()))
                .collect::<Result<_, _>>()?;
            for e in edits {
                if rows.len() <= e.row {
                    rows.resize(e.row + 1, Vec::new());
                }
                let r = &mut rows[e.row];
                if r.len() <= e.col {
                    r.resize(e.col + 1, String::new());
                }
                r[e.col] = e.value.clone();
            }
            crate::versions::before_edit(path);
            let tmp = path.with_extension(format!("{ext}.pifiles-tmp"));
            {
                let mut w = csv::WriterBuilder::new().flexible(true).delimiter(delim).from_path(&tmp).map_err(|e| e.to_string())?;
                for r in &rows {
                    w.write_record(r).map_err(|e| e.to_string())?;
                }
                w.flush().map_err(|e| e.to_string())?;
            }
            std::fs::rename(&tmp, path).map_err(|e| format!("Couldn't save (is the file open in another program?): {e}"))?;
            Ok(Saved { path: path.to_string_lossy().to_string(), converted: false })
        }
        "xlsx" | "xlsm" => {
            let mut book = umya_spreadsheet::reader::xlsx::read(path).map_err(|e| format!("Couldn't open the workbook for editing: {e}"))?;
            let ws = match sheet {
                Some(name) => book.sheet_by_name_mut(name),
                None => book.sheet_mut(0),
            }
            .map_err(|_| "Sheet not found")?;
            for e in edits {
                set_cell(ws, e.row, e.col, &e.value);
            }
            crate::versions::before_edit(path);
            let tmp = path.with_extension(format!("pifiles-tmp.{ext}"));
            umya_spreadsheet::writer::xlsx::write(&book, &tmp).map_err(|e| e.to_string())?;
            std::fs::rename(&tmp, path).map_err(|e| format!("Couldn't save (is the file open in Excel?): {e}"))?;
            Ok(Saved { path: path.to_string_lossy().to_string(), converted: false })
        }
        _ => {
            // Copy every sheet's values into a new workbook, apply the edits there.
            let mut wb = open_workbook_auto(path).map_err(|e| e.to_string())?;
            let names = wb.sheet_names();
            let target = sheet.map(str::to_string).or_else(|| names.first().cloned()).unwrap_or_default();
            let mut book = umya_spreadsheet::new_file();
            for (i, name) in names.iter().enumerate() {
                let range = wb.worksheet_range(name).map_err(|e| e.to_string())?;
                if i == 0 {
                    book.set_sheet_name(0, name.clone()).map_err(|e| e.to_string())?;
                } else {
                    book.new_sheet(name.clone()).map_err(|e| e.to_string())?;
                }
                let ws = book.sheet_mut(i).map_err(|_| "sheet")?;
                for (r, row) in range.rows().enumerate() {
                    for (c, v) in row.iter().enumerate() {
                        if !matches!(v, Data::Empty) {
                            set_cell(ws, r, c, &cell_text(v));
                        }
                    }
                }
                if *name == target {
                    for e in edits {
                        set_cell(ws, e.row, e.col, &e.value);
                    }
                }
            }
            let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "Workbook".into());
            let out = free_path(path.parent().unwrap_or(Path::new(".")), &stem, "xlsx");
            umya_spreadsheet::writer::xlsx::write(&book, &out).map_err(|e| e.to_string())?;
            Ok(Saved { path: out.to_string_lossy().to_string(), converted: true })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edit_csv_and_xlsx_round_trip() {
        let dir = std::env::temp_dir().join(format!("pifiles-sheet-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let csv_path = dir.join("t.csv");
        std::fs::write(&csv_path, "name,qty\napple,3\n").unwrap();
        save(&csv_path, None, &[CellEdit { row: 1, col: 1, value: "5".into() }, CellEdit { row: 2, col: 0, value: "pear, ripe".into() }]).unwrap();
        let s = read(&csv_path, None).unwrap();
        assert_eq!(s.rows[1][1], "5");
        assert_eq!(s.rows[2][0], "pear, ripe");

        let xlsx = dir.join("t.xlsx");
        let mut book = umya_spreadsheet::new_file();
        book.sheet_mut(0).unwrap().cell_mut("A1").set_value("Total");
        umya_spreadsheet::writer::xlsx::write(&book, &xlsx).unwrap();
        save(&xlsx, Some("Sheet1"), &[CellEdit { row: 0, col: 1, value: "42".into() }, CellEdit { row: 1, col: 1, value: "=B1*2".into() }]).unwrap();
        let s = read(&xlsx, None).unwrap();
        assert_eq!(s.rows[0], vec!["Total".to_string(), "42".to_string()]);
        let _ = std::fs::remove_dir_all(dir);
    }
}
