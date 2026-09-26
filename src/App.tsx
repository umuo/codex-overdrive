import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

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
  const [log, setLog] = useState<string[]>([]);
  
  const [quota, setQuota] = useState<QuotaState | null>(null);
  const [timeLeftStr, setTimeLeftStr] = useState("00:00:00");
  const [timeLeftSec, setTimeLeftSec] = useState(0);


  const countdownIntervalRef = useRef<number | null>(null);

  const [searchTerm, setSearchTerm] = useState("");

  const loadSessions = async () => {
    try {
      const loaded: Session[] = await invoke("get_sessions");
      setSessions(loaded);
    } catch (e) {
      console.error(e);
      addLog(`刷新会话失败: ${e}`);
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
    try {
      const q: QuotaState = await invoke("check_quota");
      if (q.error) {
        addLog(`额度获取失败: ${q.error}`);
        return null;
      }
      setQuota(q);
      
      if (q.reset_at) {
        const now = Math.floor(Date.now() / 1000);
        const diff = q.reset_at - now;
        setTimeLeftSec(diff > 0 ? diff : 0);
      } else {
        setTimeLeftSec(0);
      }
      return q;
    } catch (e) {
      addLog(`请求额度接口出错: ${e}`);
      return null;
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
    const saved = localStorage.getItem('savedTriggerMessages');
    return saved ? JSON.parse(saved) : ["继续", "恢复目标", "请继续刚才未完成的代码"];
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
      alert("至少保留一条常用语哦！");
      return;
    }
    const newMessages = savedMessages.filter(m => m !== triggerMessage);
    setSavedMessages(newMessages);
    setTriggerMessage(newMessages[0]);
    addLog(`[消息管理] 已删除常用语: "${triggerMessage}"`);
  };

  // 记录已经触发过的回合 ID，避免在同一个回合重复发消息
  const lastTriggeredTurnRef = useRef<Record<string, string>>({});

  // Monitor loop (Smart Polling & Auto-Looping)
  useEffect(() => {
    let timeoutId: number;

    const runCheck = async () => {
      if (!isMonitoring) return;

      const q = await fetchQuota();
      let nextCheckMs = 5 * 60 * 1000;

      if (q && q.allowed) {
        // 额度充足时，进入“无人值守/自动连点”模式
        // 每隔一段较短的时间（比如 30 秒）检测一次会话是否空闲
        for (const id of Array.from(selectedSessions)) {
          try {
            const turnInfo: { turn_id: string, status: string } | null = await invoke("get_session_status", { sessionId: id });
            
            if (turnInfo) {
              // status 为 'completed' 代表 Agent 已经执行完当前回合（正在发呆/等待输入）
              // status 为 'inProgress' 代表 Agent 还在跑
              if (turnInfo.status === 'completed') {
                const lastTurn = lastTriggeredTurnRef.current[id];
                if (lastTurn !== turnInfo.turn_id) {
                  addLog(`🤖 [无人值守] 检测到会话 ${id.substring(0, 8)} 执行结束(Idle)。自动下发指令："${triggerMessage}"`);
                  const res = await invoke("trigger_via_cli", { sessionId: id, message: triggerMessage });
                  addLog(`✅ 成功: ${res}`);
                  // 记录这次触发的回合ID，只要回合不更新，就不会重复发
                  lastTriggeredTurnRef.current[id] = turnInfo.turn_id;
                }
              }
            }
          } catch (err) {
            console.error(err);
          }
        }
        
        // 额度充足且正在监控时，每 30 秒检测一次会话状态
        nextCheckMs = 30 * 1000;

      } else {
        // 额度耗尽，进入防风控等待模式
        const minMins = 5;
        const maxMins = 20;

        if (q && q.reset_at) {
          const now = Math.floor(Date.now() / 1000);
          const diff = q.reset_at - now;
          
          if (diff > 300) {
            const actualMaxMins = Math.min(maxMins, Math.ceil(diff / 60));
            const randomMins = Math.floor(Math.random() * (actualMaxMins - minMins + 1)) + minMins;
            nextCheckMs = randomMins * 60 * 1000;
            addLog(`⏳ [等待额度] 下一次额度探测将在 ${randomMins} 分钟后进行...`);
          } else if (diff > 0) {
            nextCheckMs = Math.floor(Math.random() * 60 + 30) * 1000;
          } else {
            nextCheckMs = Math.floor(Math.random() * 120 + 60) * 1000;
          }
        } else {
          const randomMins = Math.floor(Math.random() * (maxMins - minMins + 1)) + minMins;
          nextCheckMs = randomMins * 60 * 1000;
        }
      }

      timeoutId = window.setTimeout(runCheck, nextCheckMs);
    };

    if (isMonitoring) {
      runCheck();
    }

    return () => {
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [isMonitoring, selectedSessions, triggerMessage]);

  const triggerAllSelected = async () => {
    for (const id of Array.from(selectedSessions)) {
      try {
        addLog(`正在触发会话 ${id.substring(0, 8)}，消息："${triggerMessage}"`);
        const res = await invoke("trigger_via_cli", { sessionId: id, message: triggerMessage });
        addLog(`成功: ${res}`);
      } catch (err) {
        addLog(`触发失败: ${err}`);
      }
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
    if (isMonitoring) {
      setIsMonitoring(false);
      try {
        await invoke("stop_caffeinate");
      } catch(e) {}
      addLog("监控已停止。已允许系统息屏休眠。");
    } else {
      if (selectedSessions.size === 0) {
        alert("请先在左侧选择至少一个需要监控的会话！");
        return;
      }
      setIsMonitoring(true);
      try {
        await invoke("start_caffeinate");
        addLog(`开始监控，已选中 ${selectedSessions.size} 个会话。caffeinate 已启动，保持 Mac 唤醒...`);
      } catch(e) {
        addLog(`防息屏启动失败: ${e}`);
      }
      
      const q = await fetchQuota();
      if (q && q.allowed) {
        addLog("当前额度充足，立即触发任务！");
        await triggerAllSelected();
      }
    }
  };

  const percentage = quota ? quota.used_percent.toFixed(1) : 0;
  const strokeColor = quota && quota.used_percent >= 100 ? "#ff5252" : "#8ab4f8";

  const filteredSessions = sessions.filter(s => 
    (s.thread_name || "未命名会话").toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="app-container">
      <div className="sidebar">
        <div className="sidebar-header">
          <h2>Codex 会话</h2>
          <button className="btn-refresh" onClick={loadSessions} title="刷新列表">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10"></polyline>
              <polyline points="1 20 1 14 7 14"></polyline>
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
            </svg>
          </button>
        </div>
        <div className="search-bar">
          <input 
            type="text" 
            placeholder="搜索会话..." 
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
        <div className="session-list">
          {filteredSessions.map(s => (
            <div 
              key={s.id} 
              className={`session-item ${selectedSessions.has(s.id) ? 'selected' : ''}`}
              onClick={() => toggleSession(s.id)}
            >
              <input 
                type="checkbox" 
                checked={selectedSessions.has(s.id)} 
                readOnly
              />
              <div className="session-info">
                <div className="session-name-row">
                  <span className="session-name-text" title={s.thread_name || '未命名会话'}>
                    {s.thread_name || '未命名会话'}
                  </span>
                  {s.is_goal_limited && <span className="goal-badge">受限目标</span>}
                </div>
                <span className="session-date">{new Date(s.updated_at).toLocaleString()}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="main-panel">
        <h1 className="title">额度监控与自动触发</h1>
        
        <div className="quota-dashboard">
          <div className="quota-ring">
            <svg viewBox="0 0 36 36" className="circular-chart">
              <path className="circle-bg"
                d="M18 2.0845
                  a 15.9155 15.9155 0 0 1 0 31.831
                  a 15.9155 15.9155 0 0 1 0 -31.831"
              />
              <path className="circle"
                strokeDasharray={`${percentage}, 100`}
                stroke={strokeColor}
                d="M18 2.0845
                  a 15.9155 15.9155 0 0 1 0 31.831
                  a 15.9155 15.9155 0 0 1 0 -31.831"
              />
              <text x="18" y="20.35" className="percentage">{percentage}%</text>
            </svg>
          </div>
          <div className="countdown">
            <p className="countdown-label">距离额度重置还剩</p>
            <p className="countdown-time" style={{color: strokeColor}}>{timeLeftStr}</p>
          </div>
        </div>

        <div className="controls">
          <div className="settings-group message-manager">
            <label>触发消息：</label>
            <div className="message-inputs">
              <select 
                className="message-select"
                value={savedMessages.includes(triggerMessage) ? triggerMessage : "custom"}
                onChange={e => {
                  if (e.target.value !== "custom") {
                    setTriggerMessage(e.target.value);
                  }
                }}
              >
                <option value="custom" disabled>-- 选择常用语或手动修改 --</option>
                {savedMessages.map((m, idx) => (
                  <option key={idx} value={m}>{m}</option>
                ))}
              </select>

              <div className="message-actions">
                <input 
                  type="text" 
                  className="message-input"
                  value={triggerMessage} 
                  onChange={e => setTriggerMessage(e.target.value)} 
                />
                <button 
                  className="btn-icon" 
                  onClick={handleSaveMessage} 
                  disabled={savedMessages.includes(triggerMessage) || !triggerMessage.trim()}
                  title="保存为常用语"
                >💾</button>
                <button 
                  className="btn-icon" 
                  onClick={handleDeleteMessage} 
                  disabled={!savedMessages.includes(triggerMessage)}
                  title="删除当前常用语"
                >🗑️</button>
              </div>
            </div>
          </div>
          
          <button 
            className={`btn-monitor ${isMonitoring ? 'active' : ''}`} 
            onClick={handleMonitorToggle}
          >
            {isMonitoring ? '停止监控' : '启动监控'}
          </button>
          
          <button className="btn-test" onClick={triggerAllSelected}>
            手动测试触发 (IPC)
          </button>

          <button className="btn-test" onClick={async () => {
            if (selectedSessions.size === 0) {
              alert("请选择一个会话进行测试！");
              return;
            }
            for (const id of Array.from(selectedSessions)) {
              try {
                addLog(`正在通过底层 CLI 工具直接发送信号...`);
                const res = await invoke("trigger_via_cli", { sessionId: id, message: triggerMessage });
                addLog(`成功: ${res}`);
              } catch (err) {
                addLog(`CLI 触发失败: ${err}`);
              }
            }
          }}>
            完美测试触发 (后台 CLI)
          </button>
        </div>

        <div className="log-console">
          <h3>运行日志</h3>
          <div className="logs">
            {log.map((l, i) => <div key={i} className="log-line">{l}</div>)}
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
