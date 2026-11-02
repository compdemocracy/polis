# RDS certificate authorities

`rds-global-bundle.pem` is the public bundle from
https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem, retrieved
2026-10-25. Its SHA256 matches the bundle pinned by the server, Delphi and
migration images. `SHA256SUMS` pins the exact bytes. The image build and every
container start check it. Updating the bundle requires reviewing and changing
both files together; startup never downloads certificates.
