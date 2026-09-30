import { useState, useEffect, useRef } from "react";
import { invoke, isPreview, isDesktop } from "./bridge";
import "./App.css";
import { startMonitor, checkMonitoredSessions, type SessionMonitorState } from "./monitor";

interface Session {
  id: string;
  thread_name: string;
  updated_at: string;
  is_goal_limited: boolean;
}

interface QuotaState {
  allowed: boolean;
  used_percent: number;
  reset_at: number | null;
  error: string | null;
}

function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(new Set());
  const [isMonitoring, setIsMonitoring] = useState(false);
  const monitoringRef = useRef(false);
  const monitorTogglePending = useRef(false);
  const [log, setLog] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const [sessionFilter, setSessionFilter] = useState("all");
  const [isLoadingSessions, setIsLoadingSessions] = useState(false);
  const [sessionError, setSessionError] = useState("");
  const [quotaError, setQuotaError] = useState("");
  const [isRefreshingQuota, setIsRefreshingQuota] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const sendingRef = useRef(false);
  const [isToggling, setIsToggling] = useState(false);
  const [logFilter, setLogFilter] = useState("all");
  const [followLogs, setFollowLogs] = useState(true);
  const logEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (followLogs) logEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [log, followLogs]);
  
  const [quota, setQuota] = useState<QuotaState | null>(null);
  const [timeLeftStr, setTimeLeftStr] = useState("00:00:00");
  const [timeLeftSec, setTimeLeftSec] = useState(0);


  const countdownIntervalRef = useRef<number | null>(null);

  const [searchTerm, setSearchTerm] = useState("");
  const [updateAvailable, setUpdateAvailable] = useState<string | null>(null);
  const [updaterContext, setUpdaterContext] = useState<any>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<number>(0);
  const [currentVersion, setCurrentVersion] = useState<string>("读取中...");

  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);

  useEffect(() => {
    checkUpdate();
  }, []);

  const checkUpdate = async (manual = false) => {
    if (isCheckingUpdate) return;
    if (!isDesktop) {
      setCurrentVersion(isPreview ? "预览" : "网页模式");
      if (manual) setNotice("请在桌面应用中检查更新。");
      return;
    }
    try {
      setIsCheckingUpdate(true);
      const { getVersion } = await import('@tauri-apps/api/app');
      const v = await getVersion();
      setCurrentVersion(v);
      
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check();
      if (update) {
        setUpdateAvailable(update.version);
        setUpdaterContext(update);
      } else if (manual) {
        setNotice(`当前已是最新版本 (v${v})`);
      }
    } catch (e) {
      console.error("Update check failed", e);
      if (manual) {
        setNotice("检查更新失败: " + e);
      }
    } finally {
      setIsCheckingUpdate(false);
    }
  };

  const handleUpdate = async () => {
    if (!updaterContext || isUpdating) return;
    setIsUpdating(true);
    let downloaded = 0;
    let contentLength = 0;
    try {
      await updaterContext.downloadAndInstall((event: any) => {
        switch (event.event) {
          case 'Started':
            contentLength = event.data.contentLength;
            console.log(`started downloading ${event.data.contentLength} bytes`);
            break;
          case 'Progress':
            downloaded += event.data.chunkLength;
            if (contentLength > 0) {
              setUpdateProgress(Math.round((downloaded / contentLength) * 100));
            }
            break;
          case 'Finished':
            console.log('download finished');
            setUpdateProgress(100);
            break;
        }
      });
      console.log('update installed');
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    } catch (e) {
      console.error(e);
      setNotice("更新失败: " + e);
      setIsUpdating(false);
      setUpdateProgress(0);
    }
  };

  const loadSessions = async () => {
    setIsLoadingSessions(true);
    setSessionError("");
    try {
      const loaded: Session[] = await invoke("get_sessions");
      setSessions(loaded);
      setSelectedSessions(prev => new Set([...prev].filter(id => loaded.some(session => session.id === id))));
    } catch (e) {
      console.error(e);
      addLog(`刷新会话失败: ${e}`);
      setSessionError(String(e));
    } finally {
      setIsLoadingSessions(false);
    }
  };

  useEffect(() => {
    loadSessions();
    fetchQuota();
  }, []);

  const addLog = (msg: string) => {
    const time = new Date().toLocaleTimeString();
    setLog(prev => [...prev, `[${time}] ${msg}`].slice(-30));
  };

  const fetchQuota = async () => {
    setIsRefreshingQuota(true);
    try {
      const q: QuotaState = await invoke("check_quota");
      if (q.error) {
        setQuotaError(q.error);
        addLog(`额度获取失败: ${q.error}`);
        return null;
      }
      setQuota(q);
      setQuotaError("");
      
      if (q.reset_at) {
        const now = Math.floor(Date.now() / 1000);
        const diff = q.reset_at - now;
        setTimeLeftSec(diff > 0 ? diff : 0);
      } else {
        setTimeLeftSec(0);
      }
      return q;
    } catch (e) {
      setQuotaError(String(e));
      addLog(`请求额度接口出错: ${e}`);
      return null;
    } finally {
      setIsRefreshingQuota(false);
    }
  };

  // Countdown timer logic
  useEffect(() => {
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current);
    }
    
    countdownIntervalRef.current = window.setInterval(() => {
      setTimeLeftSec(prev => {
        if (prev <= 0) return 0;
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
    };
  }, []);

  // Format time left
  useEffect(() => {
    if (timeLeftSec <= 0) {
      setTimeLeftStr("00:00:00");
      return;
    }
    const h = Math.floor(timeLeftSec / 3600).toString().padStart(2, '0');
    const m = Math.floor((timeLeftSec % 3600) / 60).toString().padStart(2, '0');
    const s = (timeLeftSec % 60).toString().padStart(2, '0');
    setTimeLeftStr(`${h}:${m}:${s}`);
  }, [timeLeftSec]);

  const [savedMessages, setSavedMessages] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('savedTriggerMessages') || 'null');
      if (Array.isArray(saved) && saved.length && saved.every(m => typeof m === "string" && m.trim())) return saved as string[];
    } catch { /* Fall back if stored data is invalid. */ }
    return ["继续", "恢复目标", "请继续刚才未完成的代码"];
  });
  const [triggerMessage, setTriggerMessage] = useState(savedMessages[0]);

  useEffect(() => {
    localStorage.setItem('savedTriggerMessages', JSON.stringify(savedMessages));
  }, [savedMessages]);

  const handleSaveMessage = () => {
    const msg = triggerMessage.trim();
    if (!msg) return;
    if (!savedMessages.includes(msg)) {
      setSavedMessages([...savedMessages, msg]);
      addLog(`[消息管理] 已保存新常用语: "${msg}"`);
    }
  };

  const handleDeleteMessage = () => {
    if (savedMessages.length <= 1) {
      setNotice("至少保留一条常用语。");
      return;
    }
    const newMessages = savedMessages.filter(m => m !== triggerMessage);
    setSavedMessages(newMessages);
    setTriggerMessage(newMessages[0]);
    addLog(`[消息管理] 已删除常用语: "${triggerMessage}"`);
  };

  const monitorStatesRef = useRef<Record<string, SessionMonitorState>>({});
  const [activeMonitorCount, setActiveMonitorCount] = useState(0);

  const pendingTriggersRef = useRef(new Set<string>());

  // Monitor loop (Smart Polling & Auto-Looping)
  useEffect(() => {
    if (!isMonitoring) return;
    const states = monitorStatesRef.current;

    return startMonitor(async (isActive) => {
      const q = await fetchQuota();
      if (!isActive()) return 0;
      let nextCheckMs = 5 * 60 * 1000;

      await checkMonitoredSessions({
        sessionIds: Array.from(selectedSessions),
        quotaAllowed: q?.allowed === true,
        isActive,
        states,
        pending: pendingTriggersRef.current,
        getStatus: id => invoke("get_session_status", { sessionId: id }),
        trigger: async id => {
          const name = sessions.find(session => session.id === id)?.thread_name || id.substring(0, 8);
          addLog(`额度可用 · ${name} · 发送："${triggerMessage}"`);
          await invoke("trigger_via_cli", { sessionId: id, message: triggerMessage.trim() });
          if (isActive()) addLog(`发送成功 · ${name}，等待下一次状态检查`);
        },
        onStop: (id, reason) => {
          const name = sessions.find(session => session.id === id)?.thread_name || id.substring(0, 8);
          addLog(`停止会话监控 · ${name} · ${reason}`);
        },
        onError: err => addLog(`监控检查失败: ${err}`),
      });
      if (!isActive()) return 0;
      const remaining = Array.from(selectedSessions).filter(id => states[id]?.phase !== "stopped");
      setActiveMonitorCount(remaining.length);
      if (!remaining.length) {
        monitoringRef.current = false;
        monitorTogglePending.current = true;
        setIsMonitoring(false);
        setIsToggling(true);
        addLog("所有会话均已停止监控。");
        try {
          await invoke("stop_caffeinate");
        } catch (e) {
          addLog(`释放防休眠进程失败: ${e}`);
        } finally {
          monitorTogglePending.current = false;
          setIsToggling(false);
        }
        return 0;
      }
      const awaitingResult = remaining.some(id => states[id]?.phase === "awaiting_result");
      if (q?.allowed || awaitingResult) {
        // After sending, check session progress even while quota is unavailable.
        nextCheckMs = 30 * 1000;
      } else {
        // 额度耗尽时，根据剩余时间动态调整探测频率
        if (q && q.reset_at) {
          const now = Math.floor(Date.now() / 1000);
          const diff = q.reset_at - now;
          
          let minMs = 0;
          let maxMs = 0;
          
          if (diff > 3600) { // 剩余大于1小时
            minMs = 10 * 60 * 1000;
            maxMs = 20 * 60 * 1000;
          } else if (diff > 1800) { // 剩余30-60分钟
            minMs = 5 * 60 * 1000;
            maxMs = 10 * 60 * 1000;
          } else if (diff > 600) { // 剩余10-30分钟
            minMs = 2 * 60 * 1000;
            maxMs = 5 * 60 * 1000;
          } else if (diff > 180) { // 剩余3-10分钟
            minMs = 60 * 1000;
            maxMs = 120 * 1000;
          } else if (diff > 60) { // 剩余1-3分钟
            minMs = 30 * 1000;
            maxMs = 60 * 1000;
          } else if (diff > 0) { // 剩余1分钟以内
            minMs = 15 * 1000;
            maxMs = 30 * 1000;
          } else { // 已经到了或超过时间，但可能接口还没刷新额度
            minMs = 10 * 1000;
            maxMs = 20 * 1000;
          }
          
          nextCheckMs = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
          const nextCheckSecs = Math.round(nextCheckMs / 1000);
          
          // 为了避免刷屏，只在间隔大于 1 分钟时才打印详细日志
          if (nextCheckMs >= 60000) {
            addLog(`⏳ [等待额度] 下一次探测将在约 ${Math.round(nextCheckSecs / 60)} 分钟后进行 (剩余${Math.round(diff/60)}分钟)`);
          } else {
            addLog(`⏳ [等待额度] 临近刷新，${nextCheckSecs} 秒后探测...`);
          }
        } else {
          // 拿不到 reset_at 时的兜底
          const randomMins = Math.floor(Math.random() * (10 - 5 + 1)) + 5;
          nextCheckMs = randomMins * 60 * 1000;
          addLog(`⏳ [等待额度] 未知重置时间，将在 ${randomMins} 分钟后重试...`);
        }
      }

      return nextCheckMs;
    }, () => monitoringRef.current);
  }, [isMonitoring, selectedSessions, triggerMessage]);

  const triggerAllSelected = async () => {
    if (sendingRef.current || isMonitoring || !selectedSessions.size || !triggerMessage.trim()) return;
    sendingRef.current = true;
    setIsSending(true);
    let succeeded = 0;
    try {
      for (const id of selectedSessions) {
        try {
          await invoke("trigger_via_cli", { sessionId: id, message: triggerMessage.trim() });
          succeeded++;
          addLog(`发送成功 · ${sessions.find(s => s.id === id)?.thread_name || id}`);
        } catch (err) {
          addLog(`发送失败 · ${id}: ${err}`);
        }
      }
      setNotice(`发送完成：${succeeded} / ${selectedSessions.size} 个会话成功。`);
    } finally {
      sendingRef.current = false;
      setIsSending(false);
    }
  };

  const toggleSession = (id: string) => {
    const newSet = new Set(selectedSessions);
    if (newSet.has(id)) {
      newSet.delete(id);
    } else {
      newSet.add(id);
    }
    setSelectedSessions(newSet);
  };

  const handleMonitorToggle = async () => {
    if (monitorTogglePending.current) return;
    monitorTogglePending.current = true;
    setIsToggling(true);
    try {
      if (monitoringRef.current) {
        // Invalidate pending checks immediately, before React runs effect cleanup.
        monitoringRef.current = false;
        setIsMonitoring(false);
        try {
          await invoke("stop_caffeinate");
          addLog("监控已停止，已释放本应用的防休眠进程。");
        } catch (e) {
          addLog(`监控已停止，但释放防休眠进程失败: ${e}`);
        }
      } else {
        if (selectedSessions.size === 0 || !triggerMessage.trim()) {
          setNotice("请选择会话并填写触发消息。");
          return;
        }
        try {
          await invoke("start_caffeinate");
        } catch (e) {
          addLog(`防休眠启动失败: ${e}`);
        }
        monitorStatesRef.current = {};
        setActiveMonitorCount(selectedSessions.size);
        monitoringRef.current = true;
        setIsMonitoring(true);
        addLog(`开始监控，已选中 ${selectedSessions.size} 个会话。`);
      }
    } finally {
      monitorTogglePending.current = false;
      setIsToggling(false);
    }
  };

  const filteredSessions = sessions.filter(s =>
    (s.thread_name || "未命名会话").toLowerCase().includes(searchTerm.toLowerCase()) &&
    (sessionFilter !== "selected" || selectedSessions.has(s.id)) &&
    (sessionFilter !== "limited" || s.is_goal_limited)
  );
  const editingLocked = isMonitoring || isToggling || isSending;
  const allVisibleSelected = filteredSessions.length > 0 && filteredSessions.every(s => selectedSessions.has(s.id));
  const visibleLogs = log.filter(line => logFilter !== "error" || /失败|出错|错误/.test(line));
  const status = !isMonitoring ? "监控未启动" : quotaError || !quota ? "等待额度状态" : quota.allowed ? "正在监控" : "等待额度恢复";
  const formatDate = (value: string) => new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="会话选择">
        <div className="brand"><span className="brand-name">Codex <strong>Overdrive</strong></span><span className="eyebrow">让任务持续向前</span></div>
        <div className="sidebar-heading"><h2>会话</h2><span className="count">{sessions.length}</span><button className="text-button push-right" onClick={loadSessions} disabled={isLoadingSessions || editingLocked}>{isLoadingSessions ? "刷新中…" : "刷新"}</button></div>
        <div className="sidebar-tools">
          <input aria-label="搜索会话" type="search" placeholder="搜索会话名称…" value={searchTerm} onChange={e => setSearchTerm(e.target.value)} />
          <div className="segments" aria-label="会话筛选">{[["all", "全部"], ["limited", "受限目标"], ["selected", "已选"]].map(([value, label]) => <button key={value} aria-pressed={sessionFilter === value} onClick={() => setSessionFilter(value)}>{label}{value === "selected" && selectedSessions.size > 0 ? ` ${selectedSessions.size}` : ""}</button>)}</div>
          <div className="selection-toolbar"><label><input type="checkbox" checked={allVisibleSelected} disabled={editingLocked || !filteredSessions.length} onChange={() => setSelectedSessions(prev => { const next = new Set(prev); filteredSessions.forEach(s => allVisibleSelected ? next.delete(s.id) : next.add(s.id)); return next; })} />选择当前结果</label><button className="text-button" disabled={editingLocked || !selectedSessions.size} onClick={() => setSelectedSessions(new Set())}>清空</button></div>
        </div>
        {sessionError && <div className="inline-error" role="alert">会话加载失败，请重试。<span>{sessionError}</span></div>}
        <div className="session-list" aria-busy={isLoadingSessions}>
          {filteredSessions.map(s => <label key={s.id} className={`session-item ${selectedSessions.has(s.id) ? "selected" : ""}`}>
            <input type="checkbox" checked={selectedSessions.has(s.id)} disabled={editingLocked} onChange={() => toggleSession(s.id)} />
            <span className="session-info"><span className="session-name" title={s.thread_name}>{s.thread_name || "未命名会话"}</span><span className="session-meta"><time dateTime={s.updated_at}>{formatDate(s.updated_at)}</time>{s.is_goal_limited && <span className="badge warning">目标受限</span>}</span></span>
          </label>)}
          {!filteredSessions.length && !sessionError && <div className="empty-state"><strong>{isLoadingSessions ? "正在读取会话…" : searchTerm ? "没有匹配的会话" : sessionFilter === "selected" ? "还没有选择会话" : "暂无会话"}</strong><p>{searchTerm ? "试试其他关键词，或清除搜索。" : "选择需要自动继续的任务，它们会显示在这里。"}</p></div>}
        </div>
        <div className="sidebar-footer"><span>已选择 <strong>{selectedSessions.size}</strong> 个会话</span><span>{editingLocked ? "配置已锁定" : "支持多选"}</span></div>
      </aside>

      <main className="workspace">
        <header className="page-header"><div><div className="eyebrow">工作台 / 自动续行</div><h1>任务监控</h1></div><div className={`status-pill ${isMonitoring ? "live" : ""}`}><span className="status-dot" />{status}</div></header>
        {isPreview && <div className="preview-banner">交互预览 · 当前使用示例数据，所有发送操作均为模拟。</div>}
        {!isDesktop && !isPreview && <div className="preview-banner">请使用桌面应用连接本地 Codex。此页面仅展示界面。</div>}
        {notice && <div className="notice" role="status"><span>{notice}</span><button className="text-button" onClick={() => setNotice("")}>关闭</button></div>}
        {updateAvailable && <div className="notice"><span>新版本 {updateAvailable} 已就绪</span><button onClick={handleUpdate} disabled={isUpdating}>{isUpdating ? `下载中 ${updateProgress}%` : "安装并重启"}</button></div>}

        <section className="metrics" aria-label="监控概览">
          <div className="metric"><div className="metric-label">已用额度 <button className="text-button" onClick={fetchQuota} disabled={isRefreshingQuota}>{isRefreshingQuota ? "更新中…" : "刷新"}</button></div><div className="metric-value">{quota ? quota.used_percent.toFixed(1) : "—"}<small>{quota ? "%" : ""}</small>{quota && <span className={`badge ${quotaError ? "warning" : quota.allowed ? "positive" : "warning"}`}>{quotaError ? "上次数据" : quota.allowed ? "可用" : "受限"}</span>}</div><progress aria-label="已用额度" max="100" value={quota?.used_percent || 0} /><p>{quotaError ? "读取失败，稍后重试" : quota ? "当前额度窗口" : "正在获取额度"}</p></div>
          <div className="metric"><div className="metric-label">距离额度重置</div><div className="metric-value mono">{quota?.reset_at ? timeLeftStr : "— — : — —"}</div><p>{quota?.reset_at ? `预计 ${new Date(quota.reset_at * 1000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 重置` : "等待重置时间"}</p></div>
          <div className="metric"><div className="metric-label">监控范围</div><div className="metric-value">{isMonitoring ? activeMonitorCount : selectedSessions.size}<small>个会话</small></div><p>{isMonitoring ? "进行中或正常完成后停止" : "从左侧选择需要继续的任务"}</p></div>
        </section>

        <section className="composer panel" aria-labelledby="composer-title">
          <div className="section-heading"><h2 id="composer-title">触发消息</h2><span>首次额度可用即发送 · 后续仅重试额度中断</span></div>
          <div className="message-presets" aria-label="常用语">{savedMessages.map(message => <button key={message} className="preset" title={message} aria-pressed={triggerMessage === message} disabled={editingLocked} onClick={() => setTriggerMessage(message)}>{message}</button>)}</div>
          <textarea aria-label="触发消息" value={triggerMessage} placeholder="输入希望 Codex 继续执行的指令…" disabled={editingLocked} onChange={e => setTriggerMessage(e.target.value)} rows={3} />
          <div className="message-toolbar"><span>{triggerMessage.length} 字</span><div><button className="text-button" onClick={handleSaveMessage} disabled={editingLocked || savedMessages.includes(triggerMessage.trim()) || !triggerMessage.trim()}>保存为常用语</button><button className="text-button" onClick={handleDeleteMessage} disabled={editingLocked || !savedMessages.includes(triggerMessage) || savedMessages.length <= 1}>删除此常用语</button></div></div>
          <div className="action-bar"><p>{isMonitoring ? `正在监控 ${activeMonitorCount} 个会话。停止后可修改配置。` : !selectedSessions.size ? "选择会话后即可启动监控" : !triggerMessage.trim() ? "填写触发消息后即可启动" : `准备就绪，将应用于 ${selectedSessions.size} 个会话`}</p><div className="action-buttons"><button disabled={editingLocked || !selectedSessions.size || !triggerMessage.trim()} onClick={triggerAllSelected}>{isSending ? "发送中…" : "发送一次"}</button><button className={isMonitoring ? "danger-button" : "primary-button"} onClick={handleMonitorToggle} disabled={isToggling || isSending || (!isMonitoring && (!selectedSessions.size || !triggerMessage.trim()))}>{isToggling ? "处理中…" : isMonitoring ? "停止监控" : "启动监控"}</button></div></div>
        </section>

        <section className="activity panel" aria-labelledby="activity-title"><div className="section-heading"><h2 id="activity-title">运行记录 <span className="count">{log.length}</span></h2><div className="log-tools"><select aria-label="日志筛选" value={logFilter} onChange={e => setLogFilter(e.target.value)}><option value="all">全部记录</option><option value="error">仅错误</option></select><label><input type="checkbox" checked={followLogs} onChange={e => setFollowLogs(e.target.checked)} />跟随最新</label><button className="text-button" disabled={!log.length} onClick={() => setLog([])}>清空</button></div></div><div className="logs" role="log" aria-label="运行记录" aria-live="polite">{visibleLogs.length ? visibleLogs.map((line, i) => <div className={`log-line ${/失败|出错|错误/.test(line) ? "error" : ""}`} key={i}><time>{line.slice(1, line.indexOf("]"))}</time><span>{line.slice(line.indexOf("]") + 1).trim()}</span></div>) : <div className="empty-state"><strong>{logFilter === "error" ? "暂无错误记录" : "一切就绪，等待开始"}</strong><p>{logFilter === "error" ? "出现的错误会集中显示在这里。" : "启动监控或发送消息后，可在这里查看执行情况。"}</p></div>}<div ref={logEndRef} /></div></section>
        <footer className="workspace-footer"><span>{isPreview ? "示例数据" : isDesktop ? "本地 Codex" : "未连接桌面服务"}<span className="footer-divider">/</span>最近保留 30 条记录</span><div><span>{currentVersion === "预览" || currentVersion === "网页模式" ? currentVersion : `v${currentVersion}`}</span><button className="text-button" onClick={() => checkUpdate(true)} disabled={isCheckingUpdate}>{isCheckingUpdate ? "检查中…" : "检查更新"}</button></div></footer>
      </main>
    </div>
  );
}

export default App;
