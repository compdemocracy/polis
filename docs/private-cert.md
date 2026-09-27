# Private certification

Private certification is the first job on the reusable [probe box](probe-box.md).
The paired certify + G12 gate runs on the box. Raw fixtures, recordings and logs
stay there; only a closed numeric/verdict receipt reaches the private evidence
bucket. The signed-admission and fixture-bucket handoff design is superseded.

Image source staging and OCI inspection remain under `ci/private_cert/` because
they are specific to certification. See [image build and ABI](../ci/private_cert/images/README.md).
