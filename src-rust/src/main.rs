use anyhow::Result;
use binsleuth::analyzer::hardening::CheckResult;
use serde::Serialize;

// ── Output types ─────────────────────────────────────────────────────────────

#[derive(Serialize)]
struct PermInfo {
    read: bool,
    write: bool,
    execute: bool,
}

#[derive(Serialize)]
struct SectionInfo {
    name: String,
    size: u64,
    virtual_address: u64,
    file_offset: u64,
    entropy: f64,
    permissions: PermInfo,
}

#[derive(Serialize)]
struct DangerousSymbolInfo {
    name: String,
    category: String,
}

#[derive(Serialize)]
struct SecurityInfo {
    format: String,
    architecture: String,
    nx: String,
    pie: String,
    relro: String,
    canary: String,
    fortify: String,
    rpath: String,
    stripped: String,
    dangerous_symbols: Vec<DangerousSymbolInfo>,
}

#[derive(Serialize)]
struct AnalysisOutput {
    file: String,
    sections: Vec<SectionInfo>,
    security: SecurityInfo,
    security_score: u8,
    /// Sum of all section sizes (virtual size for .bss etc.)
    total_virtual_size: u64,
    /// Sum of file_offset+size for sections that are actually on disk
    total_file_size: u64,
}

// ── Helper ────────────────────────────────────────────────────────────────────

fn check_to_str(r: &CheckResult) -> String {
    match r {
        CheckResult::Enabled => "Enabled".to_string(),
        CheckResult::Partial(s) => format!("Partial: {s}"),
        CheckResult::Disabled => "Disabled".to_string(),
        CheckResult::NotApplicable => "N/A".to_string(),
    }
}

// ── Entry point ───────────────────────────────────────────────────────────────

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage: binsleuth-bridge <binary-path>");
        std::process::exit(1);
    }
    let path = &args[1];

    let data = std::fs::read(path).map_err(|e| anyhow::anyhow!("Cannot read '{}': {}", path, e))?;

    let report =
        binsleuth::analyze(&data).map_err(|e| anyhow::anyhow!("Analysis failed: {}", e))?;

    // ── Build section list ───────────────────────────────────────────────────
    let sections: Vec<SectionInfo> = report
        .sections
        .iter()
        .map(|s| SectionInfo {
            name: s.name.clone(),
            size: s.size,
            virtual_address: s.virtual_address,
            file_offset: s.file_offset,
            entropy: (s.entropy * 1000.0).round() / 1000.0, // 3 decimal places
            permissions: PermInfo {
                read: s.permissions.read,
                write: s.permissions.write,
                execute: s.permissions.execute,
            },
        })
        .collect();

    let total_virtual_size: u64 = sections.iter().map(|s| s.size).sum();
    // Sections with file_offset == 0 and non-zero name like .bss may have no disk bytes
    let total_file_size: u64 = sections
        .iter()
        .filter(|s| !(s.file_offset == 0 && s.name != ".text" && s.name != ""))
        .map(|s| s.size)
        .sum();

    // ── Build security info ──────────────────────────────────────────────────
    let h = &report.hardening;

    let dangerous_symbols: Vec<DangerousSymbolInfo> = h
        .dangerous_symbols
        .iter()
        .map(|ds| DangerousSymbolInfo {
            name: ds.name.clone(),
            category: format!("{:?}", ds.category),
        })
        .collect();

    let security = SecurityInfo {
        format: h.format.clone(),
        architecture: h.architecture.clone(),
        nx: check_to_str(&h.nx),
        pie: check_to_str(&h.pie),
        relro: check_to_str(&h.relro),
        canary: check_to_str(&h.stack_canary),
        fortify: check_to_str(&h.fortify_source),
        rpath: check_to_str(&h.rpath),
        stripped: check_to_str(&h.stripped),
        dangerous_symbols,
    };

    let output = AnalysisOutput {
        file: path.clone(),
        sections,
        security,
        security_score: report.security_score,
        total_virtual_size,
        total_file_size,
    };

    println!("{}", serde_json::to_string(&output)?);
    Ok(())
}
