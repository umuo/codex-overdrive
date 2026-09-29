import { invoke as nativeInvoke, isTauri } from '@tauri-apps/api/core';

// Explicit development-only preview: never reads credentials or sends real messages.
export const isPreview = import.meta.env.DEV && !isTauri() && new URLSearchParams(location.search).get('demo') === '1';
export const isDesktop = isTauri();
const previewSessions = [
  ['monitor-ui', '优化监控面板布局与交互', false],
  ['api-retry', '为 API 请求增加重试与超时处理', true],
  ['release-check', '检查桌面应用自动更新流程', false],
  ['test-coverage', '补充任务调度的回归测试', false],
  ['docs-refresh', '整理项目文档与开发指南', true],
  ['perf-review', '分析数据库查询性能', false],
  ['settings-page', '完善设置页面与快捷操作', false],
  ['build-pipeline', '排查跨平台构建问题', false],
].map(([id, thread_name, is_goal_limited], index) => ({ id, thread_name, is_goal_limited, updated_at: new Date(Date.now() - index * 3600000).toISOString() }));

export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isPreview) {
    if (!isDesktop) throw new Error('请在桌面应用中连接 Codex');
    return nativeInvoke<T>(command, args);
  }
  await new Promise(resolve => setTimeout(resolve, 180));
  const results: Record<string, unknown> = {
    get_sessions: previewSessions,
    check_quota: { allowed: true, used_percent: 38.5, reset_at: Math.floor(Date.now() / 1000) + 8235, error: null },
    get_session_status: { turn_id: `preview-${args?.sessionId}`, status: 'completed' },
    trigger_via_cli: '预览消息已模拟加入队列',
    start_caffeinate: null,
    stop_caffeinate: null,
  };
  if (!(command in results)) throw new Error(`Unknown preview command: ${command}`);
  return results[command] as T;
}
