import { useState, useRef, useEffect, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import useFileUpload from '../hooks/useFileUpload'
import { AttachmentRenderer } from './rich'

const API = `http://${window.location.hostname}:3001/api`

function extractYouTubeId(url) {
  if (!url) return null
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
    /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/v\/)([a-zA-Z0-9_-]{11})/,
  ]
  for (const p of patterns) {
    const m = url.match(p)
    if (m) return m[1]
  }
  return null
}

function MarkdownRenderer({ content }) {
  return (
    <ReactMarkdown
      components={{
        a: ({ href, children }) => {
          const ytId = extractYouTubeId(href)
          if (ytId) {
            return (
              <span className="youtube-preview">
                <a href={href} target="_blank" rel="noopener noreferrer" className="youtube-link">
                  <img
                    src={`https://img.youtube.com/vi/${ytId}/mqdefault.jpg`}
                    alt={typeof children === 'string' ? children : 'Video'}
                    className="youtube-thumbnail"
                    loading="lazy"
                  />
                  <span className="youtube-play">&#9654;</span>
                </a>
                <a href={href} target="_blank" rel="noopener noreferrer" className="youtube-title">
                  {children}
                </a>
              </span>
            )
          }
          return (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          )
        },
      }}
    >
      {content}
    </ReactMarkdown>
  )
}

