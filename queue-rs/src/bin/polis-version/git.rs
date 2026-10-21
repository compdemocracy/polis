use crate::model::{MIGRATIONS, Selection, legacy_names, manifest, selected_blobs};
use anyhow::{Context, Result, ensure};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    process::Command,
};

pub struct Git {
    pub path: PathBuf,
}
impl Git {
    pub fn new(path: &Path) -> Result<Self> {
        let git = Self {
            path: path.canonicalize()?,
        };
        ensure!(
            git.run(&["rev-parse", "--is-shallow-repository"])? == "false",
            "complete history required; shallow repository refused"
        );
        ensure!(
            git.run(&["replace", "-l"])?.is_empty(),
            "replace objects are not release provenance"
        );
        Ok(git)
    }
    pub fn run(&self, args: &[&str]) -> Result<String> {
        Ok(String::from_utf8(self.bytes(args)?)?
            .trim_end_matches('\n')
            .to_owned())
    }
    pub fn bytes(&self, args: &[&str]) -> Result<Vec<u8>> {
        let out = Command::new("git")
            .arg("-C")
            .arg(&self.path)
            .args(args)
            .env("GIT_NO_REPLACE_OBJECTS", "1")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .output()
            .context("run Git")?;
        ensure!(
            out.status.success(),
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr)
        );
        Ok(out.stdout)
    }
    pub fn resolve(&self, name: &str) -> Result<String> {
        self.run(&[
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{name}^{{commit}}"),
        ])
    }
    pub fn tree(&self, commit: &str) -> Result<String> {
        self.run(&["rev-parse", &format!("{commit}^{{tree}}")])
    }
    pub fn parents(&self, commit: &str) -> Result<Vec<String>> {
        Ok(self
            .run(&["show", "-s", "--format=%P", commit])?
            .split_whitespace()
            .map(str::to_owned)
            .collect())
    }
    pub fn lineage(&self, stable: &str) -> Result<Vec<String>> {
        Ok(self
            .run(&["rev-list", "--first-parent", stable])?
            .lines()
            .map(str::to_owned)
            .collect())
    }
    pub fn ancestor(&self, base: &str, head: &str) -> Result<bool> {
        Ok(self.run(&["merge-base", base, head])? == base)
    }
    pub fn text(&self, commit: &str, path: &str) -> Result<String> {
        self.run(&["show", &format!("{commit}:{path}")])
    }
    pub fn selection(&self, commit: &str) -> Result<Selection> {
        let tree = self.run(&["ls-tree", &format!("{commit}:{MIGRATIONS}")])?;
        let mut blobs = BTreeMap::new();
        for entry in tree.lines() {
            let (meta, name) = entry.split_once('\t').context("invalid Git tree entry")?;
            let fields: Vec<_> = meta.split_whitespace().collect();
            if name.ends_with(".sql") || name == "release.txt" {
                ensure!(
                    fields.len() == 3 && fields[0] == "100644" && fields[1] == "blob",
                    "migration input must be a regular file: {name}"
                );
                blobs.insert(name.to_owned(), fields[2].to_owned());
            }
        }
        let manifest_blob = blobs.get("release.txt").cloned();
        let (names, evidence) = if manifest_blob.is_some() {
            (
                manifest(&self.text(commit, &format!("{MIGRATIONS}/release.txt"))?)?,
                format!("{commit}:{MIGRATIONS}/release.txt"),
            )
        } else {
            // Recognize the historical initializer explicitly. No guess based only on filenames.
            let dockerfile = self.text(commit, "server/Dockerfile-db")?;
            let selection_line = "COPY ./postgres/migrations/*.sql /docker-entrypoint-initdb.d/";
            let names = legacy_names(&dockerfile, &blobs)?;
            (
                names,
                format!("{commit}:server/Dockerfile-db: {selection_line}"),
            )
        };
        let files = selected_blobs(&blobs, &names)?;
        Ok(Selection {
            files,
            manifest: manifest_blob,
            evidence,
        })
    }
    pub fn tags(&self) -> Result<Vec<(crate::model::Version, String)>> {
        let mut tags = Vec::new();
        for name in self
            .run(&["for-each-ref", "--format=%(refname:strip=2)", "refs/tags"])?
            .lines()
        {
            if let Some(v) = name
                .strip_prefix('v')
                .and_then(|s| crate::model::Version::parse(s).ok())
            {
                tags.push((v, self.resolve(&format!("refs/tags/{name}"))?));
            }
        }
        tags.sort();
        Ok(tags)
    }
}
