# 云端部署到腾讯云小服务器（2 核 4G，Ubuntu）

适用：内测用的单机部署（Postgres + 云端 API 同一台机器）。在服务器上由你或本地会话照着执行。云端会话不登录服务器，也不保存服务器口令。

> 口令规则：服务器口令、数据库口令、`JWT_ACCESS_SECRET`、许可证私钥、插件签名私钥、管理员口令都只放服务器上的 `.env`（权限 600），不进 git、不贴聊天。服务器口令已经在聊天里出现过，部署完成后请在腾讯云控制台重置，并改用 SSH 密钥登录、关闭密码登录。

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

插件签名用另一把独立的私钥（`PLUGIN_SIGNING_PRIVATE_KEY_PEM`），生成和保管方式见第 7 节；没配时云端暂用许可证密钥给插件签名并在日志里告警。

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

## 7. 插件签名密钥（只在服务器上生成和保管）

决定：**官方插件签名私钥只存在于这台云端服务器的 `.env` 里，签名只在云端做**（后台「插件审核」页的「官方签名」按钮 → `POST /admin/plugins/:id/sign`）。它和许可证密钥是两把：许可证、模型目录、模板用 `LICENCE_PRIVATE_KEY_PEM`（kid `lic-1`），插件包用 `PLUGIN_SIGNING_PRIVATE_KEY_PEM`（kid 默认 `plg-1`）。客户端只认云端 `GET /.well-known/licence-jwks.json` 里出现的 kid，所以这把私钥不分发给任何人（审核员、作者、CI 都没有），`sign-plugin.mjs` 用开发者自己的密钥签出来的包在所有客户端都是「签名无效（unknown kid）」。

### 7.1 生成并写入 `.env`

```bash
cd ~/talekiln-app/packages/cloud
# 1) 生成 EC P-256（prime256v1）私钥，PKCS8 PEM；只在服务器上做，不要在本机生成再传
umask 077
openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt -out plg.pem
# 2) 顺手导出公钥（轮换时要放进退役列表；公钥不是机密，可以存进文档/工单）
openssl pkey -in plg.pem -pubout -out plg.pub.pem
# 3) 写进 .env（换行替换成 \n）。kid 建议带编号或日期，不能与 LICENCE_KEY_ID 相同
printf 'PLUGIN_SIGNING_PRIVATE_KEY_PEM=%s\n' "$(awk 'NF {printf "%s\\n", $0}' plg.pem)" >> .env
printf 'PLUGIN_SIGNING_KEY_ID=plg-1\n' >> .env
chmod 600 .env
# 4) 先做离线备份（7.3），确认备份能解密后再销毁明文
shred -u plg.pem
```

`.env` 里应当只有这几行与插件签名相关：`PLUGIN_SIGNING_PRIVATE_KEY_PEM`、`PLUGIN_SIGNING_KEY_ID`，以及轮换后才会用到的 `PLUGIN_SIGNING_RETIRED_PUBLIC_KEYS_PEM` / `PLUGIN_SIGNING_RETIRED_KEY_IDS`。`docker-compose.yml` 已经把它们透传给 app 容器。

### 7.2 重启并验证

```bash
docker compose up -d                      # 重建 app 容器读取新 .env
docker compose logs --tail=30 app         # 不应再出现「未提供 PLUGIN_SIGNING_PRIVATE_KEY_PEM」的告警
curl -fsS https://api.你的域名.com/.well-known/licence-jwks.json | python3 -m json.tool
```

JWKS 里应有两把 `EC / P-256 / ES256 / use: sig` 的公钥：`lic-1` 和 `plg-1`（只有 `x`、`y`，没有 `d`）。公开插件目录 `GET /plugins/catalog` 的 `kid` 也应变成 `plg-1`。再用管理员账号登录后台「插件审核」页，页顶横幅应显示「当前官方签名密钥 plg-1（独立的插件签名密钥）」而不是「暂用许可证密钥」。启动失败的常见原因：PEM 不是 P-256（提示 `必须是 EC P-256`）、kid 与 `LICENCE_KEY_ID` 相同、`\n` 转义写错。

### 7.3 备份

