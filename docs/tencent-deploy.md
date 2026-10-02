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

## 8. 对象存储（MinIO）

> **2026-10-02 更新**：MinIO 官方镜像与二进制已拿不到（quay.io / Docker Hub 拒绝拉取，dl.min.io 回 410）。本节的 compose 文件在选定替代服务器（SeaweedFS / Garage / RustFS，或阿里云 OSS / 腾讯云 COS）之前只能当占位；桶布局、策略与客户端设置对任何 S3 兼容服务都一样。CI 里已验证 SeaweedFS 的 S3 网关可用（`scripts/ci-s3-server.sh`）。

决定：先自己搭 MinIO，后续再接第三方。桌面端的「云备份」（P3-K，`docs/phase3-backup.md`）走 S3 兼容接口，所以今天指向这台 MinIO，以后换阿里云 OSS（S3 兼容接口）、腾讯云 COS 或 Cloudflare R2 只要改地址 / 区域 / 存储桶，客户端代码不动。同一套桶布局也是工作室版共享素材库（前缀 `shared/`）的基础。

### 8.1 启动

```bash
cd packages/cloud
# .env 里加：MINIO_ROOT_USER=<管理员账号>  MINIO_ROOT_PASSWORD=<至少 8 位的随机口令>
#            MINIO_SERVER_URL=https://s3.你的域名.com  MINIO_BROWSER_REDIRECT_URL=https://s3.你的域名.com/console（可选）
docker compose -f docker-compose.yml -f docker-compose.minio.yml up -d
curl -fsS http://127.0.0.1:9000/minio/health/live && echo ok
```

`docker-compose.minio.yml` 只把 9000（S3 API）和 9001（控制台）绑到 `127.0.0.1`：对外只走下面的 Caddy。数据在卷 `miniodata`。大陆机房拉不到 Docker Hub 时在 `.env` 里把 `MINIO_IMAGE` 换成镜像站地址（同 2.5 节）。

### 8.2 Caddy：`s3.你的域名.com` -> 127.0.0.1:9000

```
s3.你的域名.com {
  reverse_proxy 127.0.0.1:9000
  request_body {
    max_size 2GB
  }
}
```

`sudo systemctl reload caddy` 后 `curl -fsS https://s3.你的域名.com/minio/health/live`。ICP 的注意事项与 API 域名一样（第 0 节）：大陆服务器上没备案的域名 80/443 会被拦，证书也签不下来。路径式寻址（MinIO 默认）下不需要通配符证书；桌面端默认就是路径式。控制台不对公网开放，需要时 `ssh -L 9001:127.0.0.1:9001 服务器` 后本机打开 `http://127.0.0.1:9001`。

### 8.3 存储桶与最小权限的访问密钥（给桌面端）

管理员账号只用来建桶和建用户，**不要**填进桌面端。在服务器上用容器自带的 `mc`：

```bash
alias mc='docker compose -f docker-compose.yml -f docker-compose.minio.yml exec minio mc'
mc alias set local http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
mc mb local/talekiln-backup
mc anonymous set none local/talekiln-backup           # 不允许匿名访问

# 只能读写 talekiln-backup 桶里 talekiln/ 前缀的策略
cat > /tmp/backup-policy.json <<'JSON'
{ "Version": "2012-10-17", "Statement": [
  { "Effect": "Allow", "Action": ["s3:ListBucket", "s3:GetBucketLocation"], "Resource": ["arn:aws:s3:::talekiln-backup"],
    "Condition": { "StringLike": { "s3:prefix": ["talekiln/*", "talekiln"] } } },
  { "Effect": "Allow", "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"], "Resource": ["arn:aws:s3:::talekiln-backup/talekiln/*"] }
] }
JSON
docker compose -f docker-compose.yml -f docker-compose.minio.yml cp /tmp/backup-policy.json minio:/tmp/backup-policy.json
mc admin policy create local talekiln-backup-rw /tmp/backup-policy.json
mc admin user add local <桌面端AccessKey> <桌面端SecretKey>       # 用随机串，各 20+ 位
mc admin policy attach local talekiln-backup-rw --user <桌面端AccessKey>
```

每个用户（或每台机器）一把 Key，泄露就 `mc admin user remove` 单独吊销。`ListBucket` 必须放开 `talekiln/` 前缀：客户端的「测试连接」会 `HEAD bucket` 加一次前缀列举，快照列表与保留策略也靠它。

