#!/usr/bin/env sh
# 生成本机验证用的自签 TLS 证书。
#
# ⚠️ 只用于开发机。生产证书由服务器现场签发/续期，绝不从这里产出。
#
# 输出：runtime/tls/fullchain.pem 与 runtime/tls/privkey.pem
# SAN 覆盖 localhost 与 lab.localhost，对应 .env.local.example 里的
# SERVER_NAME 与 LAB_SERVER_NAME。deploy/nginx.conf 的两个 server 块共用
# 这一份证书，所以两个主机名必须都在 SAN 里，否则小作坊那个 server 块会
# 出现证书不匹配——这与生产上的约束一致。
#
# runtime/ 整个被 .gitignore 忽略，证书不会入库。
#
# 用法（在仓库根目录）：sh deploy/generate-local-tls.sh
#
# 注：openssl 调用前加了 MSYS_NO_PATHCONV=1。Git Bash（MSYS2）会把以 / 开头的
# 参数当成路径翻译，导致 -subj "/CN=localhost" 变成 "D:/.../CN=localhost" 而报错。
# 该变量在 Linux/macOS 上是无害的未知环境变量，因此脚本两边通用。

set -eu

OUT_DIR="runtime/tls"
DAYS=825

mkdir -p "$OUT_DIR"

MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$OUT_DIR/privkey.pem" \
  -out "$OUT_DIR/fullchain.pem" \
  -days "$DAYS" \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,DNS:lab.localhost,IP:127.0.0.1" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
  -addext "extendedKeyUsage=serverAuth"

echo "已生成："
echo "  $OUT_DIR/fullchain.pem"
echo "  $OUT_DIR/privkey.pem"
echo
echo "SAN："
openssl x509 -in "$OUT_DIR/fullchain.pem" -noout -ext subjectAltName
