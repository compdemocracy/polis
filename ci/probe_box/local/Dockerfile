FROM amazonlinux:2023
RUN dnf -y --releasever=2023.12.20260831 --disablerepo='*' --enablerepo=amazonlinux install docker-25.0.16-1.amzn2023.0.4.aarch64 containerd-2.2.5-1.amzn2023.0.2.aarch64 runc-1.3.5-1.amzn2023.0.2.aarch64 skopeo-2:1.22.2-1.amzn2023.0.1.aarch64 python3.12 util-linux && dnf clean all
