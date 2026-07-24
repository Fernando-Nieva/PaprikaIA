import { useState, useRef, useEffect, useCallback } from 'react'

const API = `http://${window.location.hostname}:3001/api`

export default function Chat() {
  const [conversations, setConversations] = useState([])
  const [activeConv, setActiveConv] = useState(null)
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const messagesEndRef = useRef(null)
  const consoleEndRef = useRef(null)

  const [userInfo, setUserInfo] = useState(null)
  const [processLog, setProcessLog] = useState([])
  const [toolStatus, setToolStatus] = useState(null)

  useEffect(() => {
    fetchConversations()
  }, [])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    consoleEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [processLog])

  const fetchUserInfo = useCallback(async () => {
    try {
      const res = await fetch(`${API}/user/default/info`)
      const data = await res.json()
      setUserInfo(data)
    } catch {}
  }, [])

  useEffect(() => {
    fetchUserInfo()
  }, [fetchUserInfo, messages])

  async function fetchConversations() {
    const res = await fetch(`${API}/conversations`)
    const data = await res.json()
    setConversations(data)
  }

  async function createConversation() {
    const res = await fetch(`${API}/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Nueva conversación' })
    })
    const conv = await res.json()
    setConversations(prev => [conv, ...prev])
    setActiveConv(conv)
    setMessages([])
    setSidebarOpen(false)
  }

  async function selectConversation(conv) {
    setActiveConv(conv)
    const res = await fetch(`${API}/conversations/${conv.id}/messages`)
    const msgs = await res.json()
    setMessages(msgs.map(m => ({ role: m.role, content: m.content })))
    setSidebarOpen(false)
  }

  async function deleteConversation(id, e) {
    e.stopPropagation()
    await fetch(`${API}/conversations/${id}`, { method: 'DELETE' })
    setConversations(prev => prev.filter(c => c.id !== id))
    if (activeConv?.id === id) {
      setActiveConv(null)
      setMessages([])
    }
  }

  async function sendMessage() {
    if (!input.trim() || loading) return

    let conv = activeConv
    if (!conv) {
      const res = await fetch(`${API}/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: input.substring(0, 40) })
      })
      conv = await res.json()
      setActiveConv(conv)
      setConversations(prev => [conv, ...prev])
    }

    const userMsg = { role: 'user', content: input }
    setMessages(prev => [...prev, userMsg])
    setInput('')
    setLoading(true)
    setProcessLog([])

    try {
      const res = await fetch(`${API}/conversations/${conv.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: userMsg.content })
      })

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let assistantMsg = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const text = decoder.decode(value)
        const lines = text.split('\n').filter(l => l.startsWith('data: '))

        for (const line of lines) {
          const data = JSON.parse(line.slice(6))

          if (data.type === 'process') {
            setProcessLog(prev => [...prev, { step: data.step, detail: data.detail, ts: data.ts }])
          }

          if (data.type === 'text') {
            assistantMsg += data.content
            setMessages(prev => {
              const msgs = [...prev]
              const last = msgs[msgs.length - 1]
              if (last?.role === 'assistant') {
                last.content = assistantMsg
              } else {
                msgs.push({ role: 'assistant', content: assistantMsg })
              }
              return [...msgs]
            })
          }

          if (data.type === 'tool') {
            setToolStatus(data.content.trim())
          }
        }
      }

      fetchConversations()
      fetchUserInfo()
    } catch (err) {
      console.error(err)
    }

    setLoading(false)
    setTimeout(() => setToolStatus(null), 2000)
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  const memoryCategories = userInfo?.memories ? groupByCategory(userInfo.memories) : {}
  const emotions = userInfo?.emotions || {}
  const relationship = userInfo?.relationship || {}

  return (
    <div className="app">
      <div className={`sidebar-overlay ${sidebarOpen ? 'visible' : ''}`} onClick={() => setSidebarOpen(false)} />

      {/* Sidebar izquierdo: conversaciones */}
      <div className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="sidebar-header">
          <h2>Paprika</h2>
          <p>Asistente IA personal</p>
        </div>
        <button className="new-chat-btn" onClick={createConversation}>
          + Nueva conversación
        </button>
        <div className="conversations-list">
          {conversations.map(conv => (
            <div
              key={conv.id}
              className={`conversation-item ${activeConv?.id === conv.id ? 'active' : ''}`}
              onClick={() => selectConversation(conv)}
            >
              <span>{conv.title}</span>
              <button className="delete-btn" onClick={(e) => deleteConversation(conv.id, e)}>
                ×
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Panel izquierdo: info que Paprika guarda */}
      <div className="info-panel">
        <div className="info-panel-header">
          <h3>Lo que Paprika sabe</h3>
        </div>
        <div className="info-panel-body">

          {userInfo?.stats && (
            <div className="info-section">
              <div className="stats-grid">
                <div className="stat"><span className="stat-num">{userInfo.stats.totalMemories}</span><span className="stat-label">Recuerdos</span></div>
                <div className="stat"><span className="stat-num">{userInfo.stats.personalData}</span><span className="stat-label">Personales</span></div>
                <div className="stat"><span className="stat-num">{userInfo.stats.preferences}</span><span className="stat-label">Preferencias</span></div>
                <div className="stat"><span className="stat-num">{userInfo.stats.experiences}</span><span className="stat-label">Experiencias</span></div>
              </div>
            </div>
          )}

          {relationship.trust !== undefined && (
            <div className="info-section">
              <h4>Relación</h4>
              <div className="bar-row"><span>Confianza</span><div className="bar"><div className="bar-fill trust" style={{ width: `${(relationship.trust || 0) * 100}%` }} /></div></div>
              <div className="bar-row"><span>Familiaridad</span><div className="bar"><div className="bar-fill trust" style={{ width: `${(relationship.familiarity || 0) * 100}%` }} /></div></div>
              <div className="bar-row"><span>Formalidad</span><div className="bar"><div className="bar-fill" style={{ width: `${(relationship.formality || 0) * 100}%` }} /></div></div>
              <p className="info-detail">Conversaciones: {relationship.conversationCount || 0}</p>
              {relationship.description && <p className="info-desc">{relationship.description}</p>}
            </div>
          )}

          {Object.keys(emotions).length > 0 && (
            <div className="info-section">
              <h4>Emociones</h4>
              {Object.entries(emotions).filter(([,v]) => typeof v === 'number').sort((a, b) => b[1] - a[1]).slice(0, 5).map(([key, val]) => (
                <div key={key} className="bar-row"><span>{key}</span><div className="bar"><div className="bar-fill emotion" style={{ width: `${val * 100}%` }} /></div></div>
              ))}
            </div>
          )}

          {Object.entries(memoryCategories).map(([cat, mems]) => (
            <div key={cat} className="info-section">
              <h4>{categoryLabel(cat)} ({mems.length})</h4>
              {mems.slice(0, 4).map((m, i) => (
                <div key={i} className="mem-item">{m.content}</div>
              ))}
              {mems.length > 4 && <p className="info-more">+{mems.length - 4} más</p>}
            </div>
          ))}

          {userInfo?.knowledge?.length > 0 && (
            <div className="info-section">
              <h4>Conocimiento ({userInfo.knowledge.length})</h4>
              {userInfo.knowledge.slice(0, 6).map((e, i) => (
                <div key={i} className="mem-item">{e.name} <span className="mem-tag">[{e.type}]</span></div>
              ))}
            </div>
          )}

          {userInfo?.goals?.length > 0 && (
            <div className="info-section">
              <h4>Objetivos ({userInfo.goals.length})</h4>
              {userInfo.goals.map((g, i) => (
                <div key={i} className="mem-item">{g.content} ({Math.round((g.progress || 0) * 100)}%)</div>
              ))}
            </div>
          )}

        </div>
      </div>

      {/* Zona central: chat + consola abajo */}
      <div className="main">
        <button className="menu-btn" onClick={() => setSidebarOpen(!sidebarOpen)}>
          ☰
        </button>

        {/* Tool status overlay — top-left */}
        {toolStatus && (
          <div className="tool-status-overlay">
            {toolStatus}
          </div>
        )}

        {/* Chat arriba */}
        <div className="chat-area">
          {!activeConv ? (
            <div className="welcome-screen">
              <h1>Paprika</h1>
              <p>Tu asistente IA personal</p>
              <div className="tools-info">
                <span className="tool-badge">📄 Leer archivos</span>
                <span className="tool-badge">✏️ Escribir código</span>
                <span className="tool-badge">💻 Terminal</span>
              </div>
            </div>
          ) : (
            <div className="messages-container">
              {messages.filter(m => m.role !== 'tool').map((msg, i) => (
                <div key={i} className={`message ${msg.role}`}>
                  <div className="message-role">
                    {msg.role === 'user' ? 'Tú' : 'Paprika'}
                  </div>
                  {msg.content}
                </div>
              ))}
              {loading && messages[messages.length - 1]?.role !== 'assistant' && (
                <div className="message assistant">
                  <div className="message-role">Paprika</div>
                  Pensando...
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Consola de procesos abajo */}
        <div className="process-console">
          <div className="console-header">
            <span className="console-title">⚙️ Pipeline</span>
            {loading && <span className="console-spinner" />}
          </div>
          <div className="console-body">
            {processLog.map((log, i) => (
              <div key={i} className="console-line">
                <span className="console-step">{log.step}</span>
                <span className="console-detail">{log.detail}</span>
              </div>
            ))}
            {processLog.length === 0 && (
              <div className="console-empty">Esperando mensaje...</div>
            )}
            <div ref={consoleEndRef} />
          </div>
        </div>

        {/* Input abajo del todo */}
        <div className="input-container">
          <div className="input-wrapper">
            <textarea
              className="chat-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Escribe un mensaje..."
              rows={1}
            />
            <button
              className="send-btn"
              onClick={sendMessage}
              disabled={loading || !input.trim()}
            >
              {loading ? '...' : 'Enviar'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function groupByCategory(memories) {
  const groups = {}
  for (const m of memories) {
    const cat = m.category || 'other'
    if (!groups[cat]) groups[cat] = []
    groups[cat].push(m)
  }
  return groups
}

function categoryLabel(cat) {
  const labels = {
    personal_data: 'Datos Personales',
    preference: 'Preferencias',
    experience: 'Experiencias',
    person: 'Personas',
    relationship: 'Relaciones',
    project: 'Proyectos',
    goal: 'Objetivos',
    event: 'Eventos',
    date: 'Fechas',
  }
  return labels[cat] || cat
}
