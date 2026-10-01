import { json } from 'express';
import type { INestApplication } from '@nestjs/common';
import { ErrorFilter } from './filter';

/** 创建应用时需传 { bodyParser: false }：这里按路径设置不同的请求体上限。 */
export const FEEDBACK_BODY_LIMIT = '2500kb'; // 1.5MB 诊断包的 base64 约 2MB，外加文字
export const DEFAULT_BODY_LIMIT = '100kb';

export function configureApp(app: INestApplication) {
  if (process.env.TRUST_PROXY) {
    // 部署在反向代理之后时设为代理层数（如 1），限流才会用真实客户端 IP
    (app.getHttpAdapter().getInstance() as { set: (k: string, v: unknown) => void }).set('trust proxy', Number(process.env.TRUST_PROXY));
  }
  app.use('/feedback', json({ limit: FEEDBACK_BODY_LIMIT }));
  app.use(json({ limit: DEFAULT_BODY_LIMIT })); // body-parser 遇到已解析的请求会跳过
  app.useGlobalFilters(new ErrorFilter());
}
