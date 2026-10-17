use crate::collective::unserved;
use crate::{client, profiles, public_id, str_arg};
use clap::ArgMatches;
use polis_contracts::{Error, Result};
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    path::Path,
};

fn save(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| Error::input("Cannot create export file; choose a new destination."))?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| Error::input("Cannot finish export file."))
}
fn bytes(value: &Value) -> Vec<u8> {
    serde_json::to_vec_pretty(value).expect("JSON value")
}
fn invalid() -> Error {
    Error::input("Site returned incompatible narrative inputs.")
}
pub fn execute(
    path: &str,
    m: &ArgMatches,
    config: &profiles::Config,
    site: &str,
    timeout: u64,
) -> Result<Value> {
    let conv = str_arg(m, "conversation");
    let report = str_arg(m, "report");
    public_id(conv)?;
    public_id(report)?;
    if path == "delphi narrative import" {
        let mut input = Vec::new();
        fs::File::open(str_arg(m, "input-file"))
            .map_err(|_| Error::input("Cannot open narrative JSON."))?
            .take(1024 * 1024 + 1)
            .read_to_end(&mut input)
            .map_err(|_| Error::input("Cannot read narrative JSON."))?;
        if input.len() > 1024 * 1024 {
            return Err(Error::input("Narrative JSON exceeds 1 MiB."));
        }
        let body: Value = serde_json::from_slice(&input)
            .map_err(|_| Error::input("Narrative input must be valid JSON."))?;
        if body["conversation_id"].as_str() != Some(conv)
            || body["report_id"].as_str() != Some(report)
        {
            return Err(Error::input(
                "JSON conversation/report must match the command; never retarget an export.",
            ));
        }
        // Inputs are checked before any credential is read.
        let c = client(config, site, timeout, true)?;
        return c
            .request(
                "POST",
                "/api/v3/delphi/narrative/results",
                &[],
                Some(body),
                true,
            )
            .map_err(unserved("narrative import"));
    }
    let output = Path::new(str_arg(m, "output"));
    if fs::symlink_metadata(output).is_ok() {
        return Err(Error::input(
            "Output already exists; choose a new directory.",
        ));
    }
    let mut query = vec![
        ("conversation_id".into(), conv.into()),
        ("report_id".into(), report.into()),
    ];
    if let Some(section) = m.get_one::<String>("section") {
        query.push(("section".into(), section.clone()));
    }
    let c = client(config, site, timeout, true)?;
    let data = c
        .request(
            "GET",
            "/api/v3/delphi/narrative/inputs",
            &query,
            None,
            false,
        )
        .map_err(unserved("narrative export"))?;
    let sections = data["sections"].as_array().ok_or_else(invalid)?;
    if sections.is_empty()
        || sections.len() > 99
        || data["conversation_id"] != conv
        || data["report_id"] != report
        || !data["result_schema"].is_object()
    {
        return Err(invalid());
    }
    let parent = output
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    // Numbered filenames never use server-supplied section names as paths.
    let temp = tempfile::tempdir_in(parent)
        .map_err(|_| Error::input("Cannot create export directory."))?;
    save(&temp.path().join("manifest.json"), &bytes(&data))?;
    save(
        &temp.path().join("result.schema.json"),
        &bytes(&data["result_schema"]),
    )?;
    fs::create_dir(temp.path().join("sections"))
        .map_err(|_| Error::input("Cannot create section directory."))?;
    for (index, section) in sections.iter().enumerate() {
        let dir = temp.path().join("sections").join(format!("{index:03}"));
        fs::create_dir(&dir).map_err(|_| Error::input("Cannot create section directory."))?;
        save(&dir.join("request.json"), &bytes(&section["request"]))?;
        for (name, value) in [
            ("system.xml", &section["request"]["system"]),
            ("prompt.txt", &section["request"]["messages"][0]["content"]),
            ("comments.xml", &section["comments_xml"]),
            ("comments.csv", &section["comments_csv"]),
        ] {
            save(
                &dir.join(name),
                value.as_str().ok_or_else(invalid)?.as_bytes(),
            )?;
        }
    }
    // create_dir is exclusive. Move only into the directory we just created;
    // never rename over an existing empty directory or a symlink.
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new()
        .mode(0o700)
        .create(output)
        .map_err(|_| {
            Error::input("Cannot publish export; destination already exists or is unavailable.")
        })?;
    for entry in
        fs::read_dir(temp.path()).map_err(|_| Error::input("Cannot read staged export."))?
    {
        let entry = entry.map_err(|_| Error::input("Cannot read staged export."))?;
        fs::rename(entry.path(), output.join(entry.file_name())).map_err(|_| {
            Error::input("Export publication incomplete; inspect the output directory.")
        })?;
    }
    Ok(
        json!({"state":"exported","path":output,"sections":sections.len(),"export_id":data["export_id"],"input_digest":data["input_digest"],"model_called":false}),
    )
}
