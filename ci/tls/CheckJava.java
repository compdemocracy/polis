import java.io.*;
import java.nio.file.*;
import java.security.*;
import java.security.cert.*;
import java.util.*;

// PKIX path validation, without a TLS EKU requirement: code-signing
// intermediates must fail because no trusted path exists, not wrong usage.
class CheckJava {
    static Collection<X509Certificate> certs(Path file) throws Exception {
        try (InputStream in = Files.newInputStream(file)) {
            var result = new ArrayList<X509Certificate>();
            for (var cert : CertificateFactory.getInstance("X.509").generateCertificates(in))
                result.add((X509Certificate) cert);
            return result;
        }
    }
    static void verify(X509Certificate cert, Set<TrustAnchor> roots, boolean accepted) throws Exception {
        var params = new PKIXParameters(roots);
        params.setRevocationEnabled(false);
        // Use a fixed point in this object's validity interval, independent of
        // wall clock; trust-anchor validity is not checked by PKIX validation.
        params.setDate(new Date(cert.getNotBefore().getTime() + 86400000L));
        var path = CertificateFactory.getInstance("X.509").generateCertPath(List.of(cert));
        try {
            CertPathValidator.getInstance("PKIX").validate(path, params);
            if (!accepted) throw new AssertionError("affected object still trusted: " + cert.getSerialNumber());
        } catch (CertPathValidatorException error) {
            if (accepted || error.getReason() != PKIXReason.NO_TRUST_ANCHOR) throw error;
        }
    }
    public static void main(String[] args) throws Exception {
        var objects = certs(Path.of("/audit/fixtures/affected-intermediates.pem"));
        if (objects.size() != 16) throw new AssertionError("expected sixteen objects");
        var old = new HashSet<TrustAnchor>();
        for (var cert : certs(Path.of("/audit/fixtures/affected-roots.pem"))) old.add(new TrustAnchor(cert, null));
        var store = KeyStore.getInstance(KeyStore.getDefaultType());
        try (InputStream in = Files.newInputStream(Path.of(System.getProperty("java.home"), "lib/security/cacerts"))) {
            store.load(in, "changeit".toCharArray());
        }
        var current = new HashSet<TrustAnchor>();
        var aliases = store.aliases();
        while (aliases.hasMoreElements()) current.add(new TrustAnchor((X509Certificate) store.getCertificate(aliases.nextElement()), null));
        if (current.size() < 50) throw new AssertionError("unexpectedly small Java store");
        for (var cert : objects) {
            verify(cert, old, true);
            verify(cert, current, false);
        }
        System.out.println("PASS Java native PKIX: 16/16 stale-store acceptances and 16/16 distrust refusals");
    }
}
