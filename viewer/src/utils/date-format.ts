/**
 * 日期格式化工具（本地时区显示）。
 */

import { t } from '../i18n';

/**
 * 解析 ISO 时间串，无效时返回 null。
 */
function toDate(dateString: string): Date | null {
  if (!dateString) return null;
  const d = new Date(dateString);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * 格式化为 YYYY-MM-DD。
 */
export function formatDate(dateString: string): string {
  const date = toDate(dateString);
  if (!date) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 格式化为 YYYY-MM-DD HH:mm。
 */
export function formatDateTime(dateString: string): string {
  const date = toDate(dateString);
  if (!date) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

/**
 * 格式化为 HH:mm。
 */
export function formatTime(dateString: string): string {
  const date = toDate(dateString);
  if (!date) return '';
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * 格式化为相对时间（今天 / 昨天 / N 天前…）。
 */
export function formatRelativeTime(dateString: string): string {
  const date = toDate(dateString);
  if (!date) return '';
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays <= 0) return t('time.today');
  if (diffDays === 1) return t('time.yesterday');
  if (diffDays < 7) return t('time.daysAgo', { n: diffDays });
  if (diffDays < 30) return t('time.weeksAgo', { n: Math.floor(diffDays / 7) });
  if (diffDays < 365) return t('time.monthsAgo', { n: Math.floor(diffDays / 30) });
  return t('time.yearsAgo', { n: Math.floor(diffDays / 365) });
}