export default function Chat() {
  const [conversations, setConversations] = useState([])
  const [activeConv, setActiveConv] = useState(null)
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const messagesEndRef = useRef(null)
  const consoleEndRef = useRef(null)
  const inputWrapperRef = useRef(null)
  const [dragOver, setDragOver] = useState(false)

  const [userInfo, setUserInfo] = useState(null)
  const [processLog, setProcessLog] = useState([])
  const [toolStatus, setToolStatus] = useState(null)

  const [expandedImage, setExpandedImage] = useState(null)

  const fileUpload = useFileUpload()

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
    setMessages(msgs.map(m => ({
      role: m.role,
      content: m.content,
      attachments: m.attachments || undefined,
    })))
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
    if ((!input.trim() && !fileUpload.hasAttachments) || loading) return

    let conv = activeConv
    if (!conv) {
      const res = await fetch(`${API}/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: input.substring(0, 40) || 'Mensaje con archivo' })
      })
      conv = await res.json()
      setActiveConv(conv)
      setConversations(prev => [conv, ...prev])
    }

    let attachments = undefined
    if (fileUpload.hasAttachments) {
      attachments = await fileUpload.prepareAttachments()
    }

    const userMsg = {
      role: 'user',
      content: input,
      attachments: attachments?.length > 0 ? attachments : undefined,
    }
    setMessages(prev => [...prev, userMsg])
    const sentInput = input
    setInput('')
    setLoading(true)
    setProcessLog([])
    fileUpload.clearPreviews()

    try {
      const body = { content: sentInput }
      if (attachments?.length > 0) {
        body.attachments = attachments
      }

      const res = await fetch(`${API}/conversations/${conv.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let assistantMsg = ''
      let assistantAttachments = []

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
                if (assistantAttachments.length > 0) last.attachments = assistantAttachments
              } else {
                msgs.push({
                  role: 'assistant',
                  content: assistantMsg,
                  attachments: assistantAttachments.length > 0 ? [...assistantAttachments] : undefined,
                })
              }
              return [...msgs]
            })
          }

          if (data.type === 'attachments') {
            assistantAttachments = assistantAttachments.concat(data.data || [])
            // Update the assistant message with attachments
            setMessages(prev => {
              const msgs = [...prev]
              const last = msgs[msgs.length - 1]
              if (last?.role === 'assistant') {
                last.attachments = [...assistantAttachments]
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

  function handleWrapperDrop(e) {
    fileUpload.handleDrop(e)
    setDragOver(false)
  }

  function handleWrapperDragOver(e) {
    e.preventDefault()
    setDragOver(true)
  }

  function handleWrapperDragLeave(e) {
    if (!inputWrapperRef.current?.contains(e.relatedTarget)) {
      setDragOver(false)
    }
  }

  function handleWrapperPaste(e) {
    if (!e.clipboardData?.items?.length) return
    const hasFiles = Array.from(e.clipboardData.items).some(i => i.kind === 'file')
    if (hasFiles) {
      fileUpload.handlePaste(e)
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
                <span className="tool-badge">🖼️ Imágenes</span>
                <span className="tool-badge">🎤 Audio</span>
              </div>
            </div>
          ) : (
            <div className="messages-container">
              {messages.filter(m => m.role !== 'tool').map((msg, i) => (
                <div key={i} className={`message ${msg.role}`}>
                  <div className="message-role">
                    {msg.role === 'user' ? 'Tú' : 'Paprika'}
                  </div>
                  {msg.attachments && msg.attachments.length > 0 && (
                    <MessageAttachments attachments={msg.attachments} onImageClick={setExpandedImage} />
                  )}
                  {msg.role === 'assistant' ? (
                    <MarkdownRenderer content={msg.content} />
                  ) : (
                    msg.content
                  )}
                  {msg.role === 'assistant' && msg.attachments && msg.attachments.length > 0 && (
                    <AttachmentRenderer attachments={msg.attachments} />
                  )}
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
          <div
            ref={inputWrapperRef}
            className={`input-wrapper ${dragOver ? 'drag-over' : ''}`}
            onDrop={handleWrapperDrop}
            onDragOver={handleWrapperDragOver}
            onDragLeave={handleWrapperDragLeave}
            onPaste={handleWrapperPaste}
          >
            <input
              ref={fileUpload.fileInputRef}
              type="file"
              className="file-input-hidden"
              accept="image/jpeg,image/png,image/gif,image/webp,audio/mpeg,audio/wav,audio/ogg,audio/webm,audio/mp4"
              multiple
              onChange={fileUpload.handleFileInputChange}
            />
            <button
              className="attach-btn"
              onClick={fileUpload.triggerFileInput}
              disabled={loading}
              title="Adjuntar archivo"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
              </svg>
            </button>
            <div className="input-text-area">
              <textarea
                className="chat-input"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={dragOver ? "Soltar archivos aquí..." : "Escribe un mensaje..."}
                rows={1}
              />
            </div>
            <button
              className="send-btn"
              onClick={sendMessage}
              disabled={loading || (!input.trim() && !fileUpload.hasAttachments)}
            >
              {loading ? '...' : 'Enviar'}
            </button>
          </div>

          {fileUpload.hasAttachments && (
            <div className="attachments-preview-bar">
              {fileUpload.previews.map(preview => (
                <div key={preview.id} className="attachment-thumb">
                  {preview.type.startsWith('image/') ? (
                    <img src={preview.url} alt={preview.name} className="attachment-thumb-img" />
                  ) : (
                    <div className="attachment-thumb-audio">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M9 18V5l12-2v13" />
                        <circle cx="6" cy="18" r="3" />
                        <circle cx="18" cy="16" r="3" />
                      </svg>
                    </div>
                  )}
                  <span className="attachment-thumb-name" title={preview.name}>
                    {preview.name.length > 12 ? preview.name.substring(0, 10) + '...' : preview.name}
                  </span>
                  <button
                    className="attachment-thumb-remove"
                    onClick={() => fileUpload.removePreview(preview.id)}
                    title="Eliminar"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Image expansion modal */}
      {expandedImage && (
        <div className="image-modal-overlay" onClick={() => setExpandedImage(null)}>
          <div className="image-modal" onClick={e => e.stopPropagation()}>
            <button className="image-modal-close" onClick={() => setExpandedImage(null)}>×</button>
            <img src={expandedImage} alt="Expandida" className="image-modal-img" />
          </div>
        </div>
      )}
    </div>
  )
}

function MessageAttachments({ attachments, onImageClick }) {
  return (
    <div className="message-attachments">
      {attachments.map((att, i) => {
        if (att.mimeType?.startsWith('image/') && att.base64) {
          const src = `data:${att.mimeType};base64,${att.base64}`
          return (
            <div key={i} className="msg-attachment msg-attachment-image" onClick={() => onImageClick(src)}>
              <img src={src} alt={att.filename || 'Imagen'} />
            </div>
          )
        }
        if (att.mimeType?.startsWith('audio/') && att.base64) {
          const src = `data:${att.mimeType};base64,${att.base64}`
          return (
            <div key={i} className="msg-attachment msg-attachment-audio">
              <audio controls src={src} className="msg-audio-player" />
              <span className="msg-audio-filename">{att.filename}</span>
            </div>
          )
        }
        return null
      })}
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
