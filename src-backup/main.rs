use eframe::egui;
use std::sync::{Arc, Mutex};
use std::thread;

mod search;

struct FileExplorerApp {
    name: String,
    current_path: String,
    scan_results: Arc<Mutex<Vec<String>>>,
    is_scanning: bool,
    status: String,
}

impl Default for FileExplorerApp {
    fn default() -> Self {
        Self {
            name: String::from("File Explorer"),
            current_path: String::from("C:\\"),
            scan_results: Arc::new(Mutex::new(Vec::new())),
            is_scanning: false,
            status: String::from("Ready"),
        }
    }
}

impl eframe::App for FileExplorerApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        egui::CentralPanel::default().show(ctx, |ui| {
            ui.horizontal(|ui| {
                ui.label("Path:");
                ui.text_edit_singleline(&mut self.current_path);
                if ui.button("Scan").clicked() && !self.is_scanning {
                    let path = self.current_path.clone();
                    let results = Arc::clone(&self.scan_results);
                    self.is_scanning = true;
                    self.status = String::from("Scanning...");
                    thread::spawn(move || {
                        let res = search::scan_directory(&path);
                        *results.lock().unwrap() = res;
                    });
                }
            });

            ui.label(&self.status);

            if self.is_scanning {
                ui.label("Scanning...");
            } else {
                ui.label(format!("Found {} files", self.scan_results.lock().unwrap().len()));
                egui::ScrollArea::vertical().show(ui, |ui| {
                    let results = self.scan_results.lock().unwrap();
                    for file in results.iter().take(100) {
                        ui.label(file);
                    }
                });
            }
        });
    }
}

fn main() -> Result<(), eframe::Error> {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([1000.0, 700.0])
            .with_title("File Explorer"),
        ..Default::default()
    };
    eframe::run_native(
        "File Explorer",
        options,
        Box::new(|_cc| Box::new(FileExplorerApp::default())),
    )
}