### 8.4 桌面端设置

「云备份」页填：地址 `https://s3.你的域名.com`，区域 `us-east-1`（MinIO 默认；没特意配就是它），存储桶 `talekiln-backup`，前缀 `talekiln`，Access Key / Secret Key 用上一步建的用户，勾选「路径式寻址」。「测试连接」通过后再保存；Secret Key 保存在系统密钥存储里，设置文件里没有。家里 NAS 上的 MinIO 可以直接用 `http://192.168.x.x:9000`（客户端只对本机 / 局域网地址放行 http）。

### 8.5 备份 MinIO 自己的数据

对象存储是用户项目的异地副本，它自己也要有副本：

```bash
docker run --rm --volumes-from "$(docker compose -f docker-compose.yml -f docker-compose.minio.yml ps -q minio)" -v "$PWD:/backup" alpine \
  tar czf /backup/minio-data-$(date +%F).tgz /data
```

每天一次，和 PostgreSQL 的 `pg_dump` 一起拷到机外；更省事的是 `mc mirror local/talekiln-backup <另一台机器或第三方桶>`。每个快照是独立的 zip + json 一对，拷到一半的快照在恢复时会被 sha256 校验拒绝，不会悄悄恢复出坏数据。

### 8.6 换第三方对象存储

任何 S3 兼容服务都行，桌面端只改设置：

| 服务 | 地址 | 区域 | 寻址 |
|---|---|---|---|
| 阿里云 OSS（S3 兼容接口） | `https://s3.oss-cn-hangzhou.aliyuncs.com` 之类 | `oss-cn-hangzhou` | 虚拟主机式（取消勾选「路径式」） |
| 腾讯云 COS | `https://cos.ap-shanghai.myqcloud.com` 之类 | `ap-shanghai` | 虚拟主机式 |
| Cloudflare R2 | `https://<账号id>.r2.cloudflarestorage.com` | `auto` | 路径式 |

以上地址格式按各家当前文档为准，这里没有在真实账号上验证过。第三方的 Key 同样只给单桶、单前缀的最小权限。

### 8.7 工作室版共享库（P3-S）：同一个桶里的 `shared/` 前缀

工作室版的共享角色库与模板放在同一个桶、同一个前缀下的 `talekiln/shared/<studio_id>/…`（`docs/phase3-studio.md` §2），**现在桌面端沿用 8.3 那把 Key**，它对 `talekiln/*` 整体读写，所以「成员只读、管理员可写」目前只由本机服务层强制。等 Jay 决定做每工作室独立凭据时，按前缀再建两份策略即可（把 `<studio_id>` 换成实际 id；成员只读、管理员读写）：

```bash
cat > /tmp/studio-ro.json <<'JSON'
{ "Version": "2012-10-17", "Statement": [
  { "Effect": "Allow", "Action": ["s3:ListBucket", "s3:GetBucketLocation"], "Resource": ["arn:aws:s3:::talekiln-backup"],
    "Condition": { "StringLike": { "s3:prefix": ["talekiln/shared/<studio_id>/*", "talekiln/shared/<studio_id>"] } } },
  { "Effect": "Allow", "Action": ["s3:GetObject"], "Resource": ["arn:aws:s3:::talekiln-backup/talekiln/shared/<studio_id>/*"] }
] }
JSON
cat > /tmp/studio-rw.json <<'JSON'
{ "Version": "2012-10-17", "Statement": [
  { "Effect": "Allow", "Action": ["s3:ListBucket", "s3:GetBucketLocation"], "Resource": ["arn:aws:s3:::talekiln-backup"],
    "Condition": { "StringLike": { "s3:prefix": ["talekiln/shared/<studio_id>/*", "talekiln/shared/<studio_id>"] } } },
  { "Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], "Resource": ["arn:aws:s3:::talekiln-backup/talekiln/shared/<studio_id>/*"] }
] }
JSON
mc admin policy create local studio-<studio_id>-ro /tmp/studio-ro.json
mc admin policy create local studio-<studio_id>-rw /tmp/studio-rw.json
```

云端的 `STUDIO_DEFAULT_SEAT_LIMIT`（默认 3）是新建工作室的席位数，席位定价待定，后台「工作室」页可以逐个调整。这一节的策略没有在真实 MinIO 上验证过。
