# 云端部署到腾讯云小服务器（2 核 4G，Ubuntu）

适用：内测用的单机部署（Postgres + 云端 API 同一台机器）。在服务器上由你或本地会话照着执行。云端会话不登录服务器，也不保存服务器口令。

> 口令规则：服务器口令、数据库口令、`JWT_ACCESS_SECRET`、许可证私钥、管理员口令都只放服务器上的 `.env`（权限 600），不进 git、不贴聊天。服务器口令已经在聊天里出现过，部署完成后请在腾讯云控制台重置，并改用 SSH 密钥登录、关闭密码登录。

## 0. 先解决 HTTPS，这是硬前提

客户端只接受 `https://` 的云端地址（`packages/local/src/cloud/http.js`，`http` 仅允许本机回环地址）。所以裸 IP 加 http 不能用，必须有域名和有效证书。

| 方案 | 要不要 ICP | 说明 |
|---|---|---|
| 大陆地域实例 + 域名（80/443） | 要 | 腾讯云会拦未备案域名的 80/443，备案要等管局，周期按几周预留 |
| 香港或海外地域实例 + 域名 | 不要 | 最快；国内访问通常可用但稳定性不如大陆。需要新开一台，现有大陆机器用不上 |
| 现有机器做备案，同时先用海外机器内测 | 并行 | 推荐 |

81.71.x 这个网段按我的认知是腾讯云大陆机房，但我没有核实；请在控制台确认实例地域。域名要在任意注册商买好并解析到服务器 IP。

## 1. 服务器准备（Ubuntu）

```bash
# 以普通用户登录后
sudo apt-get update && sudo apt-get -y upgrade
sudo apt-get install -y ca-certificates curl git ufw
# 安装 docker（官方脚本或 apt 的 docker.io 都可以，二选一）
sudo apt-get install -y docker.io docker-compose-v2
sudo usermod -aG docker $USER   # 重新登录后生效

# 防火墙：只开 22、80、443（腾讯云控制台“安全组”也要放行同样端口）
sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw enable
```

SSH 改密钥登录：把你本地公钥写入 `~/.ssh/authorized_keys`，确认能用密钥登录后，在 `/etc/ssh/sshd_config` 里设 `PasswordAuthentication no` 并 `sudo systemctl reload ssh`。

内存提示：4G 对 Postgres + Node 足够；建议加 2G swap 防止构建镜像时内存不足。

## 2. 取代码并配置

```bash
git clone https://github.com/talekiln/talekiln-app.git
cd talekiln-app && git checkout claude/phase1-foundation-mxao0h
cd packages/cloud
cp .env.example .env && chmod 600 .env
```

编辑 `.env`，至少设置（用 `openssl rand -base64 48` 生成随机值）：

```
POSTGRES_PASSWORD=<随机>
JWT_ACCESS_SECRET=<至少 32 字符随机>
LICENCE_PRIVATE_KEY_PEM=<ES256 PKCS8 私钥，换行写成 \n>
ADMIN_EMAIL=<你的邮箱>
ADMIN_PASSWORD=<强口令，首次启动后从 .env 删除>
```

生成许可证私钥（只在服务器上做，私钥不离开服务器）：

```bash
openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt -out lic.pem
# 写进 .env 时把换行替换为 \n：
awk 'NF {printf "%s\\n", $0}' lic.pem
shred -u lic.pem   # 写入 .env 后销毁
```

客户端需要对应的许可证公钥来校验离线许可证，配置位置见 `docs/auto-update.md` 和 `packages/core` 里 licence 相关说明；私钥一旦丢失或泄露，要换钥并让客户端更新公钥。

## 2.5 大陆机房：Docker Hub 和 npm 都要走镜像

大陆服务器通常连不上 `registry-1.docker.io`（报 `i/o timeout`），npm 官方源和 Prisma 引擎下载也可能很慢或失败。

1. Docker 镜像加速（腾讯云服务器可用其内网镜像；镜像地址会变，以腾讯云当前文档为准，不通就换其他可用的镜像站）：

```bash
sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json >/dev/null <<'EOF'
{ "registry-mirrors": ["https://mirror.ccs.tencentyun.com"] }
EOF
sudo systemctl restart docker
docker pull postgres:16-alpine     # 先单独验证能拉下来
docker pull node:22-bookworm-slim
```

2. 构建时走 npm 与 Prisma 镜像：在 `packages/cloud/.env` 里加（只是公开镜像地址，不是密钥）：

```
NPM_REGISTRY=https://registry.npmmirror.com
PRISMA_ENGINES_MIRROR=https://registry.npmmirror.com/-/binary/prisma
```

3. 如果 Docker 镜像加速仍然拉不下来：在能访问外网的电脑上 `docker pull` 后 `docker save | gzip` 导出，传到服务器 `docker load`；或者改用服务器自带 apt 装 Postgres（`sudo apt-get install -y postgresql`），compose 里只跑 app，`DATABASE_URL` 指向本机。需要的话告诉我，我给出这种写法。

## 3. 启动并加 HTTPS

`docker-compose.yml` 里 app 把 3000 端口映射到宿主机所有网卡。部署时改成只绑本机，让反向代理对外：把 `"3000:3000"` 改为 `"127.0.0.1:3000:3000"`。

用 Caddy 做反向代理，证书自动签发（域名要已解析到本机，80/443 可达）：

```bash
docker compose up -d --build        # 在 packages/cloud 下
sudo apt-get install -y caddy
sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
api.你的域名.com {
  reverse_proxy 127.0.0.1:3000
}
EOF
sudo systemctl reload caddy
```

容器启动命令会先 `prisma migrate deploy` 再启动服务，迁移自动应用。首次启动会按 `ADMIN_EMAIL`/`ADMIN_PASSWORD` 建管理员；确认能登录后，把 `ADMIN_PASSWORD` 从 `.env` 删掉并 `docker compose up -d` 重建。

## 4. 验证

```bash
curl -fsS https://api.你的域名.com/health
docker compose logs --tail=50 app
```

再用管理后台登录并生成邀请码（见 `docs/launch-prereqs-guide.md` 第 1 节）。

## 5. 客户端指向这台云端

打包版和本地调试都用环境变量或 `config.yaml`：`TALEKILN_CLOUD_URL=https://api.你的域名.com`（或 `cloud.base_url`）。测试者安装包里的默认值需要在发布前设好。

## 6. 备份和注意

- 备份：`docker compose exec postgres pg_dump -U talekiln talekiln | gzip > backup-$(date +%F).sql.gz`，每天一次，拷到机外。
- 已知未验证：云端镜像在真实机器上还没有构建过；限流是进程内的（单机够用）；`/r/:code` 和登录接口没有单独限流，公网暴露前建议在 Caddy 或安全组层面限速。
- 管理后台（`apps/admin`）的静态页怎么托管还没写进这份文档，需要时再补；邀请码也可以直接调管理接口生成。
