#[test]
fn compromised_ca_paths_are_not_trust_anchors() {
    use rustls_pki_types::{pem::PemObject, CertificateDer};
    let mut certificates: Vec<_> = CertificateDer::pem_slice_iter(include_bytes!(
        "../../../../ci/tls/fixtures/affected-roots.pem"
    ))
    .map(|c| c.unwrap())
    .collect();
    certificates.extend(
        CertificateDer::pem_slice_iter(include_bytes!(
            "../../../../ci/tls/fixtures/affected-intermediates.pem"
        ))
        .map(|c| c.unwrap()),
    );
    assert_eq!(certificates.len(), 20);
    let blocked: Vec<_> = certificates
        .iter()
        .map(|c| webpki::anchor_from_trusted_cert(c).unwrap())
        .collect();
    assert!(webpki_roots::TLS_SERVER_ROOTS.len() > 100);
    for anchor in webpki_roots::TLS_SERVER_ROOTS {
        // Compare parsed SPKIs in the same representation. The anchor stores
        // sequence contents, whereas published hashes cover the full DER SPKI.
        assert!(!blocked
            .iter()
            .any(|bad| { bad.subject_public_key_info == anchor.subject_public_key_info }));
    }
}

#[test]
fn compromised_intermediates_are_blocked_even_with_old_custom_roots() {
    use rustls_pki_types::{pem::PemObject, CertificateDer, UnixTime};
    use std::time::Duration;
    let fixtures =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../ci/tls/fixtures");
    let root_pem = std::fs::read(fixtures.join("affected-roots.pem")).unwrap();
    let roots: Vec<_> = CertificateDer::pem_slice_iter(&root_pem)
        .map(|c| c.unwrap())
        .collect();
    let anchors: Vec<_> = roots
        .iter()
        .map(|c| webpki::anchor_from_trusted_cert(c).unwrap())
        .collect();
    let mut count = 0;
    for entry in std::fs::read_dir(&fixtures).unwrap() {
        let path = entry.unwrap().path();
        if !path
            .to_string_lossy()
            .ends_with("we-have-a-problem.com.pem")
        {
            continue;
        }
        let pem = std::fs::read(&path).unwrap();
        let chain: Vec<_> = CertificateDer::pem_slice_iter(&pem)
            .map(|c| c.unwrap())
            .collect();
        let leaf = webpki::EndEntityCert::try_from(&chain[0]).unwrap();
        let error = leaf
            .verify_for_usage(
                webpki::ALL_VERIFICATION_ALGS,
                &anchors,
                &chain[1..],
                UnixTime::since_unix_epoch(Duration::from_secs(1792540800)),
                webpki::KeyUsage::server_auth(),
                None,
                None,
            )
            .err()
            .expect("compromised chain must be rejected");
        assert_eq!(error, webpki::Error::CertDistrusted, "{}", path.display());
        count += 1;
    }
    assert_eq!(count, 12);
}
