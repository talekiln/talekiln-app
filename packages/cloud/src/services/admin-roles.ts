import type { Account, AdminRoleName, AdminRoleRecord } from '../domain/repositories';

/**
 * 后台权限。接口用 @Require(权限) 声明所需权限，AdminGuard 按当前管理员角色放行。
 * 未声明时的默认值：GET 需要 read，其它方法需要 ops:write（宁严勿松）。
 */
export const PERMISSIONS = [
  'read',                 // 查看运营数据（概览、用户、订单、版本、公告……）
  'ops:write',            // 日常运营写操作：邀请码、用户启停、公告、版本灰度、模型目录、发票登记
  'feedback:diagnostic',  // 下载用户诊断包
  'billing:refund',       // 订单退款（动钱）
  'billing:plans',        // 套餐与价格版本
  'admins:manage',        // 管理员与角色
  'audit:read',           // 查看审计日志
  'plugins:review',       // 插件版本审核（通过/驳回）
  'plugins:sign',         // 用官方密钥给插件版本签名（签出去的包在所有客户端都算官方）
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ADMIN_ROLES = ['ADMIN', 'OPERATOR', 'READONLY'] as const;

export const ROLE_PERMISSIONS: Record<AdminRoleName, readonly Permission[]> = {
  READONLY: ['read'],
  OPERATOR: ['read', 'ops:write', 'feedback:diagnostic', 'plugins:review'],
  ADMIN: PERMISSIONS,
};

export const can = (role: AdminRoleName | null | undefined, perm: Permission): boolean =>
  !!role && ROLE_PERMISSIONS[role].includes(perm);

/**
 * 有效角色：有 AdminRole 记录以它为准；没有记录但 Account.role = ADMIN 的（P1 创建的管理员）按 ADMIN；
 * 其余不是管理员。
 */
export function effectiveRole(account: Pick<Account, 'role'>, row: Pick<AdminRoleRecord, 'role'> | null): AdminRoleName | null {
  if (row) return row.role;
  return account.role === 'ADMIN' ? 'ADMIN' : null;
}
