import { useState, useRef, useEffect } from 'react'

const API = `http://${window.location.hostname}:3001/api`

export default function Chat() {
  const [conversations, setConversations] = useState([])
  const [activeConv, setActiveConv] = useState(null)
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const messagesEndRef = useRef(null)

  useEffect(() => {
    fetchConversations()
  }, [])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

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

    try {
      const res = await fetch(`${API}/conversations/${conv.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: userMsg.content })
      })

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let assistantMsg = ''
      let toolMsg = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const text = decoder.decode(value)
        const lines = text.split('\n').filter(l => l.startsWith('data: '))

        for (const line of lines) {
          const data = JSON.parse(line.slice(6))

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
            toolMsg += data.content
            setMessages(prev => {
              const msgs = [...prev]
              const last = msgs[msgs.length - 1]
              if (last?.role === 'tool') {
                last.content = toolMsg
              } else {
                msgs.push({ role: 'tool', content: toolMsg })
              }
              return [...msgs]
            })
          }
        }
      }

      fetchConversations()
    } catch (err) {
      console.error(err)
    }

    setLoading(false)
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  return (
    <div className="app">
      <div className={`sidebar-overlay ${sidebarOpen ? 'visible' : ''}`} onClick={() => setSidebarOpen(false)} />

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

      <div className="main">
        <button className="menu-btn" onClick={() => setSidebarOpen(!sidebarOpen)}>
          ☰
        </button>

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
            {messages.map((msg, i) => (
              <div key={i} className={`message ${msg.role}`}>
                <div className="message-role">
                  {msg.role === 'user' ? 'Tú' : msg.role === 'tool' ? '🔧 Herramienta' : 'Paprika'}
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