- 私钥只有两份：服务器 `.env` 和**一份加密的离线备份**。备份做法：`openssl enc -aes-256-cbc -pbkdf2 -in plg.pem -out plg.pem.enc`（口令另行保管，不与备份放在一起），把 `plg.pem.enc` 存到不联网的介质（U 盘/密码管理器附件），**不要**放进 git、网盘同步目录或聊天。
- 谁持有：建议由 Jay 本人持有离线备份与口令，运维/审核员都不持有（待决，见文末）。
- 服务器重装或迁移时从备份恢复到新 `.env`，kid 不变，已签出去的包不受影响。
- 备份丢失但服务器还在：立刻按 7.4 轮换。私钥泄露：同样按 7.4 轮换，并且**不要**把旧公钥放进退役列表（否则泄露前后的伪造签名都会被客户端当官方）。

### 7.4 轮换

签名不能撤回（`docs/phase3-plugins.md` 第 1 节）：驳回只是撤出目录，已经分发出去的包仍验得过。让旧签名作废的唯一办法是换密钥并把旧公钥从 JWKS 拿掉。正常轮换（定期、备份丢失）时希望旧包继续能用，就把旧公钥放进退役列表：

```bash
# 新钥：按 7.1 生成 plg-new.pem，写入 .env 时把 PLUGIN_SIGNING_PRIVATE_KEY_PEM 换成新私钥、PLUGIN_SIGNING_KEY_ID 换成新 kid（如 plg-2）
# 旧钥：只保留公钥，加入退役列表（多把用 ; 分隔，kid 按同样顺序用 , 分隔）
printf 'PLUGIN_SIGNING_RETIRED_PUBLIC_KEYS_PEM=%s\n' "$(awk 'NF {printf "%s\\n", $0}' plg.pub.pem)" >> .env
printf 'PLUGIN_SIGNING_RETIRED_KEY_IDS=plg-1\n' >> .env
docker compose up -d
curl -fsS https://api.你的域名.com/.well-known/licence-jwks.json   # 应同时看到 lic-1、plg-2、plg-1
```

退役列表只接受公钥（SPKI PEM）；填了私钥会拒绝启动。旧私钥（含离线备份）在新钥验证通过后销毁。客户端下次拉 JWKS 后新 kid 即生效；已安装、用旧 kid 签的包因为退役公钥还在而继续是「官方签名」。后台「插件审核」页会把旧 kid 签的版本标成「旧密钥 plg-1」，管理员可以对它再点一次「官方签名」用新钥重签（同一 kid 不会重复签）。要**作废**某把钥签出的全部包：不把它加进退役列表（或从列表删掉）并重启——这是全局动作，该钥签过的所有插件都会在客户端变成「签名无效」。

### 7.5 运营流程（后台「插件审核」页）

1. 作者在本地 `node packages/plugin-sdk/scripts/sign-plugin.mjs <插件目录> --inspect`，把输出 JSON、包的 https 下载地址和包文件 `sha256` 交给运营。
2. 运营（OPERATOR 及以上）在「插件审核」→「登记新版本」粘贴 `--inspect` 输出、填地址和 sha256 → 版本进入「待审核」。
3. 审核员（OPERATOR 及以上）下载包、核对 `sha256`，解包后再跑一次 `--inspect`，确认指纹 `hash` 与详情抽屉里的一致，看代码，然后「通过」或「驳回」（写备注）。云端不下载、不执行插件包，这一步是人工把关。
4. 管理员（ADMIN）在详情抽屉点「官方签名（plg-1）」：签名在服务器上完成，抽屉出现「已签名清单」，用「复制已签名清单」或「下载 manifest.json」交给作者。
5. 作者用它原样覆盖包里的 `manifest.json`（签名不覆盖 `manifest.json` 本身，所以不会失效），重新打包分发；已通过的版本出现在公开目录 `GET /plugins/catalog`。
6. 每一步都进审计日志（「管理员与审计」页：登记插件版本 / 通过插件审核 / 驳回插件版本 / 官方签名插件版本），运营越权点签名也会被记录。

待决（Jay）：离线备份与解密口令由谁持有；是否定期轮换（例如每年）；审核员名单。
